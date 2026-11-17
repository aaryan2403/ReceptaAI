-- A single founder-owned account may book appointments without a Stripe subscription.
-- No phone call allowance, Stripe record, inbound route or customer payment is altered.
create table public.recepta_owner_booking_grants (
  client_id uuid primary key references public.clients(id) on delete cascade,
  retell_agent_id text not null check (length(btrim(retell_agent_id)) between 3 and 200),
  granted_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz
);
-- No more than one unrevoked owner booking grant across the deployment.
create unique index recepta_single_owner_booking_grant
  on public.recepta_owner_booking_grants ((true)) where revoked_at is null;
alter table public.recepta_owner_booking_grants enable row level security;
revoke all on public.recepta_owner_booking_grants from public, anon, authenticated;
grant select, insert, update on public.recepta_owner_booking_grants to service_role;

-- Read-only, fail-closed check. Only the current unique agent assignment for
-- the granted client qualifies; unpaid Standard and other Pro accounts do not.
create function public.recepta_owner_booking_approved(p_client uuid, p_agent text default null)
returns boolean language sql stable security invoker set search_path = '' as $function$
  select exists (
    select 1 from public.recepta_owner_booking_grants g
    join public.clients c on c.id=g.client_id and not c.deletion_pending
    join public.subscriptions s on s.client_id=c.id
    join public.agents a on a.client_id=c.id and a.retell_agent_id=g.retell_agent_id
    where g.client_id=p_client and g.revoked_at is null
      and (p_agent is null or p_agent=g.retell_agent_id)
      and s.plan_name='Recepta Pro' and s.status='pending'
      and nullif(btrim(s.stripe_subscription_id),'') is null
      and (select count(*) from public.agents other where other.retell_agent_id=g.retell_agent_id)=1
  );
$function$;
revoke all on function public.recepta_owner_booking_approved(uuid,text) from public, anon, authenticated;
grant execute on function public.recepta_owner_booking_approved(uuid,text) to service_role;

-- Seed only the owner's explicitly approved testclient account and assigned
-- Retell agent. This has no effect on staging or any other client.
insert into public.recepta_owner_booking_grants (client_id, retell_agent_id)
select c.id, a.retell_agent_id
from public.clients c
join public.agents a on a.client_id=c.id
join public.subscriptions s on s.client_id=c.id
where c.id='72e5b432-2e97-4882-a30d-7c9f756c2fc2'::uuid
  and c.company_name='testclient'
  and a.retell_agent_id='agent_b1887f197b98684f92bfd97b3a'
  and s.plan_name='Recepta Pro' and s.status='pending'
  and nullif(btrim(s.stripe_subscription_id),'') is null and not c.deletion_pending
  and (select count(*) from public.agents other where other.retell_agent_id=a.retell_agent_id)=1
on conflict (client_id) do nothing;

-- Keep the existing paid and time-limited QA authorization paths intact.
CREATE OR REPLACE FUNCTION public.recepta_scheduling_access(p_client uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.clients c join public.subscriptions s on s.client_id=c.id
    where c.id=p_client and not c.deletion_pending and s.plan_name='Recepta Pro'
      and s.status='active' and nullif(btrim(s.stripe_subscription_id),'') is not null
      and s.current_period_start <= statement_timestamp() and s.current_period_end > statement_timestamp()
  ) or exists (
    select 1 from public.agents a
    where a.client_id=p_client and (public.recepta_appointment_test_check(p_client,a.retell_agent_id)->>'active')::boolean
  ) or public.recepta_owner_booking_approved(p_client, null);
$function$;

CREATE OR REPLACE FUNCTION public.recepta_authorize_appointment_tool(p_client uuid, p_agent text, p_call_id text, p_tool text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_grant public.recepta_appointment_test_grants; v_hash text; v_new boolean;
begin
  if p_client is null or nullif(btrim(p_agent),'') is null or nullif(btrim(p_call_id),'') is null
    or length(p_call_id)>200 or p_tool is null or p_tool not in (
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
  -- Owner booking is bound to the single approved client and assigned Retell agent.
  if public.recepta_owner_booking_approved(p_client, p_agent) then
    return '{"allowed":true,"mode":"owner"}'::jsonb;
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
end $function$;

revoke all on function public.recepta_scheduling_access(uuid) from public, anon, authenticated;
grant execute on function public.recepta_scheduling_access(uuid) to service_role;
revoke all on function public.recepta_authorize_appointment_tool(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.recepta_authorize_appointment_tool(uuid,text,text,text) to service_role;
