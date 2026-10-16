-- Configuration is a quote. Only paid Stripe activation changes live entitlements.
alter table public.subscriptions
  add column pending_configuration jsonb,
  add column configuration_revision bigint not null default 0;

-- Existing manually activated accounts are unfunded; preserve their configuration
-- for Checkout while removing the artificial paid period and rollover.
update public.subscriptions set status='pending', current_period_start=null,
  current_period_end=null, next_billing_date=null, rollover_seconds=0
where status='active' and nullif(btrim(stripe_subscription_id),'') is null;
update public.agents set status='setup' where client_id in (
  select client_id from public.subscriptions where status='pending'
    and nullif(btrim(stripe_subscription_id),'') is null
);
alter table public.subscriptions add constraint active_subscription_requires_payment
  check (status <> 'active' or nullif(btrim(stripe_subscription_id),'') is not null);

create function public.configure_recepta_subscription(p_client_id uuid,p_configuration jsonb)
returns setof public.subscriptions
language plpgsql security invoker set search_path='' as $$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_configuration jsonb;
  v_current jsonb;
begin
  select * into v_old from public.subscriptions where client_id=p_client_id for update;
  if not found then raise exception 'Subscription is not configured'; end if;
  if jsonb_typeof(p_configuration) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_configuration) k where k not in
      ('plan_name','monthly_price','monthly_minutes','ai_model_id','pii_redaction_enabled',
       'safety_guardrails_enabled','extra_phone_numbers','phone_number_country','phone_number_area_code')
  ) then raise exception 'Only billing configuration may be changed'; end if;
  v_next := jsonb_populate_record(v_old,p_configuration);
  if v_next.plan_name not in ('Recepta Standard','Recepta Pro') or v_next.plan_name is null
    or v_next.monthly_minutes is null or v_next.monthly_minutes<1 or v_next.monthly_minutes>100000000
    or nullif(btrim(v_next.ai_model_id),'') is null or v_next.monthly_price is null or v_next.monthly_price<0
    or v_next.extra_phone_numbers is null or v_next.extra_phone_numbers<0 or v_next.extra_phone_numbers>20
    or v_next.pii_redaction_enabled is null or v_next.safety_guardrails_enabled is null
    then raise exception 'Invalid billing configuration'; end if;
  v_configuration := jsonb_build_object('plan_name',v_next.plan_name,'monthly_price',v_next.monthly_price,
    'monthly_minutes',v_next.monthly_minutes,'ai_model_id',v_next.ai_model_id,
    'pii_redaction_enabled',v_next.pii_redaction_enabled,'safety_guardrails_enabled',v_next.safety_guardrails_enabled,
    'extra_phone_numbers',v_next.extra_phone_numbers);
  v_current := jsonb_build_object('plan_name',v_old.plan_name,'monthly_price',v_old.monthly_price,
    'monthly_minutes',v_old.monthly_minutes,'ai_model_id',v_old.ai_model_id,
    'pii_redaction_enabled',v_old.pii_redaction_enabled,'safety_guardrails_enabled',v_old.safety_guardrails_enabled,
    'extra_phone_numbers',v_old.extra_phone_numbers);
  if p_configuration ? 'phone_number_country' then
    if p_configuration->>'phone_number_country' not in ('CA','US') then raise exception 'Invalid phone country'; end if;
    v_configuration := v_configuration || jsonb_build_object('phone_number_country',p_configuration->>'phone_number_country',
      'phone_number_area_code',p_configuration->>'phone_number_area_code');
  end if;
  if nullif(btrim(v_old.stripe_subscription_id),'') is null then
    return query update public.subscriptions set plan_name=v_next.plan_name,monthly_price=v_next.monthly_price,
      monthly_minutes=v_next.monthly_minutes,ai_model_id=v_next.ai_model_id,
      pii_redaction_enabled=v_next.pii_redaction_enabled,safety_guardrails_enabled=v_next.safety_guardrails_enabled,
      extra_phone_numbers=v_next.extra_phone_numbers,status='pending',rollover_seconds=0,
      current_period_start=null,current_period_end=null,next_billing_date=null,
      pending_configuration=v_configuration,configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  else
    -- Keep the original subscription, paid period and allowance intact, including
    -- cancelled/past-due state. Renewal cannot accidentally apply this quote.
    return query update public.subscriptions set
      pending_configuration=case when (v_configuration-'phone_number_country'-'phone_number_area_code')=v_current then null else v_configuration end,
      configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  end if;
end; $$;
revoke all on function public.configure_recepta_subscription(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.configure_recepta_subscription(uuid,jsonb) to service_role;


create or replace function public.reserve_recepta_agent_call(p_client_id uuid,p_call_id text,p_agent_id text)
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
  if v_subscription.status is distinct from 'active' or nullif(btrim(v_subscription.stripe_subscription_id),'') is null or v_subscription.current_period_start is null
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
    pending_configuration = case when p_configuration->>'quote_revision' = v_old.configuration_revision::text then null else v_old.pending_configuration end,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end, stripe_subscription_id = p_stripe_subscription_id,
    stripe_customer_id = p_customer_id, cancel_at_period_end = false
    where client_id = p_client_id returning *;
end;
$$;
revoke all on function public.activate_recepta_checkout(uuid,text,text,timestamptz,timestamptz,jsonb,text) from public,anon,authenticated;
grant execute on function public.activate_recepta_checkout(uuid,text,text,timestamptz,timestamptz,jsonb,text) to service_role;
