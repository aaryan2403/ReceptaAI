-- Reuse the existing tenant lock, scheduling engine, versioned ledger and mail queue.
-- These functions accept identity only from the server after Retell signature verification.
create function public.recepta_caller_appointment(
  p_client uuid, p_agent text, p_call text, p_phone text, p_ref uuid,
  p_action text, p_version integer default null, p_date date default null,
  p_time time default null, p_confirmed boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  a public.appointments; s public.booking_settings; access jsonb;
  denied jsonb := '{"success":false,"reason":"verification_failed"}';
  result jsonb; matches timestamptz[]; target timestamptz; stored text;
  alternatives jsonb := '[]'; candidate jsonb; day_offset integer;
begin
  if p_action is null or p_action not in ('find','reschedule','cancel')
    or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or nullif(p_agent,'') is null or nullif(p_call,'') is null or p_ref is null then
    return denied;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client::text,12738));
  perform 1 from public.clients where id=p_client for share;
  perform 1 from public.subscriptions where client_id=p_client for share;
  access := public.recepta_service_access(p_client,p_agent);
  if access->>'plan' is distinct from 'Recepta Pro'
    or (access->>'assignment_valid')::boolean is distinct from true
    or (access->>'appointments')::boolean is distinct from true
    or not exists (select 1 from public.call_minute_reservations r
      where r.client_id=p_client and r.retell_agent_id=p_agent and r.retell_call_id=p_call
        and r.status='active' and r.reserved_seconds>0 and r.period_end>clock_timestamp()
        and r.created_at+make_interval(secs=>r.reserved_seconds)>clock_timestamp()) then
    return '{"success":false,"reason":"service_unavailable"}';
  end if;
  select * into a from public.appointments where client_id=p_client and id=p_ref for update;
  if not found then return denied; end if;
  stored := regexp_replace(coalesce(a.customer_phone,''),'[^0-9+]','','g');
  if stored ~ '^[0-9]{10}$' then stored := '+1'||stored;
  elsif stored ~ '^1[0-9]{10}$' then stored := '+'||stored; end if;
  if stored is distinct from p_phone then return denied; end if;
  if p_action='find' then
    if a.status<>'booked' or a.appointment_time is null or a.appointment_time<=clock_timestamp() then return denied; end if;
    return jsonb_build_object('success',true,'status','booked','appointment_id',a.id,
      'booking_version',a.booking_version,'start',public.recepta_schedule_stamp(a.appointment_time,coalesce(a.booking_time_zone,'UTC')),
      'time_zone',coalesce(a.booking_time_zone,'UTC'),'duration_minutes',a.duration_minutes);
  end if;
  if p_version is null then return denied; end if;
  if p_action='cancel' then
    if p_confirmed is distinct from true then return '{"success":false,"reason":"confirmation_required"}'; end if;
    if a.status='cancelled' and a.booking_version=p_version+1 then
      return jsonb_build_object('success',true,'status','cancelled','appointment_id',a.id,'booking_version',a.booking_version,'already_applied',true);
    end if;
  else
    if p_date is null or p_time is null then return '{"success":false,"reason":"invalid_local_date_or_time"}'; end if;
    select * into s from public.booking_settings where client_id=p_client;
    if not found or not s.enabled then return '{"success":false,"reason":"automatic_booking_disabled"}'; end if;
    if p_date>(clock_timestamp() at time zone s.time_zone)::date+366 then
      return '{"success":false,"reason":"outside_booking_horizon","alternatives":[]}';
    end if;
    select array_agg(t order by t) into matches from public.recepta_wall_time(p_date+p_time,s.time_zone) t;
    if coalesce(cardinality(matches),0)<>1 then
      return jsonb_build_object('success',false,'reason',case when cardinality(matches)>1 then 'ambiguous_local_time' else 'nonexistent_local_time' end,'alternatives','[]'::jsonb);
    end if;
    target:=matches[1];
    if a.status='booked' and a.booking_version=p_version+1 and a.appointment_time=target then
      return jsonb_build_object('success',true,'status','booked','appointment_id',a.id,'booking_version',a.booking_version,
        'start',public.recepta_schedule_stamp(a.appointment_time,coalesce(a.booking_time_zone,'UTC')),
        'time_zone',coalesce(a.booking_time_zone,'UTC'),'already_applied',true);
    end if;
  end if;
  if a.booking_version is distinct from p_version then return '{"success":false,"reason":"appointment_changed"}'; end if;
  if a.status<>'booked' or a.appointment_time is null or a.appointment_time<=clock_timestamp() then
    return '{"success":false,"reason":"appointment_not_eligible"}';
  end if;
  -- The existing RPC performs the authoritative capacity recheck and update under the same advisory lock.
  result:=public.recepta_change_appointment(p_client,p_action,target,a.id,p_version);
  if (result->>'success')::boolean is true then
    select * into a from public.appointments where client_id=p_client and id=p_ref;
    if p_action='cancel' then perform public.recepta_queue_appointment_email(a); end if;
    return result||jsonb_build_object('booking_version',a.booking_version);
  end if;
  if p_action='reschedule' then
    -- Reuse the existing availability engine in appointment-aware mode (excludes this booking).
    for day_offset in 0..7 loop
      exit when jsonb_array_length(alternatives)>=3;
      if p_date+day_offset>(clock_timestamp() at time zone s.time_zone)::date+366 then exit; end if;
      for candidate in select value from jsonb_array_elements(coalesce(
        public.recepta_scheduling_availability(p_client,p_date+day_offset,null,null,false,a.id)->'slots','[]'::jsonb))
      loop
        exit when jsonb_array_length(alternatives)>=3;
        if (candidate->>'available')::boolean is true and (candidate->>'start')::timestamptz<>a.appointment_time
          and (day_offset>0 or (candidate->>'wall_time')::time>=p_time) then
          alternatives:=alternatives||jsonb_build_array(candidate->>'start');
        end if;
      end loop;
    end loop;
    return result||jsonb_build_object('alternatives',alternatives,'time_zone',s.time_zone);
  end if;
  return result;
end $$;
revoke all on function public.recepta_caller_appointment(uuid,text,text,text,uuid,text,integer,date,time,boolean) from public,anon,authenticated;
grant execute on function public.recepta_caller_appointment(uuid,text,text,text,uuid,text,integer,date,time,boolean) to service_role;

-- One-time managed tool synchronization for existing Pro agents. No new phone lines are created.
alter table public.booking_settings add column caller_management_synced_agent_id text;
alter table public.booking_settings add column caller_management_sync_attempted_at timestamptz;
create function public.recepta_caller_management_sync_candidates()
returns table(client_id uuid,agent_id text) language sql security invoker set search_path = '' as $$
  select b.client_id,a.retell_agent_id
  from public.booking_settings b join public.agents a on a.client_id=b.client_id
  join public.subscriptions sub on sub.client_id=b.client_id
  where sub.plan_name='Recepta Pro' and a.retell_agent_id is not null
    and b.caller_management_synced_agent_id is distinct from a.retell_agent_id
    and (b.caller_management_sync_attempted_at is null or b.caller_management_sync_attempted_at<clock_timestamp()-interval '15 minutes')
    and (public.recepta_service_access(b.client_id,a.retell_agent_id)->>'appointments')::boolean is true
  order by b.caller_management_sync_attempted_at nulls first,b.client_id limit 2;
$$;
revoke all on function public.recepta_caller_management_sync_candidates() from public,anon,authenticated;
grant execute on function public.recepta_caller_management_sync_candidates() to service_role;
