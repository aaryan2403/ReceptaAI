-- Drop the retired setting without changing store schedules, including legacy
-- strings and arrays. Inbound admission also ignores it during rolling deploys.
update public.agents
set business_hours=(business_hours::jsonb-'answeringMode')::text
where case when pg_input_is_valid(business_hours,'jsonb')
  then jsonb_typeof(business_hours::jsonb)='object' and business_hours::jsonb ? 'answeringMode'
  else false end;

-- Failed payments suspend admission, including Pro. Keep the existing Pro
-- retention timeline for recovery and preserve the pauses set by administrators.
create or replace function public.recepta_service_access(p_client uuid,p_agent text default null)
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
  s public.subscriptions%rowtype;
  failed boolean:=a->>'billing_status'='past_due' and coalesce((a->>'has_stripe_subscription')::boolean,false);
  now_at timestamptz:=clock_timestamp();
begin
  -- Stripe can take time to finalize and collect its renewal invoice. Keep
  -- using the last paid balance while it processes. Reservations retain that
  -- cycle's start, so the paid renewal includes them when calculating rollover.
  if a->>'source'='stripe' and a->>'mode'='automatic' and a->>'billing_status'='active'
      and (a->>'has_stripe_subscription')::boolean and (a->>'assignment_valid')::boolean
      and a->>'phone_number' is not null and a->>'agent_status'='live'
      and coalesce((a->>'period_end')::timestamptz<=now_at+interval '2 hours',true)
      and coalesce(a->>'reason','') in ('ready','allowance_unavailable','billing_inactive')
      and (a->>'provisioning_status' is null or (a->>'provisioned_pro')::boolean) then
    select * into s from public.subscriptions where client_id=p_client;
    if s.status='active' and s.current_period_start<=now_at
        and s.current_period_end-interval '2 hours'<=now_at
        and s.current_period_end+interval '2 hours'>now_at
        and not s.cancel_at_period_end and s.provider_cancel_at is null and s.pro_cancelled_at is null
        and s.pro_invoice_due_at is null then
      allowance:=greatest(s.monthly_minutes,0)::bigint*60;
      allowance:=allowance+least(greatest(s.rollover_seconds,0),allowance);
      remaining:=greatest(allowance-public.recepta_committed_usage(p_client,s.current_period_start,s.current_period_end),0);
      end_at:=s.current_period_end+interval '2 hours';
      a:=a||jsonb_build_object('status','active',
        'reason',case when least(remaining,extract(epoch from end_at-now_at))<60 then 'allowance_unavailable' else 'ready' end,
        'period_start',s.current_period_start,'period_end',end_at,'remaining_seconds',remaining,
        'service_allowance_seconds',allowance,'call_cap',case when (a->>'demo_mode')::boolean then 180 else 7200 end,
        'can_reserve',true,'appointments',a->>'plan'='Recepta Pro');
    end if;
  end if;

  t:=public.recepta_pro_timeline(p_client);
  if a->>'plan' is distinct from 'Recepta Pro' and t->>'operation' is null and not coalesce(failed,false) then return a; end if;
  start_at:=(t->>'grace_start')::timestamptz;
  end_at:=(t->>'grace_end')::timestamptz;
  if t->>'operation' is not null then cause:='agent_'||(t->>'operation');
  elsif (t->>'held')::boolean then
    if coalesce(a->>'mode','automatic') not in ('suspended','pending','cancelled','paused') then cause:='admin_paused'; end if;
  elsif t->>'reason'='cancellation' then cause:='subscription_cancelled';
  elsif end_at<=now_at and not (t->>'paid')::boolean then cause:='payment_grace_expired';
  elsif failed then cause:='payment_failed';
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
