-- Recipient-specific payloads reuse the existing durable, leased email outbox.
-- No historical calls are backfilled. Existing clients keep caller receipts off.
alter table public.calls add column notification_details jsonb;

create function public.protect_recepta_call_email_details() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' and old.notification_details is not null and
    (old.lifecycle_rank=3 or new.lifecycle_rank<3) then
    new.notification_details:=old.notification_details;
  end if;
  if new.content_erased_at is not null then
    new.notification_details:=null;
    update public.call_notifications set mail_payload=null,
      status=case when status in ('queued','retrying') then 'needs_attention' else status end,
      last_error=case when status in ('queued','retrying') then 'Call content erased before email delivery; sending stopped.' else last_error end
      where client_id=new.client_id and retell_call_id=new.retell_call_id;
  end if;
  return new;
end $$;
create trigger zy_protect_call_email_details before insert or update on public.calls
for each row execute function public.protect_recepta_call_email_details();

create or replace function public.enqueue_recepta_call_notification() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_plan text; v_caller boolean; v_error text;
begin
  if not new.owner_notification_requested or new.retell_call_id is null or new.content_erased_at is not null then return new; end if;
  select plan_name into v_plan from public.subscriptions where client_id=new.client_id and status='active';
  if v_plan not in ('Recepta Standard','Recepta Pro') or v_plan is null then return new; end if;
  insert into public.call_notifications(notification_key,client_id,call_record_id,retell_call_id,plan_name)
  values ('owner-call:' || new.client_id::text || ':' || new.retell_call_id,new.client_id,new.id,new.retell_call_id,v_plan)
  on conflict(notification_key) do nothing;
  v_caller:=new.lifecycle_rank=3 and coalesce((new.notification_details->'settings'->>'callerEnabled')::boolean,false);
  if tg_op='UPDATE' then v_caller:=v_caller and old.lifecycle_rank<3; end if;
  if v_caller then
    v_error:=new.notification_details->>'callerSkipReason';
    if nullif(new.notification_details->>'callerEmail','') is null then
      v_error:=coalesce(v_error,'Caller email skipped: no confirmed recipient.');
    end if;
    insert into public.call_notifications(notification_key,client_id,call_record_id,retell_call_id,plan_name,status,last_error)
    values ('caller-call:' || new.client_id::text || ':' || new.retell_call_id,new.client_id,new.id,new.retell_call_id,v_plan,
      case when v_error is null then 'queued' else 'needs_attention' end,v_error)
    on conflict(notification_key) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.protect_recepta_call_email_details() from public,anon,authenticated;
grant execute on function public.protect_recepta_call_email_details() to service_role;
