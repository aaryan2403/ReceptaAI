-- Internal appointment-only QA access, not a Stripe subscription or inbound-call entitlement.
-- No grants are inserted by this migration; an authenticated Recepta admin must explicitly create one.
create table public.recepta_appointment_test_grants (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'appointment_testing' check (scope = 'appointment_testing'),
  client_id uuid not null references public.clients(id) on delete cascade,
  retell_agent_id text not null check (length(btrim(retell_agent_id)) between 3 and 200),
  expires_at timestamptz not null,
  max_calls integer not null check (max_calls between 1 and 10),
  max_invocations integer not null check (max_invocations between 1 and 50),
  used_calls integer not null default 0 check (used_calls >= 0),
  used_invocations integer not null default 0 check (used_invocations >= 0),
  granted_by uuid not null,
  granted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by uuid,
  constraint test_grant_revocation check ((revoked_at is null) = (revoked_by is null))
);
-- Only one unrevoked grant in the whole project, including expired grants awaiting replacement.
create unique index recepta_single_appointment_test_grant
  on public.recepta_appointment_test_grants(scope) where revoked_at is null;

create table public.recepta_appointment_test_usage (
  id bigint generated always as identity primary key,
  grant_id uuid not null references public.recepta_appointment_test_grants(id) on delete cascade,
  call_hash text not null check (length(call_hash) = 32),
  tool_name text not null check (tool_name in (
    'recepta_check_availability','recepta_book_appointment','recepta_save_appointment_details')),
  used_at timestamptz not null default clock_timestamp()
);
create index recepta_appointment_test_usage_lookup
  on public.recepta_appointment_test_usage(grant_id, call_hash);

alter table public.recepta_appointment_test_grants enable row level security;
alter table public.recepta_appointment_test_usage enable row level security;
revoke all on public.recepta_appointment_test_grants, public.recepta_appointment_test_usage from public, anon, authenticated;
grant select, insert, update on public.recepta_appointment_test_grants to service_role;
grant select, insert on public.recepta_appointment_test_usage to service_role;
grant usage, select on sequence public.recepta_appointment_test_usage_id_seq to service_role;

-- A read-only check; never confuses temporary QA permission with payment or call admission.
create function public.recepta_appointment_test_check(p_client uuid, p_agent text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce((
    select jsonb_build_object(
      'active',true,
      'can_use',g.used_invocations < g.max_invocations,
      'expires_at',g.expires_at,
      'remaining_calls',greatest(g.max_calls-g.used_calls,0),
      'remaining_invocations',greatest(g.max_invocations-g.used_invocations,0))
    from public.recepta_appointment_test_grants g
    join public.clients c on c.id=g.client_id and not c.deletion_pending
    join public.subscriptions s on s.client_id=c.id
    where g.client_id=p_client and g.retell_agent_id=p_agent
      and p_agent is not null and g.revoked_at is null and g.expires_at > clock_timestamp()
      and s.plan_name='Recepta Pro' and s.status='pending'
      and nullif(btrim(s.stripe_subscription_id),'') is null
      and (select count(*) from public.agents a where a.retell_agent_id=p_agent and a.client_id=p_client)=1
      and (select count(*) from public.agents a where a.retell_agent_id=p_agent)=1
  ), '{"active":false,"can_use":false}'::jsonb);
$$;

-- Preserve paid Pro authorization exactly; add an independently audited appointment-only allowance.
create or replace function public.recepta_scheduling_access(p_client uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.clients c join public.subscriptions s on s.client_id=c.id
    where c.id=p_client and not c.deletion_pending and s.plan_name='Recepta Pro'
      and s.status='active' and nullif(btrim(s.stripe_subscription_id),'') is not null
      and s.current_period_start <= statement_timestamp() and s.current_period_end > statement_timestamp()
  ) or exists (
    select 1 from public.agents a
    where a.client_id=p_client and (public.recepta_appointment_test_check(p_client,a.retell_agent_id)->>'active')::boolean
  );
$$;

-- Serialized, server-only action authorization. Successful test actions consume a bounded slot
-- even when a later availability lookup or booking fails. No caller PII or raw call IDs are logged.
create function public.recepta_authorize_appointment_tool(
  p_client uuid, p_agent text, p_call_id text, p_tool text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_grant public.recepta_appointment_test_grants; v_hash text; v_new boolean;
begin
  if p_client is null or nullif(btrim(p_agent),'') is null or nullif(btrim(p_call_id),'') is null
    or length(p_call_id)>200 or p_tool not in (
      'recepta_check_availability','recepta_book_appointment','recepta_save_appointment_details')
    or (select count(*) from public.agents where client_id=p_client and retell_agent_id=p_agent) <> 1
    or (select count(*) from public.agents where retell_agent_id=p_agent) <> 1
    or not exists (select 1 from public.clients where id=p_client and not deletion_pending) then
    return '{"allowed":false,"reason":"invalid_assignment"}'::jsonb;
  end if;
  if exists (
    select 1 from public.subscriptions s where s.client_id=p_client
    and s.plan_name='Recepta Pro' and s.status='active'
    and nullif(btrim(s.stripe_subscription_id),'') is not null
    and s.current_period_start<=statement_timestamp() and s.current_period_end>statement_timestamp()
  ) then
    return '{"allowed":true,"mode":"paid"}'::jsonb;
  end if;
  select g.* into v_grant from public.recepta_appointment_test_grants g
    join public.subscriptions s on s.client_id=g.client_id
    where g.client_id=p_client and g.retell_agent_id=p_agent and g.revoked_at is null
    and g.expires_at>clock_timestamp() and s.plan_name='Recepta Pro' and s.status='pending'
    and nullif(btrim(s.stripe_subscription_id),'') is null
    for update of g;
  if not found then return '{"allowed":false,"reason":"no_test_entitlement"}'::jsonb; end if;
  v_hash := md5(p_call_id);
  select not exists (
    select 1 from public.recepta_appointment_test_usage
      where grant_id=v_grant.id and call_hash=v_hash
  ) into v_new;
  if v_grant.used_invocations >= v_grant.max_invocations or
    (v_new and v_grant.used_calls >= v_grant.max_calls) then
    return '{"allowed":false,"reason":"test_limit_exhausted"}'::jsonb;
  end if;
  update public.recepta_appointment_test_grants
    set used_invocations=used_invocations+1, used_calls=used_calls+case when v_new then 1 else 0 end
    where id=v_grant.id;
  insert into public.recepta_appointment_test_usage(grant_id,call_hash,tool_name)
    values (v_grant.id,v_hash,p_tool);
  return jsonb_build_object('allowed',true,'mode','internal_test',
    'remaining_calls',v_grant.max_calls-v_grant.used_calls-case when v_new then 1 else 0 end,
    'remaining_invocations',v_grant.max_invocations-v_grant.used_invocations-1);
end $$;

-- Explicit administrator action is required. These RPCs are callable only by a trusted
-- server-side service_role handler after Supabase verifies the ADMIN_EMAIL account session.
create function public.recepta_grant_appointment_test(
  p_client uuid, p_agent text, p_expires_at timestamptz,
  p_max_calls integer, p_max_invocations integer, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_grant public.recepta_appointment_test_grants;
begin
  if p_actor is null or p_client is null or nullif(btrim(p_agent),'') is null
    or p_expires_at is null or p_expires_at < clock_timestamp()+interval '15 minutes'
    or p_expires_at > clock_timestamp()+interval '48 hours'
    or p_max_calls not between 1 and 10 or p_max_invocations not between p_max_calls and 50
    or (select count(*) from public.agents where client_id=p_client and retell_agent_id=p_agent)<>1
    or (select count(*) from public.agents where retell_agent_id=p_agent)<>1
    or not exists (select 1 from public.clients where id=p_client and not deletion_pending)
    or not exists (
      select 1 from public.subscriptions where client_id=p_client and plan_name='Recepta Pro'
        and status='pending' and nullif(btrim(stripe_subscription_id),'') is null
    ) then
    raise exception 'Invalid appointment test grant request' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(314159265);
  update public.recepta_appointment_test_grants
    set revoked_at=clock_timestamp(), revoked_by=p_actor where revoked_at is null;
  insert into public.recepta_appointment_test_grants
    (client_id,retell_agent_id,expires_at,max_calls,max_invocations,granted_by)
  values (p_client,p_agent,p_expires_at,p_max_calls,p_max_invocations,p_actor)
  returning * into v_grant;
  return jsonb_build_object('id',v_grant.id,'client_id',v_grant.client_id,
    'retell_agent_id',v_grant.retell_agent_id,'expires_at',v_grant.expires_at,
    'max_calls',v_grant.max_calls,'max_invocations',v_grant.max_invocations);
end $$;

create function public.recepta_revoke_appointment_test(
  p_client uuid, p_agent text, p_actor uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
  if p_actor is null or p_client is null or nullif(btrim(p_agent),'') is null then
    raise exception 'Client, agent, and administrator are required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(314159265);
  update public.recepta_appointment_test_grants
    set revoked_at=clock_timestamp(),revoked_by=p_actor
  where client_id=p_client and retell_agent_id=p_agent and revoked_at is null
  returning id into v_id;
  return v_id is not null;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'recepta_appointment_test_check(uuid,text)',
    'recepta_authorize_appointment_tool(uuid,text,text,text)',
    'recepta_grant_appointment_test(uuid,text,timestamptz,integer,integer,uuid)',
    'recepta_revoke_appointment_test(uuid,text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;
