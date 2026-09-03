-- Run this file once in the Supabase SQL Editor before deploying the code.
-- It is safe to run more than once.

create table if not exists public.agent_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  phone_number text not null unique,
  is_primary boolean not null default false,
  source text not null default 'manual'
    check (source in ('manual', 'retell')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_phone_numbers_e164_check
    check (phone_number ~ '^\+[1-9][0-9]{7,14}$')
);

create index if not exists agent_phone_numbers_client_id_idx
  on public.agent_phone_numbers (client_id);

create unique index if not exists agent_phone_numbers_one_primary_idx
  on public.agent_phone_numbers (client_id)
  where is_primary;

insert into public.agent_phone_numbers (
  client_id,
  phone_number,
  is_primary,
  source
)
select
  client_id,
  phone_number,
  true,
  'manual'
from public.agents
where phone_number is not null
  and phone_number ~ '^\+[1-9][0-9]{7,14}$'
on conflict (phone_number) do nothing;

alter table public.agent_phone_numbers enable row level security;

drop policy if exists recepta_clients_read_own_phone_numbers
  on public.agent_phone_numbers;

create policy recepta_clients_read_own_phone_numbers
  on public.agent_phone_numbers
  for select
  to authenticated
  using (client_id = auth.uid());

comment on table public.agent_phone_numbers is
  'All Retell or manually assigned phone numbers belonging to a Recepta client.';

comment on column public.agent_phone_numbers.is_primary is
  'The number shown first in the dashboard and mirrored to agents.phone_number for compatibility.';

