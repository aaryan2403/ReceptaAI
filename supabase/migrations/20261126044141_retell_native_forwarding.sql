-- Some staging deployments already have the Phone Setup registry.
create table if not exists public.phone_transfer_destinations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text not null default 'Front desk',
  is_primary boolean not null default true,
  phone_number text not null,
  enabled boolean not null default false,
  authorized_at timestamptz not null default now()
);
create unique index if not exists phone_transfer_primary on public.phone_transfer_destinations(client_id) where is_primary;

create table if not exists public.phone_forwarding_sources (
  phone_number text primary key,
  client_id uuid not null references public.clients(id) on delete cascade
);
create index if not exists phone_forwarding_client on public.phone_forwarding_sources(client_id);

create table public.retell_forwarding_lock (
  id boolean primary key default true check (id),
  token uuid not null,
  expires_at timestamptz not null
);

alter table public.phone_transfer_destinations enable row level security;
alter table public.phone_forwarding_sources enable row level security;
alter table public.retell_forwarding_lock enable row level security;
revoke all on public.phone_transfer_destinations, public.phone_forwarding_sources, public.retell_forwarding_lock
  from public, anon, authenticated;
grant select, insert, update, delete on public.phone_transfer_destinations, public.phone_forwarding_sources,
  public.retell_forwarding_lock to service_role;

create function public.recepta_claim_retell_forwarding(p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.retell_forwarding_lock as lock(id, token, expires_at)
  values(true, p_token, clock_timestamp() + interval '45 seconds')
  on conflict(id) do update set token = excluded.token, expires_at = excluded.expires_at
    where lock.expires_at < clock_timestamp();
  return found;
end $$;

create function public.recepta_unsafe_retell_forwarding_destination(p_number text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from public.agents where phone_number = p_number)
    or exists(select 1 from public.agent_phone_numbers where phone_number = p_number)
    or exists(select 1 from public.phone_forwarding_sources where phone_number = p_number)
$$;

create function public.recepta_retell_forwarding_routes(p_numbers text[], p_client uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with assignments as (
    select client_id, phone_number from public.agents where phone_number = any(p_numbers)
    union
    select client_id, phone_number from public.agent_phone_numbers where phone_number = any(p_numbers)
  ), unambiguous as (
    select phone_number from assignments group by phone_number having count(*) = 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'client_id', n.client_id,
    'phone_number', n.phone_number,
    'business_hours', a.business_hours,
    'human_number', case when c.deletion_pending or a.retell_agent_id is null then null else d.phone_number end,
    'unsafe_destination', public.recepta_unsafe_retell_forwarding_destination(d.phone_number)
  )), '[]'::jsonb)
  from assignments n join unambiguous using(phone_number)
  join public.clients c on c.id = n.client_id
  join public.agents a on a.client_id = n.client_id
  left join public.phone_transfer_destinations d on d.client_id = n.client_id and d.is_primary and d.enabled
  where p_client is null or n.client_id = p_client
$$;

create function public.recepta_save_retell_forwarding_schedule(
  p_client uuid, p_previous text, p_schedule text, p_edit_human boolean, p_human text, p_business text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.agents a set business_hours = p_schedule
  where a.client_id = p_client and a.business_hours is not distinct from p_previous
    and exists(select 1 from public.clients c where c.id = p_client and not c.deletion_pending);
  if not found then return false; end if;

  if p_business is not null then
    if p_business !~ '^\+[1-9][0-9]{7,14}$'
      or exists(select 1 from public.agents where phone_number = p_business)
      or exists(select 1 from public.agent_phone_numbers where phone_number = p_business)
    then raise exception 'Use the original business phone number.' using errcode = '22023'; end if;

    insert into public.phone_forwarding_sources(phone_number, client_id) values(p_business, p_client)
      on conflict(phone_number) do nothing;
    if not exists(select 1 from public.phone_forwarding_sources where phone_number = p_business and client_id = p_client)
    then raise exception 'This business number is already registered.' using errcode = '22023'; end if;
  end if;

  if p_edit_human then
    if p_human is null then
      update public.phone_transfer_destinations set enabled = false where client_id = p_client and is_primary;
    else
      if p_human !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'
        or public.recepta_unsafe_retell_forwarding_destination(p_human)
      then raise exception 'Use a direct human number that does not forward to Recepta.' using errcode = '22023'; end if;

      insert into public.phone_transfer_destinations(client_id, phone_number, enabled)
      values(p_client, p_human, true)
      on conflict(client_id) where is_primary do update
        set phone_number = excluded.phone_number, enabled = true, authorized_at = now();
    end if;
  elsif p_business is not null and exists(
    select 1 from public.phone_transfer_destinations where client_id = p_client and is_primary and enabled and phone_number = p_business
  ) then
    raise exception 'The human number must be different from the forwarding business number.' using errcode = '22023';
  end if;
  return true;
end $$;

revoke all on function public.recepta_claim_retell_forwarding(uuid),
  public.recepta_unsafe_retell_forwarding_destination(text), public.recepta_retell_forwarding_routes(text[], uuid),
  public.recepta_save_retell_forwarding_schedule(uuid, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.recepta_claim_retell_forwarding(uuid),
  public.recepta_unsafe_retell_forwarding_destination(text), public.recepta_retell_forwarding_routes(text[], uuid),
  public.recepta_save_retell_forwarding_schedule(uuid, text, text, boolean, text, text) to service_role;
