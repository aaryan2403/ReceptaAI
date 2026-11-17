-- Only the explicitly designated Recepta founder may admit unpaid inbound calls.
-- Keep Stripe records untouched. Normal client admission still requires payment.
-- Founder calls are metered through the existing reservation/settlement ledger:
-- at most 300 minutes per UTC calendar month and 15 minutes per call.
CREATE OR REPLACE FUNCTION public.reserve_recepta_agent_call(
  p_client_id uuid, p_call_id text, p_agent_id text
)
RETURNS TABLE(reservation_id uuid, reserved_seconds integer, demo_mode boolean)
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
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
  v_paid boolean;
  v_founder boolean;
  v_period_start timestamptz;
  v_period_end timestamptz;
begin
  if p_call_id is null or btrim(p_call_id) = '' or length(p_call_id) > 512
     or nullif(btrim(p_agent_id), '') is null then return; end if;

  -- Serialize paid and founder reservations for this same tenant.
  select * into v_subscription
    from public.subscriptions where client_id = p_client_id for update;
  if not found then return; end if;
  v_now := clock_timestamp();

  v_paid := v_subscription.status = 'active'
    and nullif(btrim(v_subscription.stripe_subscription_id), '') is not null
    and v_subscription.current_period_start is not null
    and v_subscription.current_period_end is not null
    and v_subscription.current_period_start <= v_now
    and v_subscription.current_period_end > v_now
    and coalesce(v_subscription.monthly_minutes, 0) >= 1;

  -- Never turn the pending subscription into a paid one, and never use this
  -- exception for any other client or Retell agent.
  v_founder := not v_paid
    and p_client_id = '72e5b432-2e97-4882-a30d-7c9f756c2fc2'::uuid
    and public.recepta_owner_booking_approved(p_client_id, p_agent_id);

  if not v_paid and not v_founder then return; end if;

  select a.demo_mode into v_demo from public.agents a
    where a.client_id = p_client_id
      and a.retell_agent_id = p_agent_id
      and (a.status in ('live', 'active')
        or (v_founder and a.status = 'setup'));
  if not found then return; end if;

  if v_founder then
    v_period_start := date_trunc('month', v_now, 'UTC');
    v_period_end := v_period_start + interval '1 month';
    v_allowance := 300 * 60;
  else
    v_period_start := v_subscription.current_period_start;
    v_period_end := v_subscription.current_period_end;
    v_monthly := v_subscription.monthly_minutes::bigint * 60;
    v_allowance := v_monthly
      + least(greatest(coalesce(v_subscription.rollover_seconds, 0), 0), v_monthly);
  end if;

  select * into v_existing from public.call_minute_reservations
    where retell_call_id = p_call_id;
  if found then
    if v_existing.client_id <> p_client_id then
      raise exception 'Retell call belongs to another client';
    end if;
    if v_existing.period_start = v_period_start and v_existing.status = 'active'
      and (v_existing.retell_agent_id is null or v_existing.retell_agent_id = p_agent_id)
      and not exists (
        select 1 from public.calls
        where client_id = p_client_id and retell_call_id = p_call_id
          and call_status in ('ended', 'error', 'not_connected')
      ) then
      return query select v_existing.id, v_existing.reserved_seconds, v_existing.demo_mode;
    end if;
    return;
  end if;

  if exists (
    select 1 from public.calls where retell_call_id = p_call_id
      and (client_id <> p_client_id or call_status in ('ended', 'error', 'not_connected'))
  ) then return; end if;

  v_remaining := greatest(
    v_allowance - public.recepta_committed_usage(
      p_client_id, v_period_start, v_period_end
    ), 0
  );
  -- Founder's individual calls are limited to 15 minutes; paid clients keep
  -- the existing 2-hour maximum and demo agents keep their 3-minute maximum.
  v_seconds := least(
    v_remaining,
    case when v_demo then 180 when v_founder then 900 else 7200 end,
    floor(extract(epoch from v_period_end - v_now))::bigint
  )::integer;
  if v_seconds < 60 then return; end if;

  insert into public.call_minute_reservations (
    client_id, retell_call_id, period_start, period_end, reserved_seconds,
    retell_agent_id, demo_mode
  ) values (
    p_client_id, p_call_id, v_period_start, v_period_end, v_seconds,
    p_agent_id, v_demo
  ) returning id into v_id;
  return query select v_id, v_seconds, v_demo;
end;
$function$;
