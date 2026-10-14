-- One call, one reservation, one duration cap. Paid limits come from the locked
-- subscription row, never from a caller-supplied allowance or billing period.
alter table public.call_minute_reservations
  add column retell_call_id text,
  add column period_end timestamptz;
alter table public.call_minute_reservations
  drop constraint call_minute_reservations_reserved_seconds_check,
  add constraint call_minute_reservations_reserved_seconds_check
    check (reserved_seconds >= 60 and (retell_call_id is null or reserved_seconds <= 180));
create unique index call_minute_reservations_retell_call_id_key
  on public.call_minute_reservations(retell_call_id) where retell_call_id is not null;

-- Attribute a reserved call to the cycle that funded it, even if its final event
-- arrives after renewal. Ordinary/unreserved calls retain timestamp attribution.
create or replace function public.recepta_period_usage(
  p_client_id uuid, p_period_start timestamptz, p_period_end timestamptz
) returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce(sum(greatest(c.duration_seconds,0)),0)::bigint
  from public.calls c left join public.call_minute_reservations r
    on r.client_id=c.client_id and r.retell_call_id=c.retell_call_id
  where c.client_id=p_client_id and (
    r.period_start=p_period_start or (r.id is null and
      c.started_at >= p_period_start and c.started_at < p_period_end));
$$;

-- Admission and rollover use a single snapshot of actual usage plus outstanding
-- commitments. A missing/expired webhook is not proof that a call used no time.
-- Dashboard repair can settle the same hold by saving the terminal call record.
create function public.recepta_committed_usage(
  p_client_id uuid, p_period_start timestamptz, p_period_end timestamptz
) returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce(sum(amount),0)::bigint from (
    select greatest(c.duration_seconds,0)::bigint as amount
    from public.calls c left join public.call_minute_reservations r
      on r.client_id=c.client_id and r.retell_call_id=c.retell_call_id
    where c.client_id=p_client_id and (
      r.period_start=p_period_start or (r.id is null and
        c.started_at >= p_period_start and c.started_at < p_period_end))
    union all
    select greatest(greatest(r.reserved_seconds,coalesce(r.used_seconds,0))
      - greatest(coalesce(c.duration_seconds,0),0),0)::bigint
    from public.call_minute_reservations r left join public.calls c
      on c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
    where r.client_id=p_client_id and r.period_start=p_period_start
      and (c.call_status is null or c.call_status not in ('ended','error','not_connected'))
  ) commitments;
$$;

create function public.reserve_recepta_inbound_call(p_client_id uuid,p_call_id text)
returns table(reservation_id uuid,reserved_seconds integer)
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
begin
  if p_call_id is null or btrim(p_call_id)='' or length(p_call_id)>512 then return; end if;
  -- This also serializes admission with paid renewals and Checkout activation.
  select * into v_subscription from public.subscriptions where client_id=p_client_id for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if v_subscription.status is distinct from 'active' or v_subscription.current_period_start is null
    or v_subscription.current_period_end is null or v_subscription.current_period_start>v_now
    or v_subscription.current_period_end<=v_now or coalesce(v_subscription.monthly_minutes,0)<1 then return; end if;

  select * into v_existing from public.call_minute_reservations where retell_call_id=p_call_id;
  if found then
    if v_existing.client_id<>p_client_id then raise exception 'Retell call belongs to another client'; end if;
    if v_existing.period_start=v_subscription.current_period_start and v_existing.status='active'
      and not exists(select 1 from public.calls where client_id=p_client_id and retell_call_id=p_call_id
        and call_status in ('ended','error','not_connected')) then
      return query select v_existing.id,v_existing.reserved_seconds;
    end if;
    return;
  end if;
  if exists(select 1 from public.calls where retell_call_id=p_call_id
    and (client_id<>p_client_id or call_status in ('ended','error','not_connected'))) then return; end if;

  v_monthly := v_subscription.monthly_minutes::bigint*60;
  v_allowance := v_monthly + least(greatest(coalesce(v_subscription.rollover_seconds,0),0),v_monthly);
  v_remaining := greatest(v_allowance-public.recepta_committed_usage(p_client_id,
    v_subscription.current_period_start,v_subscription.current_period_end),0);
  -- Retell accepts a minimum duration of 60s. Never reserve beyond its call cap,
  -- the remaining allowance, or the remaining paid period.
  v_seconds := least(v_remaining,180,floor(extract(epoch from v_subscription.current_period_end-v_now))::bigint)::integer;
  if v_seconds<60 then return; end if;
  insert into public.call_minute_reservations(client_id,retell_call_id,period_start,period_end,reserved_seconds)
    values(p_client_id,p_call_id,v_subscription.current_period_start,v_subscription.current_period_end,v_seconds)
    returning id into v_id;
  return query select v_id,v_seconds;
end; $$;

-- Retire the unkeyed API; a stale deployment cannot reserve a second hold or
-- supply its own paid allowance. Returning no reservation declines that call.
create or replace function public.reserve_recepta_call(
  p_client_id uuid,p_monthly_seconds bigint,p_period_start timestamptz
) returns table(reservation_id uuid,reserved_seconds integer)
language sql security invoker set search_path='' as $$
  select null::uuid,null::integer where false;
$$;

-- Call write and reservation settlement share one transaction. This covers both
-- signed lifecycle events and provider repairs, including missing metadata.
create function public.settle_recepta_call_reservation() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.retell_call_id is not null and new.call_status in ('ended','error','not_connected') then
    update public.call_minute_reservations set status='completed',
      used_seconds=greatest(coalesce(used_seconds,0),new.duration_seconds,0),
      completed_at=coalesce(completed_at,new.ended_at,now())
    where client_id=new.client_id and retell_call_id=new.retell_call_id;
  end if;
  return new;
end; $$;
create trigger settle_recepta_call_reservation after insert or update on public.calls
  for each row execute function public.settle_recepta_call_reservation();

-- Reconcile any keyed rows already containing a terminal call.
update public.call_minute_reservations r set status='completed',
  used_seconds=greatest(coalesce(r.used_seconds,0),c.duration_seconds,0),
  completed_at=coalesce(r.completed_at,c.ended_at,now())
from public.calls c where c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
  and c.call_status in ('ended','error','not_connected');

create or replace function public.renew_recepta_subscription(
  p_stripe_subscription_id text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns setof public.subscriptions
language plpgsql security invoker set search_path = ''
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
      v_used := public.recepta_committed_usage(v_subscription.client_id,
        v_subscription.current_period_start,p_period_start);
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

revoke all on function public.recepta_period_usage(uuid,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.recepta_committed_usage(uuid,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.reserve_recepta_inbound_call(uuid,text) from public,anon,authenticated;
revoke all on function public.reserve_recepta_call(uuid,bigint,timestamptz) from public,anon,authenticated;
revoke all on function public.settle_recepta_call_reservation() from public,anon,authenticated;
grant execute on function public.recepta_period_usage(uuid,timestamptz,timestamptz) to service_role;
grant execute on function public.recepta_committed_usage(uuid,timestamptz,timestamptz) to service_role;
grant execute on function public.reserve_recepta_inbound_call(uuid,text) to service_role;
grant execute on function public.reserve_recepta_call(uuid,bigint,timestamptz) to service_role;
grant execute on function public.settle_recepta_call_reservation() to service_role;
