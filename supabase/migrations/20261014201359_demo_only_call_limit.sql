-- Default existing and new agents to regular customer calls. Only an admin can
-- mark an agent as a demo through the existing agents UPDATE authorization.
alter table public.agents add column demo_mode boolean not null default false;
alter table public.call_minute_reservations
  add column retell_agent_id text,
  add column demo_mode boolean not null default false;
alter table public.call_minute_reservations
  drop constraint call_minute_reservations_reserved_seconds_check,
  add constraint call_minute_reservations_reserved_seconds_check check (
    reserved_seconds>=60 and (retell_call_id is null or
      reserved_seconds <= case when demo_mode then 180 else 7200 end));

create function public.reserve_recepta_agent_call(p_client_id uuid,p_call_id text,p_agent_id text)
returns table(reservation_id uuid,reserved_seconds integer,demo_mode boolean)
language plpgsql security invoker set search_path='' as $$
declare
  v_subscription public.subscriptions%rowtype;
  v_existing public.call_minute_reservations%rowtype;
  v_monthly bigint;
  v_allowance bigint;
  v_remaining bigint;
  v_seconds integer;
  v_id uuid;
  v_now timestamptz;
  v_demo boolean;
begin
  if p_call_id is null or btrim(p_call_id)='' or length(p_call_id)>512 then return; end if;
  -- This also serializes admission with paid renewals and Checkout activation.
  select * into v_subscription from public.subscriptions where client_id=p_client_id for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if v_subscription.status is distinct from 'active' or v_subscription.current_period_start is null
    or v_subscription.current_period_end is null or v_subscription.current_period_start>v_now
    or v_subscription.current_period_end<=v_now or coalesce(v_subscription.monthly_minutes,0)<1 then return; end if;

  select a.demo_mode into v_demo from public.agents a
    where a.client_id=p_client_id and a.retell_agent_id=p_agent_id and a.status in ('live','active');
  if not found then return; end if;

  select * into v_existing from public.call_minute_reservations where retell_call_id=p_call_id;
  if found then
    if v_existing.client_id<>p_client_id then raise exception 'Retell call belongs to another client'; end if;
    if v_existing.period_start=v_subscription.current_period_start and v_existing.status='active'
      and (v_existing.retell_agent_id is null or v_existing.retell_agent_id=p_agent_id)
      and not exists(select 1 from public.calls where client_id=p_client_id and retell_call_id=p_call_id
        and call_status in ('ended','error','not_connected')) then
      return query select v_existing.id,v_existing.reserved_seconds,v_existing.demo_mode;
    end if;
    return;
  end if;
  if exists(select 1 from public.calls where retell_call_id=p_call_id
    and (client_id<>p_client_id or call_status in ('ended','error','not_connected'))) then return; end if;

  v_monthly := v_subscription.monthly_minutes::bigint*60;
  v_allowance := v_monthly + least(greatest(coalesce(v_subscription.rollover_seconds,0),0),v_monthly);
  v_remaining := greatest(v_allowance-public.recepta_committed_usage(p_client_id,
    v_subscription.current_period_start,v_subscription.current_period_end),0);
  -- Demo agents get 3 minutes. Customer calls have no Recepta 3-minute timer;
  -- their bound is remaining paid time and Retell's 2-hour technical maximum.
  v_seconds := least(v_remaining,case when v_demo then 180 else 7200 end,floor(extract(epoch from v_subscription.current_period_end-v_now))::bigint)::integer;
  if v_seconds<60 then return; end if;
  insert into public.call_minute_reservations(client_id,retell_call_id,period_start,period_end,reserved_seconds,retell_agent_id,demo_mode)
    values(p_client_id,p_call_id,v_subscription.current_period_start,v_subscription.current_period_end,v_seconds,p_agent_id,v_demo)
    returning id into v_id;
  return query select v_id,v_seconds,v_demo;
end; $$;


-- Retire admission that cannot identify the exact agent and its demo setting.
-- Keeping the old signature empty safely declines calls during deployment overlap.
create or replace function public.reserve_recepta_inbound_call(p_client_id uuid,p_call_id text)
returns table(reservation_id uuid,reserved_seconds integer)
language sql security invoker set search_path='' as $$
  select null::uuid,null::integer where false;
$$;
revoke all on function public.reserve_recepta_agent_call(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_recepta_agent_call(uuid,text,text) to service_role;
revoke all on function public.reserve_recepta_inbound_call(uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_recepta_inbound_call(uuid,text) to service_role;
comment on column public.agents.demo_mode is 'Admin-selected demo agent: 3-minute calls. Normal customer calls use remaining paid time, up to the provider maximum.';

-- Paid activation promotes demo prospects atomically with the paid subscription.
create or replace function public.activate_recepta_checkout(
  p_client_id uuid, p_stripe_subscription_id text, p_customer_id text,
  p_period_start timestamptz, p_period_end timestamptz,
  p_configuration jsonb, p_replaces_subscription_id text default null
)
returns setof public.subscriptions
language plpgsql security invoker set search_path = ''
as $$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then raise exception 'Invalid billing period'; end if;
  select * into v_old from public.subscriptions where client_id = p_client_id for update;
  if not found then raise exception 'Subscription is not configured'; end if;
  if v_old.stripe_subscription_id = p_stripe_subscription_id then
    if v_old.current_period_start = p_period_start and v_old.status = 'active' then
      return next v_old;
    end if;
    return;
  end if;
  if p_replaces_subscription_id is not null then
    if v_old.stripe_subscription_id is distinct from p_replaces_subscription_id then return; end if;
  elsif v_old.status = 'active' and v_old.stripe_subscription_id is not null then
    return;
  end if;
  v_next := jsonb_populate_record(v_old, p_configuration);
  if p_replaces_subscription_id is not null and v_old.status = 'active'
    and v_old.current_period_start <= p_period_start and v_old.current_period_end > p_period_start then
    v_used := public.recepta_committed_usage(p_client_id,
      v_old.current_period_start,p_period_start);
    v_monthly := greatest(coalesce(v_old.monthly_minutes, 0), 0)::bigint * 60;
    v_rollover := least(
      greatest(v_monthly - greatest(v_used - least(coalesce(v_old.rollover_seconds, 0), v_monthly), 0), 0),
      greatest(coalesce(v_next.monthly_minutes, 0), 0)::bigint * 60
    );
  end if;
  -- A confirmed paid Checkout converts the prospect to normal customer calls.
  -- Replay guards above return before this, preserving a later admin demo choice.
  update public.agents set demo_mode=false where client_id=p_client_id;
  return query update public.subscriptions set
    plan_name = v_next.plan_name, monthly_price = v_next.monthly_price,
    monthly_minutes = v_next.monthly_minutes, ai_model_id = v_next.ai_model_id,
    pii_redaction_enabled = v_next.pii_redaction_enabled,
    safety_guardrails_enabled = v_next.safety_guardrails_enabled,
    extra_phone_numbers = v_next.extra_phone_numbers,
    status = 'active', rollover_seconds = v_rollover,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end, stripe_subscription_id = p_stripe_subscription_id,
    stripe_customer_id = p_customer_id, cancel_at_period_end = false
    where client_id = p_client_id returning *;
end;
$$;
revoke all on function public.activate_recepta_checkout(uuid,text,text,timestamptz,timestamptz,jsonb,text) from public,anon,authenticated;
grant execute on function public.activate_recepta_checkout(uuid,text,text,timestamptz,timestamptz,jsonb,text) to service_role;
