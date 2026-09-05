-- Run this file once in the Supabase SQL Editor before deploying the code.
-- It is safe to run more than once.

create table if not exists public.customer_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  request_type text not null default 'other'
    check (
      request_type in (
        'website_change',
        'ai_agent_change',
        'question',
        'meeting',
        'billing',
        'other'
      )
    ),
  title text not null
    check (char_length(title) between 3 and 160),
  details text not null
    check (char_length(details) between 10 and 5000),
  status text not null default 'new'
    check (status in ('new', 'in_progress', 'resolved')),
  email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_requests_client_id_idx
  on public.customer_requests (client_id, created_at desc);

create index if not exists customer_requests_status_idx
  on public.customer_requests (status, created_at desc);

alter table public.customer_requests enable row level security;

drop policy if exists recepta_clients_read_own_requests
  on public.customer_requests;

create policy recepta_clients_read_own_requests
  on public.customer_requests
  for select
  to authenticated
  using (client_id = auth.uid());

drop policy if exists recepta_clients_create_own_requests
  on public.customer_requests;

create policy recepta_clients_create_own_requests
  on public.customer_requests
  for insert
  to authenticated
  with check (client_id = auth.uid());

comment on table public.customer_requests is
  'Website, AI agent, billing, question and meeting requests submitted by Recepta clients.';

notify pgrst, 'reload schema';
