-- Retell deliveries and dashboard repairs can race. Merge while PostgreSQL holds
-- the row lock acquired by INSERT ... ON CONFLICT, never with a read/write check.
alter table public.calls
  add column lifecycle_rank smallint not null default 0 check (lifecycle_rank between 0 and 3),
  add column media_redacted boolean not null default false;

-- Preserve the strongest evidence already stored on historical calls.
update public.calls set lifecycle_rank = case
  when summary is not null or user_sentiment is not null or call_successful is not null then 3
  when call_status in ('ended','error','not_connected') or ended_at is not null then 2
  when call_status = 'ongoing' then 1 else 0 end;

create function public.protect_recepta_call_lifecycle() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_incoming_rank smallint;
begin
  if tg_op = 'UPDATE' and old.retell_call_id is not null and
    (new.client_id is distinct from old.client_id or new.retell_call_id is distinct from old.retell_call_id) then
    raise exception 'A Retell call cannot be reassigned to another client or call ID';
  end if;
  if new.retell_call_id is null then return new; end if;

  -- Infer a minimum rank too, so older writers cannot bypass the status guard.
  v_incoming_rank := case
    when new.call_status = 'registered' then 0
    when new.call_status = 'ongoing' then 1
    else greatest(new.lifecycle_rank, case
      when new.lifecycle_rank = 0 and (new.summary is not null or new.user_sentiment is not null or new.call_successful is not null) then 3
      when new.call_status in ('ended','error','not_connected') or new.ended_at is not null then 2
      else 0 end) end;

  if tg_op = 'UPDATE' then
    if v_incoming_rank < old.lifecycle_rank then
      new.call_status := old.call_status;
      new.outcome := coalesce(old.outcome,new.outcome);
      new.appointment_booked := old.appointment_booked;
      new.caller_name := coalesce(old.caller_name,new.caller_name);
      new.caller_number := coalesce(old.caller_number,new.caller_number);
      new.disconnection_reason := coalesce(old.disconnection_reason,new.disconnection_reason);
      new.summary := coalesce(old.summary,new.summary);
      new.user_sentiment := coalesce(old.user_sentiment,new.user_sentiment);
      new.call_successful := coalesce(old.call_successful,new.call_successful);
    else
      new.caller_name := coalesce(new.caller_name,old.caller_name);
      new.caller_number := coalesce(new.caller_number,old.caller_number);
      new.disconnection_reason := coalesce(new.disconnection_reason,old.disconnection_reason);
      new.summary := coalesce(new.summary,old.summary);
      new.user_sentiment := coalesce(new.user_sentiment,old.user_sentiment);
      new.call_successful := coalesce(new.call_successful,old.call_successful);
      new.outcome := coalesce(new.outcome,old.outcome);
    end if;

    -- Terminal calls and connected calls never return to an earlier state, even
    -- when an old writer omits lifecycle_rank and inherits the stored value.
    if old.call_status in ('ended','error','not_connected') then
      new.call_status := old.call_status;
    elsif old.call_status = 'ongoing' and new.call_status = 'registered' then
      new.call_status := old.call_status;
    end if;
    new.lifecycle_rank := greatest(old.lifecycle_rank,v_incoming_rank);
    new.duration_seconds := greatest(old.duration_seconds,new.duration_seconds,0);
    new.started_at := least(old.started_at,new.started_at);
    new.ended_at := greatest(old.ended_at,new.ended_at);
    new.retell_agent_id := coalesce(old.retell_agent_id,new.retell_agent_id);
    new.owner_notification_requested := old.owner_notification_requested or new.owner_notification_requested;
    new.updated_at := greatest(old.updated_at,new.updated_at);

    -- Null/missing media on a sparse replay cannot erase known media. Enabling
    -- redaction is the exception: discard raw data even if scrubbed data is absent.
    if old.media_redacted and not new.media_redacted then
      new.transcript := old.transcript;
      new.recording_url := old.recording_url;
    elsif new.media_redacted and not old.media_redacted then
      null; -- Keep only the incoming scrubbed values, including null.
    elsif v_incoming_rank < old.lifecycle_rank then
      new.transcript := coalesce(old.transcript,new.transcript);
      new.recording_url := coalesce(old.recording_url,new.recording_url);
    else
      new.transcript := coalesce(new.transcript,old.transcript);
      new.recording_url := coalesce(new.recording_url,old.recording_url);
    end if;
    new.media_redacted := old.media_redacted or new.media_redacted;
  else
    new.lifecycle_rank := v_incoming_rank;
  end if;

  if new.lifecycle_rank >= 2 then
    if new.call_status is null or new.call_status not in ('ended','error','not_connected') then
      new.call_status := 'ended';
    end if;
    if new.call_successful is not null then
      new.outcome := case when new.call_successful then 'Successful' else 'Unsuccessful' end;
    elsif new.outcome is null or new.outcome = 'In progress' then
      new.outcome := coalesce(new.disconnection_reason,'Completed');
    end if;
  end if;
  return new;
end; $$;
create trigger protect_recepta_call_lifecycle before insert or update on public.calls
  for each row execute function public.protect_recepta_call_lifecycle();

-- Repair historical regressions only where stored completion/analysis proves
-- the call finished. Calls with no such evidence stay in their existing state.
update public.calls set call_status='ended'
  where lifecycle_rank >= 2 and (call_status is null or call_status in ('registered','ongoing'));

revoke all on function public.protect_recepta_call_lifecycle() from public,anon,authenticated;
grant execute on function public.protect_recepta_call_lifecycle() to service_role;
