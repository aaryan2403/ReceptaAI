alter table public.subscriptions add column billing_failed_period_start timestamptz;

-- Record failures only for a cycle that has not already been paid. This update
-- shares the subscription row lock with renewals, cancellation and admission.
create function public.freeze_recepta_renewal(
  p_stripe_subscription_id text, p_period_start timestamptz,
  p_invoice_id text, p_due_at timestamptz
) returns setof public.subscriptions
language sql security invoker set search_path = '' as $$
  update public.subscriptions s set
    status = 'past_due', billing_failed_period_start = p_period_start,
    pro_invoice_due_at = coalesce(p_due_at, s.pro_invoice_due_at), pro_invoice_id = p_invoice_id
  where s.stripe_subscription_id = p_stripe_subscription_id
    and s.status <> 'cancelled'
    and (s.current_period_start is null or s.current_period_start < p_period_start)
    and (s.status <> 'past_due' or s.billing_failed_period_start is null
      or s.billing_failed_period_start <= p_period_start)
    and exists (select 1 from public.clients c where c.id = s.client_id and not c.deletion_pending)
  returning s.*;
$$;

revoke all on function public.freeze_recepta_renewal(text,timestamptz,text,timestamptz) from public,anon,authenticated;
grant execute on function public.freeze_recepta_renewal(text,timestamptz,text,timestamptz) to service_role;

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
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'Invalid billing period';
  end if;
  select * into v_subscription from public.subscriptions
    where stripe_subscription_id = p_stripe_subscription_id for update;
  if not found or v_subscription.status = 'cancelled' then return; end if;
  if exists(select 1 from public.clients where id=v_subscription.client_id and deletion_pending) then return; end if;
  if v_subscription.current_period_start > p_period_start
    or (v_subscription.status = 'past_due' and v_subscription.billing_failed_period_start > p_period_start) then
    return;
  end if;
  -- This period was already paid. Replays must never change its balance or
  -- reactivate it while a newer payment is still outstanding.
  if v_subscription.current_period_start = p_period_start then
    if v_subscription.current_period_end = p_period_end and v_subscription.status = 'active' then
      return next v_subscription;
    end if;
    return;
  end if;

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
    status = 'active', rollover_seconds = v_rollover, billing_failed_period_start = null,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end
    where client_id = v_subscription.client_id returning *;
end;
$$;
