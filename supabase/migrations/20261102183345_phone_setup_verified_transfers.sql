-- Staged only: apply to an isolated test database before enabling the feature.
-- Authorization and verification records are never stored in editable user_metadata.
-- Existing conflicting assignments must be reviewed before release, never
-- silently moved. The application also checks ownership before provider writes.
create unique index recepta_dedicated_retell_agent on public.agents(retell_agent_id)
  where retell_agent_id is not null and retell_agent_id<>'';
create unique index recepta_dedicated_primary_number on public.agents(phone_number)
  where phone_number is not null and phone_number<>'';

create table public.phone_setups (
  client_id uuid primary key references public.clients(id) on delete cascade,
  mode text not null default 'new' check (mode in ('new','existing')),
  business_number text,
  carrier text not null default 'other',
  line_type text not null default 'mobile' check (line_type in ('mobile','landline','voip')),
  revision integer not null default 0,
  sync_state text not null default 'pending' check (sync_state in ('pending','synced','error')),
  synced_agent_id text,
  forwarding_confirmed_at timestamptz,
  reception_tested_at timestamptz,
  transfer_tested_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.phone_verified_numbers (
  client_id uuid not null references public.clients(id) on delete cascade,
  purpose text not null check (purpose in ('business','worker')),
  phone_number text not null,
  provider_sid text,
  expires_at timestamptz,
  verified_at timestamptz,
  primary key (client_id,purpose,phone_number)
);
create table public.phone_transfer_destinations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text not null default 'Front desk',
  is_primary boolean not null default true,
  phone_number text not null,
  enabled boolean not null default false,
  authorized_at timestamptz not null default now()
);
create unique index phone_transfer_primary on public.phone_transfer_destinations(client_id) where is_primary;
create index phone_transfer_client on public.phone_transfer_destinations(client_id);
-- Retain previously advertised forwarding sources as unsafe transfer destinations.
-- A carrier may still be forwarding after someone edits a dashboard field.
create table public.phone_forwarding_sources (
  phone_number text primary key,
  client_id uuid not null references public.clients(id) on delete cascade
);
create index phone_forwarding_client on public.phone_forwarding_sources(client_id);
create table public.phone_operation_limits (
  key text primary key,
  window_start timestamptz not null,
  requests integer not null
);
create table public.phone_operation_locks (
  client_id uuid primary key references public.clients(id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null
);
create table public.call_transfer_events (
  event_key text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  retell_call_id text not null,
  event text not null check (event in ('transfer_started','transfer_bridged','transfer_cancelled','transfer_ended')),
  received_at timestamptz not null default now()
);
create index call_transfer_client_call on public.call_transfer_events(client_id,retell_call_id);

-- Atomic counters work across concurrent serverless instances. Keys are hashes;
-- the fixed window cannot be reset by changing a browser session.
create function public.consume_phone_limit(p_key text,p_max integer,p_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  insert into public.phone_operation_limits as l values(p_key,now(),1)
  on conflict(key) do update set
    requests=case when l.window_start <= now()-make_interval(secs=>p_seconds) then 1 else l.requests+1 end,
    window_start=case when l.window_start <= now()-make_interval(secs=>p_seconds) then now() else l.window_start end
  returning requests into n;
  return n <= p_max;
end $$;
create function public.acquire_phone_lock(p_client_id uuid,p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  insert into public.phone_operation_locks as l values(p_client_id,p_token,now()+interval '15 minutes')
  on conflict(client_id) do update set token=excluded.token,expires_at=excluded.expires_at where l.expires_at < now();
  get diagnostics n=row_count;
  return n=1;
end $$;

create function public.save_recepta_phone_setup(p_client_id uuid,p_expected_revision integer,p_settings jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare s public.phone_setups; worker text := nullif(p_settings->>'worker_number','');
  business text := nullif(p_settings->>'business_number',''); enabled boolean := (p_settings->>'enabled')::boolean;
begin
  insert into public.phone_setups(client_id) values(p_client_id) on conflict do nothing;
  select * into s from public.phone_setups where client_id=p_client_id for update;
  if s.revision <> p_expected_revision then raise exception 'Settings changed. Reload before saving.'; end if;
  if enabled and (worker is null or not exists(select 1 from public.phone_verified_numbers where client_id=p_client_id and purpose='worker' and phone_number=worker and verified_at>now()-interval '90 days')) then
    raise exception 'Verify the worker number first.';
  end if;
  if (p_settings->>'mode')='existing' then
    if business is null or not exists(select 1 from public.phone_verified_numbers where client_id=p_client_id and purpose='business' and phone_number=business and verified_at>now()-interval '90 days') then
      raise exception 'Verify the business number first.';
    end if;
    if exists(select 1 from public.agents where phone_number=business) or exists(select 1 from public.agent_phone_numbers where phone_number=business) then
      raise exception 'Use an existing carrier number, not a Recepta AI number.';
    end if;
    insert into public.phone_forwarding_sources values(business,p_client_id) on conflict(phone_number) do nothing;
    if not exists(select 1 from public.phone_forwarding_sources where phone_number=business and client_id=p_client_id) then
      raise exception 'This forwarding source is already in use.';
    end if;
  end if;
  if enabled and (worker=business or exists(select 1 from public.phone_forwarding_sources where phone_number=worker)
    or exists(select 1 from public.agents where phone_number=worker) or exists(select 1 from public.agent_phone_numbers where phone_number=worker)) then
    raise exception 'Use a direct worker number that does not forward to Recepta.';
  end if;
  if worker is not null then
    insert into public.phone_transfer_destinations(client_id,phone_number,enabled)
    values(p_client_id,worker,enabled) on conflict(client_id) where is_primary do update set phone_number=excluded.phone_number,enabled=excluded.enabled,authorized_at=now();
  else
    update public.phone_transfer_destinations set enabled=false where client_id=p_client_id;
  end if;
  update public.phone_setups set mode=p_settings->>'mode',business_number=business,carrier=p_settings->>'carrier',line_type=p_settings->>'line_type',
    revision=revision+1,sync_state='pending',synced_agent_id=p_settings->>'agent_id',
    forwarding_confirmed_at=null,reception_tested_at=null,transfer_tested_at=null,updated_at=now()
  where client_id=p_client_id returning revision into p_expected_revision;
  return p_expected_revision;
end $$;

-- Server-only persistence. Browser clients cannot forge verification or sync state.
do $$ declare t text; begin
  foreach t in array array['phone_setups','phone_verified_numbers','phone_transfer_destinations','phone_forwarding_sources','phone_operation_limits','phone_operation_locks','call_transfer_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
    execute format('create policy server_only on public.%I to service_role using (true) with check (true)',t);
  end loop;
end $$;
revoke all on function public.consume_phone_limit(text,integer,integer),public.acquire_phone_lock(uuid,uuid),public.save_recepta_phone_setup(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.consume_phone_limit(text,integer,integer),public.acquire_phone_lock(uuid,uuid),public.save_recepta_phone_setup(uuid,integer,jsonb) to service_role;

-- Disabling is always allowed, even after billing/verification expires or an
-- agent is disconnected. Inbound admission immediately stops providing a target.
create function public.disable_recepta_phone_transfer(p_client_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.phone_transfer_destinations set enabled=false where client_id=p_client_id;
  update public.phone_setups set revision=revision+1,transfer_tested_at=null,updated_at=now() where client_id=p_client_id;
end $$;
revoke all on function public.disable_recepta_phone_transfer(uuid) from public,anon,authenticated;
grant execute on function public.disable_recepta_phone_transfer(uuid) to service_role;

-- This operation only links existing resources, never buys a number or changes
-- billing. Serialize assignment checks and leave unrelated agent fields intact.
create function public.link_recepta_phone_pair(p_client_id uuid,p_agent_id text,p_phone text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('recepta-agent:'||p_agent_id,0));
  perform pg_advisory_xact_lock(hashtextextended('recepta-phone:'||p_phone,0));
  if not exists(select 1 from public.clients where id=p_client_id and not coalesce(deletion_pending,false)) then raise exception 'Account unavailable.'; end if;
  if exists(select 1 from public.agents where (retell_agent_id=p_agent_id or phone_number=p_phone) and client_id<>p_client_id)
    or exists(select 1 from public.agent_phone_numbers where phone_number=p_phone and client_id<>p_client_id)
    or exists(select 1 from public.agents where client_id=p_client_id and retell_agent_id is not null and retell_agent_id<>p_agent_id)
    then raise exception 'Resources are already assigned. Review the existing configuration.'; end if;
  if exists(select 1 from public.agent_phone_numbers where client_id=p_client_id and phone_number<>p_phone) then raise exception 'Use existing number management for additional numbers.'; end if;
  insert into public.agents(client_id,retell_agent_id,phone_number,status)
  values(p_client_id,p_agent_id,p_phone,'setup') on conflict(client_id) do update set retell_agent_id=excluded.retell_agent_id,phone_number=excluded.phone_number;
  insert into public.agent_phone_numbers(client_id,phone_number,is_primary,source)
  values(p_client_id,p_phone,true,'manual') on conflict(phone_number) do nothing;
end $$;
revoke all on function public.link_recepta_phone_pair(uuid,text,text) from public,anon,authenticated;
grant execute on function public.link_recepta_phone_pair(uuid,text,text) to service_role;

-- One publisher per Retell agent across hours, employees, billing and transfers.
-- Creating a draft before acquiring this lock could publish an old tool list.
create table public.retell_agent_sync_locks(agent_id text primary key, token uuid not null, expires_at timestamptz not null);
alter table public.retell_agent_sync_locks enable row level security;
revoke all on public.retell_agent_sync_locks from public,anon,authenticated;
grant select,insert,update,delete on public.retell_agent_sync_locks to service_role;
create policy server_only on public.retell_agent_sync_locks to service_role using(true) with check(true);
create function public.acquire_retell_agent_sync(p_agent_id text,p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  insert into public.retell_agent_sync_locks as l values(p_agent_id,p_token,now()+interval '15 minutes')
  on conflict(agent_id) do update set token=excluded.token,expires_at=excluded.expires_at where l.expires_at<now();
  get diagnostics n=row_count;
  return n=1;
end $$;
revoke all on function public.acquire_retell_agent_sync(text,uuid) from public,anon,authenticated;
grant execute on function public.acquire_retell_agent_sync(text,uuid) to service_role;
