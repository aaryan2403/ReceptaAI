-- Run after supabase_add_minute_enforcement.sql. Safe to run again.
begin;

alter table public.subscriptions
  add column if not exists rollover_seconds bigint not null default 0
  check (rollover_seconds >= 0);
alter table public.subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;

create table if not exists public.billing_notifications (
  notification_key text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('renewal_reminder', 'payment_success', 'payment_failed', 'usage_80', 'usage_100')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_attempt_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
alter table public.billing_notifications enable row level security;
revoke all on public.billing_notifications from public, anon, authenticated;
grant select, insert, update, delete on public.billing_notifications to service_role;
create index if not exists billing_notifications_pending_idx
  on public.billing_notifications(created_at) where sent_at is null;
create index if not exists calls_client_period_idx
  on public.calls(client_id, started_at);

-- Supabase also grants these roles directly through default privileges.
-- Revoking PUBLIC alone does not remove those explicit grants.
revoke all on public.call_minute_reservations from public, anon, authenticated;
grant select, insert, update, delete on public.call_minute_reservations to service_role;
revoke all on function public.reserve_recepta_call(uuid, bigint, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reserve_recepta_call(uuid, bigint, timestamptz) to service_role;

-- Serialize renewals, sum every call (no API row limit), and ignore old invoices.
create or replace function public.renew_recepta_subscription(
  p_stripe_subscription_id text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns setof public.subscriptions
language plpgsql security definer set search_path = public
as $$
declare
  v_subscription public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then
    raise exception 'Invalid billing period';
  end if;
  select * into v_subscription from public.subscriptions
    where stripe_subscription_id = p_stripe_subscription_id for update;
  if not found then return; end if;
  if v_subscription.current_period_start > p_period_start then return; end if;
  if v_subscription.current_period_start = p_period_start
    and v_subscription.current_period_end <> p_period_end then return; end if;

  v_monthly := greatest(coalesce(v_subscription.monthly_minutes, 0), 0)::bigint * 60;
  v_rollover := least(greatest(coalesce(v_subscription.rollover_seconds, 0), 0), v_monthly);
  if v_subscription.current_period_start < p_period_start then
    -- A gap in paid cycles forfeits the old allowance. Only a consecutive
    -- paid renewal can carry minutes into the new cycle.
    if v_subscription.current_period_end = p_period_start then
      select coalesce(sum(greatest(duration_seconds, 0)), 0) into v_used
        from public.calls where client_id = v_subscription.client_id
        and started_at >= v_subscription.current_period_start
        and started_at < p_period_start;
      v_rollover := greatest(v_monthly - greatest(v_used - v_rollover, 0), 0);
    else
      v_rollover := 0;
    end if;
  elsif v_subscription.current_period_start is null then
    v_rollover := 0;
  end if;

  return query update public.subscriptions set
    status = 'active', rollover_seconds = v_rollover,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end
    where client_id = v_subscription.client_id returning *;
end;
$$;
revoke all on function public.renew_recepta_subscription(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.renew_recepta_subscription(text, timestamptz, timestamptz) to service_role;

-- A paid Checkout starts a new billing cycle. Replayed Checkout events must
-- never reset usage or overwrite a newer subscription.
create or replace function public.activate_recepta_checkout(
  p_client_id uuid, p_stripe_subscription_id text, p_customer_id text,
  p_period_start timestamptz, p_period_end timestamptz,
  p_configuration jsonb, p_replaces_subscription_id text default null
)
returns setof public.subscriptions
language plpgsql security definer set search_path = public
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
    select coalesce(sum(greatest(duration_seconds, 0)), 0) into v_used
      from public.calls where client_id = p_client_id
      and started_at >= v_old.current_period_start and started_at < p_period_start;
    v_monthly := greatest(coalesce(v_old.monthly_minutes, 0), 0)::bigint * 60;
    v_rollover := least(
      greatest(v_monthly - greatest(v_used - least(coalesce(v_old.rollover_seconds, 0), v_monthly), 0), 0),
      greatest(coalesce(v_next.monthly_minutes, 0), 0)::bigint * 60
    );
  end if;
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
revoke all on function public.activate_recepta_checkout(uuid, text, text, timestamptz, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.activate_recepta_checkout(uuid, text, text, timestamptz, timestamptz, jsonb, text) to service_role;

create or replace function public.recepta_period_usage(
  p_client_id uuid, p_period_start timestamptz, p_period_end timestamptz
)
returns bigint language sql stable security definer set search_path = public
as $$
  select coalesce(sum(greatest(duration_seconds, 0)), 0)::bigint
  from public.calls where client_id = p_client_id
    and started_at >= p_period_start and started_at < p_period_end;
$$;
revoke all on function public.recepta_period_usage(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.recepta_period_usage(uuid, timestamptz, timestamptz) to service_role;

create or replace function public.claim_recepta_billing_notifications(p_limit integer default 5)
returns setof public.billing_notifications
language sql security definer set search_path = public
as $$
  update public.billing_notifications set last_attempt_at = now(), attempts = attempts + 1
  where notification_key in (
    select notification_key from public.billing_notifications
    where sent_at is null and (last_attempt_at is null or last_attempt_at < now() - interval '10 minutes')
    order by coalesce(last_attempt_at, created_at), created_at
    for update skip locked limit least(greatest(p_limit, 1), 5)
  ) returning *;
$$;
revoke all on function public.claim_recepta_billing_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_recepta_billing_notifications(integer) to service_role;

comment on column public.subscriptions.rollover_seconds is
  'Previous-cycle minutes used first. They expire at current_period_end; only unused new monthly minutes carry into a consecutive paid cycle.';
commit;
