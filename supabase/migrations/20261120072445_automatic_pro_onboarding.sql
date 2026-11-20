-- Provisioning grants are issued by the worker after the provider confirms readiness.
-- Stripe records remain the sole source of paid subscription status.
create table public.recepta_pro_authorizations (
  client_id uuid primary key references public.clients(id) on delete cascade,
  grant_id uuid not null unique default gen_random_uuid(),
  retell_agent_id text not null,
  authorized_at timestamptz not null default clock_timestamp()
);
alter table public.recepta_pro_authorizations enable row level security;
revoke all on public.recepta_pro_authorizations from public, anon, authenticated;
grant select, insert, update on public.recepta_pro_authorizations to service_role;

alter table public.subscriptions add column provider_cancel_at timestamptz;
alter table public.service_jobs drop constraint service_jobs_kind_check,
  add constraint service_jobs_kind_check check (kind in ('callback_email', 'appointment_email', 'delete_client', 'retention_call', 'provision_pro'));

-- The clients and subscriptions tables are writable only by Recepta's service
-- role. The legacy Add Client flow is the only application creator of these
-- pending Pro accounts. Exclude all explicit holds, testing and former payers.
create function public.recepta_provisioning_candidate(p_client uuid, p_allow_paid boolean default false)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.clients c
    join public.subscriptions s on s.client_id=c.id
    left join public.agents a on a.client_id=c.id
    left join public.recepta_service_overrides o on o.client_id=c.id
    where c.id=p_client and c.role='client' and not c.deletion_pending
      and c.status in ('setup','active','live')
      and (a.status is null or a.status in ('setup','active','live'))
      and coalesce(o.mode,'automatic')='automatic'
      and (o.agent_status is null or o.agent_status='live')
      and s.plan_name='Recepta Pro' and coalesce(o.plan_override,s.plan_name)='Recepta Pro'
      and s.monthly_minutes > 0
      and (s.status='pending' and nullif(btrim(s.stripe_subscription_id),'') is null
        or p_allow_paid and s.status='active' and nullif(btrim(s.stripe_subscription_id),'') is not null
          and s.current_period_start<=statement_timestamp() and s.current_period_end>statement_timestamp()
          and (s.provider_cancel_at is null or s.provider_cancel_at>statement_timestamp()))
  );
$$;

create function public.recepta_queue_provisioning(p_client uuid, p_purchase integer default 0,
  p_country text default 'CA', p_area integer default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_key text := 'provision-pro:' || p_client::text;
begin
  if not public.recepta_provisioning_candidate(p_client) then return null; end if;
  if p_purchase is null or p_purchase not between 0 and 21 or p_country is null or p_country not in ('CA','US')
      or (p_area is not null and p_area not between 200 and 999) then
    raise exception 'Invalid phone purchase request' using errcode='22023';
  end if;
  insert into public.service_jobs(job_key,client_id,kind,payload)
    values(v_key,p_client,'provision_pro',jsonb_build_object('minimum_phone_count',p_purchase,'country_code',p_country,'area_code',p_area))
    on conflict(job_key) do nothing;
  return v_key;
end $$;

-- Edits to missing/changed assignments resume an existing pending onboarding
-- job without changing its approved number-purchase request or existing grant.
create function public.recepta_resume_provisioning(p_client uuid,p_allow_paid boolean default false)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_key text;
begin
  if p_allow_paid and public.recepta_provisioning_candidate(p_client,true) then
    v_key:='provision-pro:'||p_client::text;
    if not exists(select 1 from public.service_jobs where job_key=v_key) then return false; end if;
  else
    v_key:=public.recepta_queue_provisioning(p_client);
    if v_key is null then return false; end if;
  end if;
  update public.service_jobs j set status='queued',attempts=0,last_error=null,next_attempt_at=clock_timestamp(),completed_at=null
    where job_key=v_key and status in ('complete','needs_attention','queued')
      and not exists(select 1 from public.recepta_pro_authorizations g join public.agents a
        on a.client_id=g.client_id and a.retell_agent_id=g.retell_agent_id
        where g.client_id=p_client and a.status in ('live','active') and j.status='complete');
  return true;
end $$;

create function public.recepta_complete_provisioning(p_client uuid,p_lease uuid,p_agent text,p_phone_numbers text[])
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_phones text[];
begin
  perform 1 from public.clients where id=p_client for no key update;
  perform 1 from public.subscriptions where client_id=p_client for update;
  perform 1 from public.service_jobs where job_key='provision-pro:'||p_client::text
    and status='running' and lease_token=p_lease and lease_expires_at>clock_timestamp() for update;
  if not found or not public.recepta_provisioning_candidate(p_client,true) then return false; end if;

  if not exists(select 1 from public.agents where client_id=p_client and retell_agent_id=p_agent)
     or (select count(*) from public.agents where retell_agent_id=p_agent)<>1 then return false; end if;
  select array_agg(number order by number) into v_phones from (
    select phone_number as number from public.agent_phone_numbers where client_id=p_client
    union select phone_number from public.agents where client_id=p_client and phone_number is not null
  ) n;
  if cardinality(v_phones) is null or v_phones is distinct from p_phone_numbers then return false; end if;

  insert into public.recepta_pro_authorizations(client_id,retell_agent_id) values(p_client,p_agent)
    on conflict (client_id) do update set retell_agent_id=excluded.retell_agent_id;
  update public.agents set status='live' where client_id=p_client and retell_agent_id=p_agent;
  update public.clients set status='live' where id=p_client;
  update public.service_jobs set status='complete',completed_at=clock_timestamp(),last_error=null,lease_token=null,lease_expires_at=null
    where job_key='provision-pro:'||p_client::text;
  return true;
end $$;

revoke all on function public.recepta_provisioning_candidate(uuid,boolean), public.recepta_queue_provisioning(uuid,integer,text,integer),
  public.recepta_resume_provisioning(uuid,boolean), public.recepta_complete_provisioning(uuid,uuid,text,text[]) from public,anon,authenticated;
grant execute on function public.recepta_provisioning_candidate(uuid,boolean), public.recepta_queue_provisioning(uuid,integer,text,integer),
  public.recepta_resume_provisioning(uuid,boolean), public.recepta_complete_provisioning(uuid,uuid,text,text[]) to service_role;

-- Queue existing eligible accounts. Only Add Client can authorize a new purchase;
-- this backfill works with existing assigned lines, including legacy primary numbers.
insert into public.service_jobs(job_key,client_id,kind,payload)
select 'provision-pro:'||s.client_id::text,s.client_id,'provision_pro','{"minimum_phone_count":0}'::jsonb
from public.subscriptions s
where s.plan_name='Recepta Pro' and s.status='pending' and s.stripe_subscription_id is null
  and public.recepta_provisioning_candidate(s.client_id)
on conflict(job_key) do nothing;

create or replace function public.recepta_service_access(p_client uuid, p_agent text default null)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_client public.clients%rowtype;
  v_sub public.subscriptions%rowtype;
  v_agent public.agents%rowtype;
  v_override public.recepta_service_overrides%rowtype;
  v_assigned boolean;
  v_pro_job public.service_jobs%rowtype;
  v_pro_grant public.recepta_pro_authorizations%rowtype;
  v_cancelled boolean;
  v_use_pro_grant boolean;
  v_cancel_at timestamptz;
  v_agent_status text;
  v_agent_explicit boolean;
  v_agent_ready boolean;
  v_paid boolean;
  v_founder boolean := false;
  v_legacy_test boolean := false;
  v_using_grant boolean := false;
  v_test_check jsonb;
  v_plan text;
  v_source text := 'stripe';
  v_state text := 'pending';
  v_reason text;
  v_mode text;
  v_appointments boolean := false;
  v_start timestamptz;
  v_end timestamptz;
  v_allowance bigint;
  v_remaining bigint := 0;
  v_call_cap integer;
  v_calls boolean := false;
begin
  select * into v_client from public.clients where id = p_client;
  if not found or v_client.deletion_pending then
    return jsonb_build_object('status', 'unavailable', 'reason', 'client_unavailable');
  end if;
  select * into v_sub from public.subscriptions where client_id = p_client;
  select * into v_agent from public.agents where client_id = p_client;
  select * into v_override from public.recepta_service_overrides where client_id = p_client;
  v_mode := coalesce(v_override.mode, 'automatic');
  v_plan := coalesce(v_override.plan_override, v_sub.plan_name);
  v_agent_explicit := v_override.agent_status is not null;
  v_agent_status := case when v_override.agent_status in ('live', 'testing')
      and v_override.status_agent_id is distinct from v_agent.retell_agent_id then 'setup'
    else coalesce(v_override.agent_status, case when v_agent.status = 'active' then 'live' else v_agent.status end, 'setup') end;
  v_agent_ready := v_agent_status = 'live' or (v_agent_status = 'testing' and v_mode = 'internal_test');
  v_assigned := nullif(btrim(v_agent.retell_agent_id), '') is not null
    and (p_agent is null or p_agent = v_agent.retell_agent_id)
    and (select count(*) from public.agents where retell_agent_id = v_agent.retell_agent_id) = 1;
  v_cancel_at := least(v_sub.provider_cancel_at,
    case when v_sub.cancel_at_period_end then v_sub.current_period_end end);
  v_cancelled := coalesce(v_sub.status='cancelled' or v_cancel_at<=v_now,false);
  select * into v_pro_job from public.service_jobs where job_key='provision-pro:'||p_client::text;
  select * into v_pro_grant from public.recepta_pro_authorizations where client_id=p_client;
  v_use_pro_grant := v_pro_grant.grant_id is not null and v_assigned
    and v_pro_grant.retell_agent_id=v_agent.retell_agent_id and v_agent_ready;
  v_paid := coalesce(v_sub.status = 'active' and nullif(btrim(v_sub.stripe_subscription_id), '') is not null
    and v_sub.current_period_start <= v_now and v_sub.current_period_end > v_now, false);

  if v_mode in ('paused', 'pending', 'suspended', 'cancelled') then
    v_source := 'manual_admin';
    v_state := v_mode;
    v_reason := v_mode;
  elsif v_cancelled then
    v_state := 'paused';
    v_reason := 'subscription_cancelled';
    v_agent_status := 'paused';
  elsif v_mode='automatic' and v_agent_status='paused' then
    v_state := 'paused';
    v_reason := 'agent_paused';
  elsif v_mode in ('manual', 'internal_test') and (v_override.expires_at is null or v_override.expires_at > v_now or not v_paid) then
    v_source := case when v_mode = 'manual' then 'manual_admin' else 'internal_test' end;
    if v_override.expires_at <= v_now then
      v_state := 'expired';
      v_reason := 'expired';
    elsif not v_assigned or v_override.retell_agent_id is distinct from v_agent.retell_agent_id then
      v_state := 'unavailable';
      v_reason := 'agent_assignment';
    else
      v_state := 'active';
      v_using_grant := true;
      v_plan := coalesce(v_override.plan_override, v_override.plan_name, v_sub.plan_name);
      v_appointments := v_plan = 'Recepta Pro';
      -- Open-ended manual authorization uses the configured minute allowance per UTC month.
      -- Temporary and dated grants keep a single balance for the term.
      v_start := case when v_override.expires_at is null
        then greatest(v_override.started_at, date_trunc('month', v_now, 'UTC')) else v_override.started_at end;
      v_end := coalesce(v_override.expires_at,
        (date_trunc('month', v_now at time zone 'UTC') + interval '1 month') at time zone 'UTC');
      v_allowance := v_override.max_minutes::bigint * 60;
      v_remaining := greatest(v_allowance - public.recepta_service_grant_usage(v_override.grant_id, v_start), 0);
      v_call_cap := case when v_mode = 'internal_test' then 900 else 7200 end;
      v_calls := true;
    end if;
  elsif v_mode='automatic' and v_plan='Recepta Pro' and v_pro_job.job_key is not null
      and not v_use_pro_grant and (v_paid or v_sub.status='pending') then
    v_state := 'pending';
    v_reason := 'provisioning';
  elsif v_paid then
    v_state := 'active';
    v_appointments := v_plan = 'Recepta Pro' and (p_agent is null or v_assigned);
    v_start := v_sub.current_period_start;
    v_end := least(v_sub.current_period_end,v_cancel_at);
    v_allowance := greatest(coalesce(v_sub.monthly_minutes, 0), 0)::bigint * 60;
    v_allowance := v_allowance + least(greatest(coalesce(v_sub.rollover_seconds, 0), 0), v_allowance);
    v_remaining := greatest(v_allowance - public.recepta_committed_usage(p_client, v_start, v_end), 0);
    v_call_cap := 7200;
    v_calls := v_assigned and v_agent_ready;
  elsif v_mode='automatic' and v_plan='Recepta Pro' and v_use_pro_grant
    and v_sub.status='pending' and nullif(btrim(v_sub.stripe_subscription_id),'') is null then
    v_source := 'automatic_pro';
    v_state := 'active';
    v_start := greatest(v_pro_grant.authorized_at,date_trunc('month',v_now,'UTC'));
    v_end := (date_trunc('month',v_now at time zone 'UTC')+interval '1 month') at time zone 'UTC';
    v_allowance := greatest(coalesce(v_sub.monthly_minutes,0),0)::bigint * 60;
    v_remaining := greatest(v_allowance-public.recepta_service_grant_usage(v_pro_grant.grant_id,v_start),0);
    v_appointments := true;
    v_calls := true;
    v_call_cap := 7200;
  else
    -- Keep prior, already-issued grants for clients without an explicit new
    -- policy. The owner-only migration was never applied on some previews.
    if v_override.client_id is null and v_assigned then
      if p_client = '72e5b432-2e97-4882-a30d-7c9f756c2fc2'::uuid
         and to_regprocedure('public.recepta_owner_booking_approved(uuid,text)') is not null then
        execute 'select public.recepta_owner_booking_approved($1,$2)' into v_founder using p_client, v_agent.retell_agent_id;
      end if;
      if not v_founder then
        v_test_check := public.recepta_appointment_test_check(p_client, v_agent.retell_agent_id);
        v_legacy_test := coalesce((v_test_check->>'active')::boolean, false);
      end if;
    end if;
    if v_founder then
      v_source := 'manual_admin';
      v_state := 'active';
      v_appointments := true;
      v_start := date_trunc('month', v_now, 'UTC');
      v_end := v_start + interval '1 month';
      v_allowance := 18000;
      v_remaining := greatest(v_allowance - public.recepta_committed_usage(p_client, v_start, v_end), 0);
      v_call_cap := 900;
      v_calls := coalesce(v_agent.status in ('live', 'active', 'setup'), false);
    elsif v_legacy_test then
      v_source := 'internal_test';
      v_state := 'appointment_test';
      v_appointments := true;
      v_reason := 'appointment_only';
    else
      v_state := case when v_sub.status = 'pending' then 'pending' else 'inactive' end;
      v_reason := 'billing_inactive';
    end if;
  end if;

  -- An explicit agent hold applies to paid and manually authorized service,
  -- including signed appointment tools. Pre-existing grants keep their behavior
  -- until an administrator chooses a managed agent status.
  if v_agent_explicit and not v_agent_ready then
    v_calls := false;
    v_appointments := false;
    v_legacy_test := false;
    if v_state in ('active', 'appointment_test') then
      v_state := 'unavailable';
      v_reason := 'agent_' || v_agent_status;
    end if;
  end if;

  if v_reason is null then
    v_reason := case when not v_calls then 'agent_assignment'
      when least(v_remaining, floor(extract(epoch from v_end - v_now))::bigint) < 60 then 'allowance_unavailable'
      else 'ready' end;
  end if;

  return jsonb_build_object(
    'business_name', v_client.company_name, 'status', v_state, 'mode', v_mode,
    'reason', v_reason, 'source', v_source, 'plan', v_plan,
    'billing_status', v_sub.status,
    'provisioning_status', v_pro_job.status, 'provisioning_error', v_pro_job.last_error,
    'provisioned_pro', v_use_pro_grant, 'service_allowance_seconds', coalesce(v_allowance,0),
    'cancellation_effective_at', v_cancel_at, 'billing_plan', v_sub.plan_name, 'billing_current', v_paid,
    'plan_override', v_override.plan_override, 'has_stripe_subscription', nullif(btrim(v_sub.stripe_subscription_id), '') is not null,
    'agent_id', v_agent.retell_agent_id, 'agent_status', v_agent_status,
    'agent_status_override', v_override.agent_status,
    'provisioned_agent_status', case when v_agent.status = 'active' then 'live' else coalesce(v_agent.status, 'setup') end,
    'phone_number', coalesce((select phone_number from public.agent_phone_numbers
      where client_id = p_client order by is_primary desc nulls last, phone_number limit 1), v_agent.phone_number),
    'assignment_valid', v_assigned,
    'can_reserve', v_calls, 'appointments', coalesce(v_appointments, false),
    'period_start', v_start, 'period_end', v_end, 'remaining_seconds', v_remaining,
    'call_cap', case when v_agent.demo_mode then least(v_call_cap, 180) else v_call_cap end,
    'demo_mode', coalesce(v_agent.demo_mode, false), 'grant_id', case when v_using_grant then v_override.grant_id when v_source='automatic_pro' then v_pro_grant.grant_id end,
    'expires_at', case when v_using_grant then v_override.expires_at end,
    'saved_grant_mode', v_override.grant_mode,
    'saved_grant_expires_at', v_override.expires_at, 'max_minutes', v_override.max_minutes,
    'configured_minutes', v_sub.monthly_minutes,
    'admin_reason', v_override.reason, 'updated_at', v_override.updated_at, 'updated_by', v_override.updated_by,
    'revision', coalesce(v_override.revision, 0), 'legacy_founder', v_founder, 'legacy_appointment_test', v_legacy_test, 'legacy_test_usable', coalesce((v_test_check->>'can_use')::boolean, false)
  );
end;
$$;

create function public.recepta_clear_cancellation_on_resubscribe()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.stripe_subscription_id is distinct from old.stripe_subscription_id then new.provider_cancel_at:=null; end if;
  return new;
end $$;
create trigger recepta_clear_cancellation_on_resubscribe before update of stripe_subscription_id on public.subscriptions
  for each row execute function public.recepta_clear_cancellation_on_resubscribe();
revoke all on function public.recepta_clear_cancellation_on_resubscribe() from public,anon,authenticated;
grant execute on function public.recepta_clear_cancellation_on_resubscribe() to service_role;

-- Completed calls keep their notification rights after a paid handoff or hold.
-- The reservation is a server-issued proof that the signed call was admitted.
create function public.recepta_grant_call_plan(p_client uuid,p_call text)
returns text language sql stable security invoker set search_path = '' as $$
  select coalesce(o.plan_name, case when g.grant_id is not null then 'Recepta Pro' end)
    from public.call_minute_reservations r
    left join public.recepta_pro_authorizations g on g.grant_id=r.service_grant_id and g.client_id=r.client_id
    left join public.recepta_service_overrides o on o.grant_id=r.service_grant_id and o.client_id=r.client_id
    where r.client_id=p_client and r.retell_call_id=p_call and r.service_grant_id is not null;
$$;
revoke all on function public.recepta_grant_call_plan(uuid,text) from public,anon,authenticated;
grant execute on function public.recepta_grant_call_plan(uuid,text) to service_role;

create or replace function public.enqueue_recepta_call_notification() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_plan text; v_caller boolean; v_error text;
begin
  if not new.owner_notification_requested or new.retell_call_id is null or new.content_erased_at is not null then return new; end if;
  v_plan:=public.recepta_grant_call_plan(new.client_id,new.retell_call_id);
  if v_plan is null then
    select plan_name into v_plan from public.subscriptions where client_id=new.client_id and status='active';
  end if;
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
