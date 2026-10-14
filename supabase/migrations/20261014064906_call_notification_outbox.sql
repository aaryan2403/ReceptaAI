-- Call storage and email enqueue commit together. Only server-written eligibility
-- can create a notice; a provider dashboard refresh never backfills old emails.
alter table public.calls add column owner_notification_requested boolean not null default false;
create table public.call_notifications (
  notification_key text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  call_record_id uuid not null references public.calls(id) on delete cascade,
  retell_call_id text not null,
  plan_name text not null check (plan_name in ('Recepta Standard','Recepta Pro')),
  status text not null default 'queued' check (status in ('queued','retrying','accepted','needs_attention','legacy_untracked')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  first_send_at timestamptz,
  mail_payload jsonb,
  provider_message_id text,
  accepted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
alter table public.call_notifications enable row level security;
revoke all on public.call_notifications from public, anon, authenticated;
grant select, insert, update, delete on public.call_notifications to service_role;
create index call_notifications_due_idx on public.call_notifications(next_attempt_at,created_at)
  where status in ('queued','retrying');
create index call_notifications_client_idx on public.call_notifications(client_id,retell_call_id);

-- Old sends had no receipt ledger. Do not resend an unknown historical email.
insert into public.call_notifications(notification_key,client_id,call_record_id,retell_call_id,plan_name,status)
select 'owner-call:' || c.client_id::text || ':' || c.retell_call_id,
  c.client_id,c.id,c.retell_call_id,
  case when s.plan_name='Recepta Pro' then 'Recepta Pro' else 'Recepta Standard' end,
  'legacy_untracked'
from public.calls c left join public.subscriptions s on s.client_id=c.client_id
where c.retell_call_id is not null;

create function public.enqueue_recepta_call_notification() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_plan text;
begin
  if not new.owner_notification_requested or new.retell_call_id is null then return new; end if;
  select plan_name into v_plan from public.subscriptions
    where client_id=new.client_id and status='active';
  if v_plan in ('Recepta Standard','Recepta Pro') then
    insert into public.call_notifications(notification_key,client_id,call_record_id,retell_call_id,plan_name)
    values ('owner-call:' || new.client_id::text || ':' || new.retell_call_id,
      new.client_id,new.id,new.retell_call_id,v_plan)
    on conflict(notification_key) do nothing;
  end if;
  return new;
end; $$;
create trigger enqueue_recepta_call_notification after insert or update on public.calls
  for each row execute function public.enqueue_recepta_call_notification();

create function public.claim_recepta_call_notifications(p_limit integer default 5,p_key text default null)
returns setof public.call_notifications language plpgsql security invoker set search_path='' as $$
begin
  -- Resend retains keys for 24h. Pause ambiguous late retries instead of risking
  -- a duplicate after the provider's retention window. The notice stays visible.
  update public.call_notifications set status='needs_attention',lease_token=null,lease_expires_at=null,
    last_error='Automatic retries paused; delivery needs review.'
    where status in ('queued','retrying') and first_send_at < now()-interval '23 hours'
      and (lease_expires_at is null or lease_expires_at <= now());
  return query update public.call_notifications n set
    status='retrying',attempts=n.attempts+1,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
    where n.notification_key in (
      select q.notification_key from public.call_notifications q
      where q.status in ('queued','retrying') and q.next_attempt_at<=now()
        and (q.lease_expires_at is null or q.lease_expires_at<=now())
        and (p_key is null or q.notification_key=p_key)
      order by q.next_attempt_at,q.created_at for update skip locked
      limit least(greatest(p_limit,1),5)
    ) returning n.*;
end; $$;

create function public.prepare_recepta_call_notification(p_key text,p_lease uuid,p_payload jsonb)
returns setof public.call_notifications language sql security invoker set search_path='' as $$
  update public.call_notifications set mail_payload=coalesce(mail_payload,p_payload),
    first_send_at=coalesce(first_send_at,now())
  where notification_key=p_key and lease_token=p_lease and status='retrying' and lease_expires_at>now()
  returning *;
$$;
create function public.finish_recepta_call_notification(
  p_key text,p_lease uuid,p_provider_id text default null,p_error text default null
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.call_notifications set
    status=case when p_provider_id is not null then 'accepted' else 'queued' end,
    accepted_at=case when p_provider_id is not null then now() else null end,
    provider_message_id=p_provider_id,last_error=p_error,next_attempt_at=now()+interval '5 minutes',
    lease_token=null,lease_expires_at=null
  where notification_key=p_key and lease_token=p_lease and status='retrying';
  return found;
end; $$;
revoke all on function public.enqueue_recepta_call_notification() from public,anon,authenticated;
revoke all on function public.claim_recepta_call_notifications(integer,text) from public,anon,authenticated;
revoke all on function public.prepare_recepta_call_notification(text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.finish_recepta_call_notification(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.enqueue_recepta_call_notification() to service_role;
grant execute on function public.claim_recepta_call_notifications(integer,text) to service_role;
grant execute on function public.prepare_recepta_call_notification(text,uuid,jsonb) to service_role;
grant execute on function public.finish_recepta_call_notification(text,uuid,text,text) to service_role;
