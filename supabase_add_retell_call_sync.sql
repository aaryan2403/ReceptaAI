alter table public.calls
  add column if not exists retell_call_id text,
  add column if not exists call_status text,
  add column if not exists transcript text,
  add column if not exists recording_url text,
  add column if not exists disconnection_reason text,
  add column if not exists user_sentiment text,
  add column if not exists call_successful boolean,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists calls_retell_call_id_key
  on public.calls (retell_call_id)
  where retell_call_id is not null;

create unique index if not exists agents_retell_agent_id_key
  on public.agents (retell_agent_id)
  where retell_agent_id is not null;

comment on column public.calls.retell_call_id is
  'Retell call identifier used for webhook deduplication.';

comment on column public.calls.call_status is
  'Latest Retell lifecycle status for the call.';
