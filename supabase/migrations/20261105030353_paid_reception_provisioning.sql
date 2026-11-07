-- Non-idempotent provider writes are journaled before requests. Unknown results
-- require reconciliation, never blind duplicate creation.
create table public.phone_provisioning (
  client_id uuid primary key references public.clients(id) on delete cascade,
  state text not null default 'pending' check(state in ('pending','creating_llm','llm_ready','creating_agent','agent_ready','assigned')),
  llm_id text unique,
  agent_id text unique,
  number_state text not null default 'idle' check(number_state in ('idle','purchasing','received','review')),
  pending_number text,
  updated_at timestamptz not null default now()
);
alter table public.phone_provisioning enable row level security;
revoke all on public.phone_provisioning from public,anon,authenticated;
grant select,insert,update,delete on public.phone_provisioning to service_role;
create policy server_only on public.phone_provisioning to service_role using(true) with check(true);

create function public.assign_recepta_provisioned_agent(p_client_id uuid,p_agent_id text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.clients where id=p_client_id and not coalesce(deletion_pending,false) for update;
  if not found then raise exception 'Account unavailable.'; end if;
  if not exists(select 1 from public.phone_provisioning where client_id=p_client_id and agent_id=p_agent_id and state in ('agent_ready','assigned')) then raise exception 'Provisioned ownership is not confirmed.'; end if;
  if exists(select 1 from public.agents where client_id=p_client_id and retell_agent_id is not null and retell_agent_id<>p_agent_id) then raise exception 'An agent is already assigned.'; end if;
  insert into public.agents(client_id,retell_agent_id,status,demo_mode) values(p_client_id,p_agent_id,'setup',false)
    on conflict(client_id) do update set retell_agent_id=excluded.retell_agent_id,demo_mode=false;
end $$;
revoke all on function public.assign_recepta_provisioned_agent(uuid,text) from public,anon,authenticated;
grant execute on function public.assign_recepta_provisioned_agent(uuid,text) to service_role;

-- Index provider LLM ownership so routine updates need not scan the provider
-- workspace. Older assignments are discovered once using read-only API calls.
alter table public.agents add column retell_llm_id text;
create unique index recepta_dedicated_retell_llm on public.agents(retell_llm_id) where retell_llm_id is not null;
create function public.register_recepta_agent_llm(p_agent_id text,p_llm_id text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if p_llm_id is null or p_llm_id='' then raise exception 'Provider LLM is required.'; end if;
  update public.agents set retell_llm_id=p_llm_id where retell_agent_id=p_agent_id;
  if not found then raise exception 'Agent assignment unavailable.'; end if;
end $$;
revoke all on function public.register_recepta_agent_llm(text,text) from public,anon,authenticated;
grant execute on function public.register_recepta_agent_llm(text,text) to service_role;

create function public.recepta_inbound_number(p_number text)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.agents where public.recepta_normalized_phone(phone_number)=p_number)
    or exists(select 1 from public.agent_phone_numbers where public.recepta_normalized_phone(phone_number)=p_number);
$$;
revoke all on function public.recepta_inbound_number(text) from public,anon,authenticated;
grant execute on function public.recepta_inbound_number(text) to service_role;
