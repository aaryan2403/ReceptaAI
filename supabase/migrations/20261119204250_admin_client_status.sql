-- Persist administrative plan and agent status independently of Stripe and
-- its provisioning state. Existing rows are preserved.
alter table public.recepta_service_overrides
  drop constraint recepta_service_overrides_mode_check,
  drop constraint recepta_service_overrides_check,
  add column plan_override text check (plan_override in ('Recepta Standard', 'Recepta Pro')),
  add column agent_status text check (agent_status in ('setup', 'testing', 'live', 'paused')),
  add column status_agent_id text,
  add column grant_mode text check (grant_mode in ('manual', 'internal_test')),
  add constraint recepta_service_mode_check check (mode in ('automatic', 'manual', 'internal_test', 'pending', 'paused', 'suspended', 'cancelled')),
  add constraint recepta_service_status_assignment_check check (
    (status_agent_id is not null) = coalesce(agent_status in ('testing', 'live'), false)
  );

update public.recepta_service_overrides set grant_mode = mode, plan_override = plan_name where grant_id is not null;

alter table public.recepta_service_overrides add constraint recepta_service_grant_check check (
  (mode not in ('manual', 'internal_test') or (grant_mode is not null and mode = grant_mode))
  and case when grant_id is not null then
    grant_mode is not null and retell_agent_id is not null and plan_name is not null
    and reason is not null and length(btrim(reason)) between 1 and 1000
    and started_at is not null and max_minutes is not null
    and (expires_at is not null or grant_mode = 'manual')
    and (expires_at is null or (isfinite(expires_at) and expires_at > started_at))
  else grant_mode is null and retell_agent_id is null and plan_name is null and reason is null
    and started_at is null and expires_at is null and max_minutes is null end
);

alter table public.recepta_service_access_audit
  drop constraint recepta_service_access_audit_action_check,
  add constraint recepta_service_action_check check (action in ('save', 'activate_test', 'pause', 'revoke', 'activate', 'deactivate', 'reactivate'));

create function public.recepta_service_grant_usage(p_grant uuid, p_period_start timestamptz)
returns bigint language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(case when status = 'completed' then coalesce(used_seconds, reserved_seconds)
    else greatest(reserved_seconds, coalesce(used_seconds, 0)) end), 0)::bigint
  from public.call_minute_reservations where service_grant_id = p_grant and period_start = p_period_start;
$$;

create or replace function public.recepta_service_access(p_client uuid, p_agent text default null)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_client public.clients%rowtype;
  v_sub public.subscriptions%rowtype;
  v_agent public.agents%rowtype;
  v_override public.recepta_service_overrides%rowtype;
  v_assigned boolean;
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
  v_paid := coalesce(v_sub.status = 'active' and nullif(btrim(v_sub.stripe_subscription_id), '') is not null
    and v_sub.current_period_start <= v_now and v_sub.current_period_end > v_now, false);

  if v_mode in ('paused', 'pending', 'suspended', 'cancelled') then
    v_source := 'manual_admin';
    v_state := v_mode;
    v_reason := v_mode;
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
  elsif v_paid then
    v_state := 'active';
    v_appointments := v_plan = 'Recepta Pro' and (p_agent is null or v_assigned);
    v_start := v_sub.current_period_start;
    v_end := v_sub.current_period_end;
    v_allowance := greatest(coalesce(v_sub.monthly_minutes, 0), 0)::bigint * 60;
    v_allowance := v_allowance + least(greatest(coalesce(v_sub.rollover_seconds, 0), 0), v_allowance);
    v_remaining := greatest(v_allowance - public.recepta_committed_usage(p_client, v_start, v_end), 0);
    v_call_cap := 7200;
    v_calls := v_assigned and v_agent_ready;
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
      v_remaining := greatest(18000 - public.recepta_committed_usage(p_client, v_start, v_end), 0);
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
    'billing_status', v_sub.status, 'billing_plan', v_sub.plan_name, 'billing_current', v_paid,
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
    'demo_mode', coalesce(v_agent.demo_mode, false), 'grant_id', case when v_using_grant then v_override.grant_id end,
    'expires_at', case when v_using_grant then v_override.expires_at end,
    'saved_grant_mode', v_override.grant_mode,
    'saved_grant_expires_at', v_override.expires_at, 'max_minutes', v_override.max_minutes,
    'configured_minutes', v_sub.monthly_minutes,
    'admin_reason', v_override.reason, 'updated_at', v_override.updated_at, 'updated_by', v_override.updated_by,
    'revision', coalesce(v_override.revision, 0), 'legacy_founder', v_founder, 'legacy_appointment_test', v_legacy_test, 'legacy_test_usable', coalesce((v_test_check->>'can_use')::boolean, false)
  );
end;
$$;

create function public.recepta_manage_client_service(
  p_client uuid, p_actor uuid, p_action text, p_mode text, p_plan text,
  p_agent text, p_reason text, p_expires_at timestamptz, p_max_minutes integer, p_revision integer,
  p_agent_status text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_sub public.subscriptions%rowtype;
  v_previous public.recepta_service_overrides%rowtype;
  v_next public.recepta_service_overrides%rowtype;
  v_before jsonb;
  v_mode text;
  v_enabling boolean := coalesce(p_action in ('activate', 'reactivate'), false);
  v_agent_status text;
begin
  if p_actor is null or p_action is null or p_action not in ('save', 'activate_test', 'pause', 'revoke', 'activate', 'deactivate', 'reactivate') then
    raise exception 'Invalid service action.' using errcode = '22023';
  end if;
  v_mode := case p_action when 'activate_test' then 'internal_test' when 'pause' then 'paused'
    when 'deactivate' then 'paused' when 'revoke' then 'pending' else p_mode end;
  v_agent_status := case when v_enabling then 'live' else p_agent_status end;
  if v_mode is null or v_mode not in ('automatic', 'manual', 'internal_test', 'pending', 'paused', 'suspended', 'cancelled')
      or (v_enabling and v_mode not in ('automatic', 'manual', 'internal_test'))
      or (p_plan is not null and p_plan not in ('Recepta Standard', 'Recepta Pro'))
      or (v_agent_status is not null and v_agent_status not in ('setup', 'testing', 'live', 'paused')) then
    raise exception 'Select valid service, plan and agent settings.' using errcode = '22023';
  end if;

  -- Share the billing row lock with call reservation and Stripe. The client row
  -- also provides a lock for clients that have no billing configuration yet.
  perform 1 from public.clients where id = p_client and not deletion_pending for no key update;
  if not found then raise exception 'The client is unavailable.' using errcode = 'P0002'; end if;
  select * into v_sub from public.subscriptions where client_id = p_client for update;
  select * into v_previous from public.recepta_service_overrides where client_id = p_client;
  if p_revision is distinct from coalesce(v_previous.revision, 0) then
    raise exception 'Service settings changed. Refresh and try again.' using errcode = '40001';
  end if;

  v_before := public.recepta_service_access(p_client);
  if v_enabling and v_mode = 'automatic' and (v_before->>'billing_current')::boolean is distinct from true then
    raise exception 'Automatic activation requires a current Stripe payment. Select manual authorization for this client.' using errcode = '22023';
  end if;

  v_now := clock_timestamp();
  v_next := v_previous;
  v_next.client_id := p_client;
  v_next.mode := v_mode;
  v_next.revision := coalesce(v_previous.revision, 0) + 1;
  v_next.updated_at := v_now;
  v_next.updated_by := p_actor;
  v_next.plan_override := p_plan;
  v_next.agent_status := v_agent_status;
  v_next.status_agent_id := case when v_agent_status in ('live', 'testing') then p_agent end;

  if v_mode in ('manual', 'internal_test') or v_agent_status in ('live', 'testing') then
    perform 1 from public.agents where client_id = p_client and retell_agent_id = p_agent for share;
    if not found or (select count(*) from public.agents where retell_agent_id = p_agent) <> 1 then
      raise exception 'The saved Retell agent must belong only to this client.' using errcode = '22023';
    end if;
  end if;

  if v_mode in ('manual', 'internal_test') then
    if coalesce(length(btrim(p_reason)), 0) not between 1 and 1000
        or (p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at <= v_now))
        or (v_mode = 'internal_test' and (p_expires_at is null or coalesce(p_max_minutes, 0) not between 1 and 100000000))
        or (v_mode = 'manual' and coalesce(nullif(v_sub.monthly_minutes, 0), p_max_minutes, 0) not between 1 and 100000000) then
      raise exception 'Provide an authorization reason and a valid allowance. Temporary access requires a future expiration.' using errcode = '22023';
    end if;
    v_next.retell_agent_id := p_agent;
    v_next.plan_name := coalesce(p_plan, v_sub.plan_name, 'Recepta Standard');
    v_next.reason := btrim(p_reason);
    v_next.expires_at := p_expires_at;
    v_next.grant_mode := v_mode;
    v_next.max_minutes := case when v_mode = 'internal_test' then p_max_minutes
      else coalesce(nullif(v_sub.monthly_minutes, 0), p_max_minutes) end;
    -- Keep the same usage balance when editing, pausing or resuming a grant.
    if v_previous.retell_agent_id is distinct from p_agent or v_previous.grant_mode is distinct from v_mode
        or (v_previous.expires_at is null) <> (p_expires_at is null) or v_previous.expires_at <= v_now then
      v_next.grant_id := gen_random_uuid();
      v_next.started_at := v_now;
    end if;
  elsif p_action = 'revoke' then
    v_next.grant_id := null;
    v_next.grant_mode := null;
    v_next.retell_agent_id := null;
    v_next.plan_name := null;
    v_next.reason := null;
    v_next.started_at := null;
    v_next.expires_at := null;
    v_next.max_minutes := null;
  end if;

  insert into public.recepta_service_overrides select (v_next).*
  on conflict (client_id) do update set
    mode = excluded.mode, revision = excluded.revision, grant_id = excluded.grant_id,
    retell_agent_id = excluded.retell_agent_id, plan_name = excluded.plan_name, reason = excluded.reason,
    started_at = excluded.started_at, expires_at = excluded.expires_at, max_minutes = excluded.max_minutes,
    grant_mode = excluded.grant_mode, plan_override = excluded.plan_override,
    agent_status = excluded.agent_status, status_agent_id = excluded.status_agent_id,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  insert into public.recepta_service_access_audit(client_id, actor_id, action, occurred_at, previous_state, new_state)
  values (p_client, p_actor, p_action, v_now, v_before, public.recepta_service_access(p_client));
  return public.recepta_service_access(p_client);
end;
$$;

-- Preserve the deployed admin RPC shape for older previews and callers.
create or replace function public.recepta_save_service_access(
  p_client uuid, p_actor uuid, p_action text, p_mode text, p_plan text,
  p_agent text, p_reason text, p_expires_at timestamptz, p_max_minutes integer, p_revision integer
)
returns jsonb language sql security invoker set search_path = '' as $$
  select public.recepta_manage_client_service(p_client, p_actor, p_action, p_mode,
    case when p_action = 'save' and p_mode = 'automatic' then null else coalesce(p_plan, o.plan_override) end,
    coalesce(p_agent, o.status_agent_id), p_reason, p_expires_at, p_max_minutes, p_revision, o.agent_status)
  from (select p_client as client_id) c left join public.recepta_service_overrides o using (client_id);
$$;

revoke all on function public.recepta_service_grant_usage(uuid,timestamptz),
  public.recepta_manage_client_service(uuid,uuid,text,text,text,text,text,timestamptz,integer,integer,text)
  from public, anon, authenticated;
grant execute on function public.recepta_service_grant_usage(uuid,timestamptz),
  public.recepta_manage_client_service(uuid,uuid,text,text,text,text,text,timestamptz,integer,integer,text)
  to service_role;

create or replace function public.reserve_recepta_agent_call(p_client_id uuid, p_call_id text, p_agent_id text)
returns table(reservation_id uuid, reserved_seconds integer, demo_mode boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.call_minute_reservations%rowtype;
  v_access jsonb;
  v_start timestamptz;
  v_end timestamptz;
  v_grant uuid;
  v_seconds integer;
  v_id uuid;
  v_demo boolean;
begin
  if nullif(btrim(p_call_id), '') is null or length(p_call_id) > 512
     or nullif(btrim(p_agent_id), '') is null then return; end if;
  perform 1 from public.subscriptions where client_id = p_client_id for update;
  if not found then
    perform 1 from public.clients where id = p_client_id for no key update;
    if not found then return; end if;
  end if;
  v_access := public.recepta_service_access(p_client_id, p_agent_id);
  if (v_access->>'can_reserve')::boolean is distinct from true then return; end if;
  v_start := (v_access->>'period_start')::timestamptz;
  v_end := (v_access->>'period_end')::timestamptz;
  v_grant := (v_access->>'grant_id')::uuid;
  v_demo := (v_access->>'demo_mode')::boolean;

  select * into v_existing from public.call_minute_reservations where retell_call_id = p_call_id;
  if found then
    if v_existing.client_id <> p_client_id then raise exception 'Retell call belongs to another client'; end if;
    if v_existing.period_start = v_start and v_existing.status = 'active'
      and v_existing.service_grant_id is not distinct from v_grant
      and (v_existing.retell_agent_id is null or v_existing.retell_agent_id = p_agent_id)
      and not exists (select 1 from public.calls where client_id = p_client_id and retell_call_id = p_call_id
        and call_status in ('ended','error','not_connected')) then
      v_seconds := least(v_existing.reserved_seconds, floor(extract(epoch from v_end - clock_timestamp()))::bigint);
      if v_seconds >= 60 then return query select v_existing.id, v_seconds, v_existing.demo_mode; end if;
    end if;
    return;
  end if;

  if exists (select 1 from public.calls where retell_call_id = p_call_id
    and (client_id <> p_client_id or call_status in ('ended','error','not_connected'))) then return; end if;
  v_seconds := least((v_access->>'remaining_seconds')::bigint, (v_access->>'call_cap')::integer,
    floor(extract(epoch from v_end - clock_timestamp()))::bigint);
  if v_seconds < 60 then return; end if;

  insert into public.call_minute_reservations (
    client_id, retell_call_id, period_start, period_end, reserved_seconds, retell_agent_id, demo_mode, service_grant_id
  ) values (p_client_id, p_call_id, v_start, v_end, v_seconds, p_agent_id, v_demo, v_grant)
  returning id into v_id;
  return query select v_id, v_seconds, v_demo;
end;
$$;

