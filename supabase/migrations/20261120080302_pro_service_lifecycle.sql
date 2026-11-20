alter table public.subscriptions
  add column pro_invoice_due_at timestamptz,
  add column pro_invoice_id text,
  add column pro_cancelled_at timestamptz;

create table public.recepta_pro_lifecycle (
  client_id uuid primary key references public.clients(id) on delete cascade,
  paused_at timestamptz,
  authorized_until timestamptz,
  deadline_override timestamptz,
  checkout_hold_until timestamptz,
  rollout_until timestamptz,
  revision integer not null default 0,
  operation text check (operation in ('deleting','deleted','restoring')),
  original_agent_id text,
  retained_reason text,
  retained_deadline timestamptz,
  replacement_agent_id text,
  backup jsonb,
  lease uuid,
  retry_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
alter table public.recepta_pro_lifecycle enable row level security;
revoke all on public.recepta_pro_lifecycle from public,anon,authenticated;
grant select,insert,update on public.recepta_pro_lifecycle to service_role;

alter table public.recepta_service_access_audit drop constraint recepta_service_action_check;
alter table public.recepta_service_access_audit add constraint recepta_service_action_check check
  (action in ('save','activate_test','pause','revoke','activate','deactivate','reactivate','pro_ongoing','pro_paused','pro_deadline'));

alter table public.billing_notifications drop constraint if exists billing_notifications_kind_check;
alter table public.billing_notifications add constraint billing_notifications_kind_check check
  (kind in ('renewal_reminder','payment_success','payment_failed','usage_80','usage_100','agent_retention'));

-- Already lapsed accounts get a fresh transition period. Future scheduled Stripe
-- cancellations keep their actual effective date.
update public.subscriptions set pro_cancelled_at=statement_timestamp()
where plan_name='Recepta Pro' and (status='cancelled' or
  least(provider_cancel_at,case when cancel_at_period_end then current_period_end end)<=statement_timestamp());
update public.subscriptions set pro_invoice_due_at=statement_timestamp()
where plan_name='Recepta Pro' and status='past_due';
insert into public.recepta_pro_lifecycle(client_id,rollout_until)
select g.client_id,statement_timestamp()+interval '30 days'
from public.recepta_pro_authorizations g join public.subscriptions s on s.client_id=g.client_id
where s.plan_name='Recepta Pro' and s.status='pending' and s.stripe_subscription_id is null;

create function public.recepta_pro_billing_transition() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.status='active' and (old.status is distinct from new.status
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.current_period_start is distinct from old.current_period_start) then
    new.pro_invoice_due_at:=null;
    new.pro_invoice_id:=null;
    new.pro_cancelled_at:=null;
  end if;
  if new.status='cancelled' and old.status is distinct from new.status
      and new.pro_invoice_due_at is null then
    new.pro_cancelled_at:=coalesce(new.pro_cancelled_at,clock_timestamp());
  end if;
  return new;
end $$;
create trigger recepta_pro_billing_transition before update on public.subscriptions
for each row execute function public.recepta_pro_billing_transition();

create function public.recepta_pro_timeline(p_client uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  s public.subscriptions%rowtype;
  l public.recepta_pro_lifecycle%rowtype;
  g public.recepta_pro_authorizations%rowtype;
  m text;
  p text;
  now_at timestamptz:=statement_timestamp();
  due_at timestamptz;
  cancel_at timestamptz;
  grace_start timestamptz;
  grace_end timestamptz;
  deadline timestamptz;
  reason text;
  paid boolean;
begin
  select * into s from public.subscriptions where client_id=p_client;
  select mode,plan_override into m,p from public.recepta_service_overrides where client_id=p_client;
  select * into l from public.recepta_pro_lifecycle where client_id=p_client;
  if coalesce(p,s.plan_name) is distinct from 'Recepta Pro' and l.operation is null then return '{}'::jsonb; end if;
  select * into g from public.recepta_pro_authorizations where client_id=p_client;
  cancel_at:=coalesce(s.pro_cancelled_at,least(s.provider_cancel_at,
    case when s.cancel_at_period_end then s.current_period_end end));
  if cancel_at>now_at then cancel_at:=null; end if;
  paid:=coalesce(s.status='active' and nullif(s.stripe_subscription_id,'') is not null
    and s.current_period_start<=now_at and s.current_period_end>now_at and cancel_at is null,false);

  if l.authorized_until is not null and (cancel_at is null or cancel_at<=l.authorized_until-interval '30 days') then
    grace_start:=l.authorized_until-interval '30 days';
    grace_end:=l.authorized_until;
  elsif cancel_at is not null then
    reason:='cancellation'; due_at:=cancel_at; deadline:=cancel_at+interval '30 days';
  elsif s.pro_invoice_due_at is not null and not paid then
    grace_start:=s.pro_invoice_due_at; grace_end:=grace_start+interval '30 days';
  elsif s.status='pending' and s.stripe_subscription_id is null and g.authorized_at is not null then
    grace_start:=g.authorized_at; grace_end:=greatest(grace_start+interval '30 days',l.rollout_until);
  end if;
  if not paid and grace_end is not null then
    reason:='nonpayment'; due_at:=grace_start; deadline:=grace_end;
  end if;
  if reason is null and l.paused_at is not null and not paid then
    reason:='admin_pause'; due_at:=l.paused_at; deadline:=l.paused_at+interval '30 days';
  end if;
  -- Existing hard security holds continue to block service; they never opt an
  -- agent into expiry. Explicit pauses in this editor keep the billing timer.
  if m in ('suspended','pending','cancelled','paused') and l.paused_at is null then deadline:=null; end if;
  if deadline is not null then deadline:=coalesce(l.deadline_override,deadline); end if;
  return jsonb_build_object('reason',reason,'date',due_at,'deadline',deadline,'paid',paid,
    'grace_start',grace_start,'grace_end',case when reason='nonpayment' then deadline else grace_end end,
    'held',l.paused_at is not null or coalesce(m in ('suspended','pending','cancelled','paused'),false),
    'operation',l.operation,'revision',coalesce(l.revision,0),'error',l.last_error,
    'invoice_id',s.pro_invoice_id,'stripe_id',s.stripe_subscription_id);
end $$;

alter function public.recepta_service_access(uuid,text) rename to recepta_service_access_before_pro_lifecycle;
create function public.recepta_service_access(p_client uuid,p_agent text default null)
returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare
  a jsonb:=public.recepta_service_access_before_pro_lifecycle(p_client,p_agent);
  t jsonb;
  g public.recepta_pro_authorizations%rowtype;
  aid text:=a->>'agent_id';
  allowance bigint;
  remaining bigint;
  start_at timestamptz;
  end_at timestamptz;
  cause text;
  now_at timestamptz:=clock_timestamp();
begin
  t:=public.recepta_pro_timeline(p_client);
  if a->>'plan' is distinct from 'Recepta Pro' and t->>'operation' is null then return a; end if;
  start_at:=(t->>'grace_start')::timestamptz;
  end_at:=(t->>'grace_end')::timestamptz;
  if t->>'operation' is not null then cause:='agent_'||(t->>'operation');
  elsif (t->>'held')::boolean then
    if coalesce(a->>'mode','automatic') not in ('suspended','pending','cancelled','paused') then cause:='admin_paused'; end if;
  elsif t->>'reason'='cancellation' then cause:='subscription_cancelled';
  elsif end_at<=now_at and not (t->>'paid')::boolean then cause:='payment_grace_expired';
  elsif start_at is not null and end_at>now_at and not (t->>'paid')::boolean and
        a->>'phone_number' is not null
        and (a->>'assignment_valid')::boolean
        and a->>'provisioned_agent_status'='live' and coalesce(a->>'agent_status_override','live')='live' then
    select * into g from public.recepta_pro_authorizations where client_id=p_client and retell_agent_id=aid;
    if found then
      allowance:=greatest(coalesce((a->>'configured_minutes')::bigint,0),0)*60;
      remaining:=greatest(allowance-public.recepta_service_grant_usage(g.grant_id,start_at),0);
      a:=a||jsonb_build_object('status','active','reason',case when remaining<60 then 'allowance_unavailable' else 'ready' end,
        'source','automatic_pro','agent_status','live','can_reserve',true,'appointments',true,'grant_id',g.grant_id,
        'period_start',start_at,'period_end',end_at,'remaining_seconds',remaining,'service_allowance_seconds',allowance,
        'call_cap',case when (a->>'demo_mode')::boolean then 180 else 7200 end);
    end if;
  end if;
  if cause is not null then
    a:=a||jsonb_build_object('status','paused','reason',cause,'agent_status','paused','can_reserve',false,'appointments',false,'grant_id',null);
  end if;
  if a->>'status'='active' and (a->>'phone_number' is null or not (a->>'assignment_valid')::boolean) then
    a:=a||jsonb_build_object('can_reserve',false,'appointments',false);
  end if;
  return a||jsonb_build_object('service_status',
    case when a->>'status'='active' and (a->>'can_reserve')::boolean and a->>'phone_number' is not null then 'ongoing' else 'paused' end,
    'retention_reason',t->>'reason','retention_started_at',t->>'date','retention_deadline',t->>'deadline',
    'payment_grace_ends_at',end_at,'retention_operation',t->>'operation','retention_error',t->>'error',
    'lifecycle_revision',t->'revision');
end $$;

-- Retain a single capped grant for renewal grace and for restoring an existing
-- agent. Historical calls and reservations keep their original grant IDs.
create function public.recepta_pro_renewal_grant() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.plan_name='Recepta Pro' and new.pro_invoice_due_at is not null and
      new.pro_invoice_due_at is distinct from old.pro_invoice_due_at then
    insert into public.recepta_pro_authorizations(client_id,retell_agent_id)
      select client_id,retell_agent_id from public.agents where client_id=new.client_id
      and retell_agent_id is not null and status in ('live','active')
      on conflict(client_id) do nothing;
  end if;
  return new;
end $$;
create trigger recepta_pro_renewal_grant after update of pro_invoice_due_at on public.subscriptions
for each row execute function public.recepta_pro_renewal_grant();

-- Assignments and final deletion checks share an advisory lock. An agent
-- archived for one customer cannot be assigned to any customer mid-deletion.
create function public.recepta_guard_retell_assignment() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' and old.retell_agent_id is not distinct from new.retell_agent_id then return new; end if;
  if new.retell_agent_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.retell_agent_id,2710));
  end if;
  if exists(select 1 from public.recepta_pro_lifecycle
    where operation='deleting' and (client_id=new.client_id or original_agent_id=new.retell_agent_id)) then
    raise exception 'An agent retention operation is in progress' using errcode='40001';
  end if;
  return new;
end $$;
create trigger recepta_guard_retell_assignment before insert or update of retell_agent_id on public.agents
for each row execute function public.recepta_guard_retell_assignment();

create function public.recepta_manage_pro_service(p_client uuid,p_actor uuid,p_status text,p_revision integer,
  p_retention timestamptz,p_reason text,p_agent text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  a jsonb;
  l public.recepta_pro_lifecycle%rowtype;
  t jsonb;
begin
  perform 1 from public.subscriptions where client_id=p_client for update;
  select * into l from public.recepta_pro_lifecycle where client_id=p_client for update;
  t:=public.recepta_pro_timeline(p_client);
  a:=public.recepta_service_access(p_client);
  if a->>'plan' is distinct from 'Recepta Pro' or a->>'agent_id' is distinct from p_agent
    or p_revision is distinct from coalesce(l.revision,0) or l.operation in ('deleting','restoring') then
    raise exception 'Service settings changed. Refresh and try again.' using errcode='40001';
  end if;
  if p_status not in ('ongoing','paused','deadline') or
    (p_status='deadline' and (p_retention is null or not isfinite(p_retention) or p_retention<=clock_timestamp()
      or length(btrim(coalesce(p_reason,''))) not between 1 and 500
      or a->>'retention_deadline' is null or l.operation='deleted')) then
    raise exception 'Select a valid status or a future retention deadline with a reason.' using errcode='22023';
  end if;
  if p_status='ongoing' and l.operation is distinct from 'deleted' and
    (p_agent is null or (a->>'assignment_valid')::boolean is distinct from true or a->>'phone_number' is null) then
    raise exception 'An exclusively assigned agent and phone number are required.' using errcode='22023';
  end if;
  insert into public.recepta_pro_lifecycle(client_id) values(p_client) on conflict do nothing;
  if p_status='paused' then
    update public.recepta_pro_lifecycle set paused_at=coalesce(paused_at,clock_timestamp()) where client_id=p_client;
  elsif p_status='deadline' then
    update public.recepta_pro_lifecycle set deadline_override=p_retention where client_id=p_client;
  else
    -- Lift an explicit hold only on a new, authenticated administrator action.
    update public.recepta_service_overrides set mode='automatic',agent_status=null,status_agent_id=null,
      revision=revision+1,updated_at=clock_timestamp(),updated_by=p_actor
      where client_id=p_client and (mode<>'automatic' or agent_status is not null);
    if not (t->>'paid')::boolean and (t->>'grace_end' is null or (t->>'grace_end')::timestamptz<=clock_timestamp()) then
      update public.recepta_pro_lifecycle set authorized_until=clock_timestamp()+interval '30 days' where client_id=p_client;
    end if;
    update public.recepta_pro_lifecycle set paused_at=null,deadline_override=null where client_id=p_client;
    if l.operation is distinct from 'deleted' then
      insert into public.recepta_pro_authorizations(client_id,retell_agent_id) values(p_client,p_agent)
        on conflict(client_id) do update set retell_agent_id=excluded.retell_agent_id;
      update public.agents set status='live' where client_id=p_client and retell_agent_id=p_agent;
      update public.clients set status='live' where id=p_client;
    end if;
  end if;
  update public.recepta_pro_lifecycle set revision=revision+1 where client_id=p_client;

  insert into public.recepta_service_access_audit(client_id, actor_id, action, occurred_at, previous_state,new_state)
  values(p_client,p_actor,'pro_'||p_status,clock_timestamp(),a,public.recepta_service_access(p_client)||jsonb_build_object('change_reason',p_reason));
  return public.recepta_service_access(p_client);
end $$;

revoke all on function public.recepta_pro_billing_transition(),public.recepta_pro_renewal_grant(),
 public.recepta_guard_retell_assignment(),public.recepta_pro_timeline(uuid),public.recepta_service_access(uuid,text),
 public.recepta_manage_pro_service(uuid,uuid,text,integer,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.recepta_pro_billing_transition(),public.recepta_pro_renewal_grant(),
 public.recepta_guard_retell_assignment(),public.recepta_pro_timeline(uuid),public.recepta_service_access(uuid,text),
 public.recepta_manage_pro_service(uuid,uuid,text,integer,timestamptz,text,text) to service_role;

create function public.recepta_pro_notice_key(p_client uuid,p_timeline jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select 'agent-retention:'||p_client::text||':'||md5(
    coalesce(p_timeline->>'reason','')||':'||coalesce(p_timeline->>'deadline',''));
$$;

create function public.recepta_pro_lifecycle_work(p_limit integer default 15)
returns table(client_id uuid,agent_id text,timeline jsonb,operation text,notice_key text)
language sql stable security invoker set search_path='' as $$
  select s.client_id,a.retell_agent_id,t.info,l.operation,public.recepta_pro_notice_key(s.client_id,t.info)
  from public.subscriptions s
  join public.clients c on c.id=s.client_id and not c.deletion_pending
  join public.agents a on a.client_id=s.client_id
  left join public.recepta_pro_lifecycle l on l.client_id=s.client_id
  cross join lateral (select public.recepta_pro_timeline(s.client_id) info) t
  where t.info<>'{}'::jsonb and (l.retry_at is null or l.retry_at<=statement_timestamp()) and
    (l.operation in ('deleting','restoring')
      or l.operation='deleted' and not (t.info->>'held')::boolean
        and ((t.info->>'paid')::boolean or (t.info->>'grace_end')::timestamptz>statement_timestamp())
      or l.operation is null and a.retell_agent_id is not null
        and not (t.info->>'paid')::boolean and (t.info->>'deadline')::timestamptz<=statement_timestamp()+interval '7 days')
  order by l.operation in ('deleting','restoring','deleted') desc nulls last,
    (t.info->>'deadline')::timestamptz nulls last, s.client_id
  limit least(100,greatest(1,p_limit));
$$;

create function public.recepta_pro_deletion_allowed(p_client uuid,p_agent text)
returns boolean language sql stable security invoker set search_path='' as $$
  select p_agent is not null and exists(
    select 1 from public.agents a
    join public.clients c on c.id=a.client_id and not c.deletion_pending
    cross join lateral (select public.recepta_pro_timeline(p_client) info) t
    where a.client_id=p_client and a.retell_agent_id=p_agent
      and not (t.info->>'paid')::boolean and (t.info->>'deadline')::timestamptz<=statement_timestamp()
      and exists(select 1 from public.billing_notifications n
        where n.notification_key=public.recepta_pro_notice_key(p_client,t.info) and n.client_id=p_client
          and n.sent_at<=statement_timestamp()-interval '24 hours'
          and coalesce(n.delivery_status,'sent') not in ('bounced','complained','failed','suppressed'))
      and not exists(select 1 from public.recepta_pro_lifecycle l where l.client_id=p_client
        and l.checkout_hold_until>statement_timestamp())
      and not exists(select 1 from public.agents b where b.retell_agent_id=p_agent and b.client_id<>p_client)
      and not exists(select 1 from public.recepta_demo_links d where d.retell_agent_id=p_agent and not d.revoked and d.expires_at>statement_timestamp())
      and not exists(select 1 from public.call_minute_reservations r where r.client_id=p_client and r.retell_agent_id=p_agent
        and r.status='active' and r.created_at + make_interval(secs=>r.reserved_seconds+300)>statement_timestamp())
  );
$$;

create function public.recepta_pro_claim_lifecycle(p_client uuid,p_agent text,p_operation text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  l public.recepta_pro_lifecycle%rowtype;
  t jsonb;
begin
  perform 1 from public.subscriptions where client_id=p_client for update;
  if not found or not exists(select 1 from public.clients where id=p_client and not deletion_pending) then return null; end if;
  if p_agent is not null then perform pg_advisory_xact_lock(hashtextextended(p_agent,2710)); end if;
  select * into l from public.recepta_pro_lifecycle where client_id=p_client for update;
  if l.retry_at>clock_timestamp() then return null; end if;
  t:=public.recepta_pro_timeline(p_client);
  if p_operation='deleting' then
    if l.operation='deleting' then
      if l.original_agent_id is distinct from p_agent then return null; end if;
    elsif l.operation is not null or not public.recepta_pro_deletion_allowed(p_client,p_agent) then
      return null;
    end if;
  elsif p_operation='restoring' then
    if l.operation not in ('deleted','restoring') or l.operation is null or l.backup is null
      or ((t->>'held')::boolean or not ((t->>'paid')::boolean or
        coalesce((t->>'grace_end')::timestamptz>clock_timestamp(),false))) and l.operation='deleted' then
      return null;
    end if;
  else return null;
  end if;
  insert into public.recepta_pro_lifecycle(client_id,operation,original_agent_id,lease,retry_at,attempts,retained_reason,retained_deadline)
    values(p_client,p_operation,p_agent,gen_random_uuid(),clock_timestamp()+interval '4 minutes',1,
      t->>'reason',(t->>'deadline')::timestamptz)
    on conflict(client_id) do update set operation=excluded.operation,
      original_agent_id=case when excluded.operation='deleting' then excluded.original_agent_id else recepta_pro_lifecycle.original_agent_id end,
      lease=excluded.lease,retry_at=excluded.retry_at,attempts=recepta_pro_lifecycle.attempts+1,
      retained_reason=case when recepta_pro_lifecycle.operation is null then excluded.retained_reason else recepta_pro_lifecycle.retained_reason end,
      retained_deadline=case when recepta_pro_lifecycle.operation is null then excluded.retained_deadline else recepta_pro_lifecycle.retained_deadline end
    returning * into l;
  return to_jsonb(l);
end $$;

create function public.recepta_pro_confirm_delete(p_client uuid,p_lease uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare l public.recepta_pro_lifecycle%rowtype;
begin
  perform 1 from public.subscriptions where client_id=p_client for update;
  select * into l from public.recepta_pro_lifecycle where client_id=p_client and lease=p_lease
    and operation='deleting' and retry_at>clock_timestamp() and backup is not null for update;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(l.original_agent_id,2710));
  return public.recepta_pro_deletion_allowed(p_client,l.original_agent_id);
end $$;

create function public.recepta_pro_finish_lifecycle(p_client uuid,p_lease uuid,p_result text,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare
  l public.recepta_pro_lifecycle%rowtype;
begin
  perform 1 from public.subscriptions where client_id=p_client for update;
  select * into l from public.recepta_pro_lifecycle where client_id=p_client and lease=p_lease for update;
  if not found then return false; end if;
  if p_result='retry' then
    update public.recepta_pro_lifecycle set lease=null,last_error=p_error,
      retry_at=clock_timestamp()+least(60,5*greatest(attempts,1))*interval '1 minute' where client_id=p_client;
  elsif p_result='cancelled' and l.operation='deleting' then
    update public.recepta_pro_lifecycle set operation=null,retry_at=null,lease=null,last_error=null,attempts=0,backup=null,
      original_agent_id=null,replacement_agent_id=null where client_id=p_client;
  elsif p_result='deleted' and l.operation='deleting' and l.backup is not null then
    update public.recepta_pro_lifecycle set operation='deleted',lease=null,retry_at=null,last_error=null,attempts=0,
      replacement_agent_id=null,revision=revision+1 where client_id=p_client;
    update public.agents set retell_agent_id=null,status='setup'
      where client_id=p_client and retell_agent_id=l.original_agent_id;
    if not found then raise exception 'Retell assignment changed'; end if;
  elsif p_result='restored' and l.operation='restoring' and l.replacement_agent_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(l.replacement_agent_id,2710));
    if exists(select 1 from public.agents where retell_agent_id=l.replacement_agent_id and client_id<>p_client)
      then raise exception 'Replacement agent already assigned'; end if;
    update public.agents set retell_agent_id=l.replacement_agent_id,status='live' where client_id=p_client and retell_agent_id is null;
    if not found then raise exception 'Retell assignment changed'; end if;
    update public.clients set status='live' where id=p_client and not deletion_pending;
    insert into public.recepta_pro_authorizations(client_id,retell_agent_id) values(p_client,l.replacement_agent_id)
      on conflict(client_id) do update set retell_agent_id=excluded.retell_agent_id;
    update public.booking_settings set sync_agent_id=l.replacement_agent_id,synced_at=clock_timestamp()
      where client_id=p_client and (sync_agent_id is null or sync_agent_id=l.original_agent_id);
    update public.recepta_pro_lifecycle set operation=null,lease=null,retry_at=null,last_error=null,attempts=0,
      revision=revision+1 where client_id=p_client;
  else return false;
  end if;
  insert into public.recepta_pro_lifecycle_audit(client_id,agent_id,action,reason,deadline,result)
    values(p_client,l.original_agent_id,l.operation,l.retained_reason,l.retained_deadline,
      jsonb_build_object('status',p_result,'error',p_error,'replacement',l.replacement_agent_id));
  return true;
end $$;

create table public.recepta_pro_lifecycle_audit (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  agent_id text,
  action text not null,
  reason text,
  deadline timestamptz,
  result jsonb not null,
  occurred_at timestamptz not null default clock_timestamp()
);
create index recepta_pro_lifecycle_audit_client_idx on public.recepta_pro_lifecycle_audit(client_id,occurred_at desc);
alter table public.recepta_pro_lifecycle_audit enable row level security;
revoke all on public.recepta_pro_lifecycle_audit from public,anon,authenticated;
grant select,insert on public.recepta_pro_lifecycle_audit to service_role;

revoke all on function public.recepta_pro_notice_key(uuid,jsonb), public.recepta_pro_lifecycle_work(integer),
 public.recepta_pro_deletion_allowed(uuid,text),public.recepta_pro_claim_lifecycle(uuid,text,text),
 public.recepta_pro_confirm_delete(uuid,uuid),public.recepta_pro_finish_lifecycle(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.recepta_pro_notice_key(uuid,jsonb), public.recepta_pro_lifecycle_work(integer),
 public.recepta_pro_deletion_allowed(uuid,text),public.recepta_pro_claim_lifecycle(uuid,text,text),
 public.recepta_pro_confirm_delete(uuid,uuid),public.recepta_pro_finish_lifecycle(uuid,uuid,text,text) to service_role;

-- Reserve enough time for Recepta's Stripe Checkout to complete. The processor
-- also checks the invoice at Stripe before committing a destructive operation.
create function public.recepta_pro_begin_checkout(p_client uuid,p_until timestamptz)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.subscriptions where client_id=p_client for update;
  if not found then return false; end if;
  if exists(select 1 from public.recepta_pro_lifecycle where client_id=p_client and operation='deleting') then return false; end if;
  insert into public.recepta_pro_lifecycle(client_id,checkout_hold_until) values(p_client,p_until+interval '15 minutes')
    on conflict(client_id) do update set checkout_hold_until=greatest(recepta_pro_lifecycle.checkout_hold_until,excluded.checkout_hold_until);
  return true;
end $$;

create function public.recepta_pro_reset_billing_lifecycle() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.status='active' and (old.status is distinct from new.status
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.current_period_start is distinct from old.current_period_start) then
    update public.recepta_pro_lifecycle set authorized_until=null,deadline_override=null,checkout_hold_until=null,rollout_until=null
      where client_id=new.client_id;
  elsif new.pro_cancelled_at is distinct from old.pro_cancelled_at
    or new.pro_invoice_due_at is distinct from old.pro_invoice_due_at then
    update public.recepta_pro_lifecycle set deadline_override=null where client_id=new.client_id;
  end if;
  return new;
end $$;
create trigger recepta_pro_reset_billing_lifecycle after update on public.subscriptions
for each row execute function public.recepta_pro_reset_billing_lifecycle();

revoke all on function public.recepta_pro_begin_checkout(uuid,timestamptz),public.recepta_pro_reset_billing_lifecycle() from public,anon,authenticated;
grant execute on function public.recepta_pro_begin_checkout(uuid,timestamptz),public.recepta_pro_reset_billing_lifecycle() to service_role;
