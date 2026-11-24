-- Run only in Recepta Staging (mvufjeqxqvpcfqwmihpy), after the billing migration.
-- Use the SQL editor to run the entire file together. This uses fresh synthetic
-- rows, normal metering RPCs and real database time. ROLLBACK removes all rows.
begin;

do $$
declare
  client_id_test uuid := gen_random_uuid();
  marker text := client_id_test::text;
  stripe_id text := 'sub_synthetic_' || marker;
  agent_id text := 'agent_synthetic_' || marker;
  first_start timestamptz := statement_timestamp() - interval '2 months';
  second_start timestamptz := statement_timestamp() - interval '1 month';
  third_start timestamptz := statement_timestamp() - interval '5 minutes';
  third_end timestamptz := third_start + interval '1 month';
  r public.subscriptions%rowtype;
  hold record;
  call_seconds integer;
  call_number integer := 0;
  call_id text;
begin
  insert into auth.users(id, email) values (client_id_test, marker || '@example.invalid');
  insert into public.clients(id, company_name, status) values (client_id_test, 'Synthetic rollover test', 'live')
    on conflict (id) do update set status = excluded.status;
  insert into public.agents(client_id, retell_agent_id, status) values (client_id_test, agent_id, 'live');
  update public.subscriptions set stripe_subscription_id = stripe_id, status = 'active',
    plan_name = 'Recepta Standard', monthly_minutes = 100,
    current_period_start = first_start, current_period_end = second_start where client_id = client_id_test;
  if not found then
    insert into public.subscriptions(client_id, stripe_subscription_id, status, plan_name, monthly_minutes,
      current_period_start, current_period_end)
    values (client_id_test, stripe_id, 'active', 'Recepta Standard', 100, first_start, second_start);
  end if;

  insert into public.calls(client_id, retell_call_id, started_at, duration_seconds, call_status)
    values (client_id_test, marker || '-prior', first_start + interval '1 hour', 600, 'ended');
  select * into strict r from public.renew_recepta_subscription(stripe_id, second_start, third_start);
  if r.rollover_seconds <> 5400 then raise exception 'Expected 90 rollover minutes and 190 total'; end if;
  select * into strict r from public.renew_recepta_subscription(stripe_id, second_start, third_start);
  if r.rollover_seconds <> 5400 then raise exception 'A duplicate renewal changed the allocation'; end if;

  if exists (select 1 from public.reserve_recepta_agent_call(client_id_test, marker || '-expired', agent_id)) then
    raise exception 'Rollover allowed admission outside the paid period';
  end if;
  select * into strict r from public.freeze_recepta_renewal(stripe_id, third_start, 'in_synthetic_' || marker, third_start);
  if r.status <> 'past_due' or r.rollover_seconds <> 5400 then raise exception 'Renewal failure lost the frozen balance'; end if;
  if exists (select 1 from public.reserve_recepta_agent_call(client_id_test, marker || '-unpaid', agent_id)) then
    raise exception 'Unpaid renewal allowed admission';
  end if;
  if exists (select 1 from public.renew_recepta_subscription(stripe_id, second_start, third_start)) then
    raise exception 'Replay of the previous invoice restored access';
  end if;
  select * into strict r from public.renew_recepta_subscription(stripe_id, third_start, third_end);
  if r.status <> 'active' or r.rollover_seconds <> 6000 then
    raise exception 'Recovery should yield 100 monthly plus 100 rollover minutes and expire the older 90';
  end if;
  if exists (select 1 from public.freeze_recepta_renewal(stripe_id, third_start, 'in_synthetic_' || marker, third_start)) then
    raise exception 'An out-of-order failure changed the recovered cycle';
  end if;

  -- A terminal call write exercises the same database settlement trigger used by
  -- the signed Retell webhook. Use small elapsed intervals for deterministic keys.
  foreach call_seconds in array array[4500, 2700, 4740, 60] loop
    call_number := call_number + 1;
    call_id := marker || '-' || call_number;
    select * into strict hold from public.reserve_recepta_agent_call(client_id_test, call_id, agent_id);
    if hold.reserved_seconds < call_seconds then raise exception 'Call % was underfunded', call_number; end if;
    if call_number = 1 and
      (select reserved_seconds from public.reserve_recepta_agent_call(client_id_test, call_id, agent_id))
        is distinct from hold.reserved_seconds then
      raise exception 'Retell retry did not reuse the reservation';
    end if;
    insert into public.calls(client_id, retell_call_id, started_at, duration_seconds, call_status)
      values (client_id_test, call_id, third_start + call_number * interval '1 second', call_seconds, 'ended');
    if call_number = 1 and public.recepta_period_usage(client_id_test, third_start, third_end) <> 4500 then
      raise exception 'Terminal call duration was not recorded';
    end if;
    if call_number = 2 and (public.recepta_service_access(client_id_test, agent_id)->>'remaining_seconds')::integer <> 4800 then
      raise exception 'Expected 80 usable minutes after exceeding the 100-minute monthly-only threshold';
    end if;
  end loop;

  if public.recepta_period_usage(client_id_test, third_start, third_end) <> 12000
    or exists (select 1 from public.reserve_recepta_agent_call(client_id_test, marker || '-exhausted', agent_id)) then
    raise exception 'The combined 200-minute allowance was not enforced';
  end if;

  update public.subscriptions set status = 'cancelled', rollover_seconds = 0 where stripe_subscription_id = stripe_id;
  if exists (select 1 from public.renew_recepta_subscription(stripe_id, third_start, third_end)) then
    raise exception 'A replay reopened a cancelled and forfeited balance';
  end if;
end
$$;

rollback;

select 'PASS' as result, 'Staging PostgreSQL paid renewal, rollover, settlement, admission, payment recovery, replay and cancellation' as checks;
