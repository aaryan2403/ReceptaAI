-- Run this entire file once in Supabase SQL Editor.
-- It is safe to run more than once.

alter table public.calls
  add column if not exists retell_call_id text,
  add column if not exists call_status text,
  add column if not exists transcript text,
  add column if not exists recording_url text,
  add column if not exists disconnection_reason text,
  add column if not exists user_sentiment text,
  add column if not exists call_successful boolean,
  add column if not exists updated_at timestamptz not null default now();

-- Keep an existing unique constraint. If this database only has the
-- older partial standalone index, replace that index with a regular
-- unique index that PostgREST can use for upserts.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.calls'::regclass
      and conname = 'calls_retell_call_id_key'
  ) then
    drop index if exists public.calls_retell_call_id_key;

    create unique index calls_retell_call_id_key
      on public.calls (retell_call_id);
  end if;
end
$$;

create unique index if not exists agents_retell_agent_id_key
  on public.agents (retell_agent_id)
  where retell_agent_id is not null;

alter table public.calls enable row level security;

drop policy if exists recepta_clients_read_own_calls
  on public.calls;

create policy recepta_clients_read_own_calls
  on public.calls
  for select
  to authenticated
  using (client_id = auth.uid());

comment on column public.calls.retell_call_id is
  'Retell call identifier used for webhook deduplication.';

comment on column public.calls.call_status is
  'Latest Retell lifecycle status for the call.';
