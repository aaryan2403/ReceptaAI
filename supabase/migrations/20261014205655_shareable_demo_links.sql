-- Demo links are bearer capabilities. Only the server can read or redeem them.
create table public.recepta_demo_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null check (char_length(label) between 1 and 100),
  retell_agent_id text not null,
  agent_version integer not null check (agent_version >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  attempts integer not null default 0 check (attempts between 0 and max_attempts),
  revoked boolean not null default false
);
alter table public.recepta_demo_links enable row level security;
revoke all on public.recepta_demo_links from public, anon, authenticated;
grant select, insert, update, delete on public.recepta_demo_links to service_role;

-- One conditional UPDATE serializes simultaneous starts. Failed or ambiguous
-- provider starts still consume an attempt; they cannot create an unlimited retry.
create function public.claim_recepta_demo(p_token_hash text)
returns table (id uuid, retell_agent_id text, agent_version integer)
language sql security invoker set search_path = '' as $$
  update public.recepta_demo_links as d
  set attempts = d.attempts + 1
  where d.token_hash = p_token_hash and not d.revoked
    and d.expires_at > now() and d.attempts < d.max_attempts
    and not exists (
      select 1 from public.agents as a where a.retell_agent_id = d.retell_agent_id
    )
  returning d.id, d.retell_agent_id, d.agent_version;
$$;
revoke all on function public.claim_recepta_demo(text) from public, anon, authenticated;
grant execute on function public.claim_recepta_demo(text) to service_role;
