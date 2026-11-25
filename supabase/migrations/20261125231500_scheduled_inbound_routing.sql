create table public.inbound_phone_routes (
  ingress_number text primary key check (ingress_number ~ '^\+[1-9][0-9]{7,14}$'),
  client_id uuid not null references public.clients(id) on delete cascade,
  ai_number text not null check (ai_number ~ '^\+[1-9][0-9]{7,14}$'),
  human_number text not null check (human_number ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  business_number text check (business_number ~ '^\+[1-9][0-9]{7,14}$'),
  check (ingress_number <> ai_number and human_number not in (ingress_number, ai_number)
    and (business_number is null or business_number not in (ingress_number, ai_number, human_number)))
);
create index inbound_phone_routes_client_idx on public.inbound_phone_routes(client_id);
create index inbound_phone_routes_business_idx on public.inbound_phone_routes(business_number);

create table public.inbound_voicemails (
  recording_sid text primary key check (recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  account_sid text not null check (account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  callback_id uuid references public.callback_requests(id) on delete set null,
  expires_at timestamptz not null
);
create index inbound_voicemails_callback_idx on public.inbound_voicemails(callback_id);
create index inbound_voicemails_account_expiry_idx on public.inbound_voicemails(account_sid, expires_at);

alter table public.inbound_phone_routes enable row level security;
alter table public.inbound_voicemails enable row level security;
revoke all on public.inbound_phone_routes, public.inbound_voicemails from public, anon, authenticated;
grant select, insert, update, delete on public.inbound_phone_routes, public.inbound_voicemails to service_role;

create function public.recepta_voice_number_kind(p_number text)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare known_forwarding_source boolean;
begin
  if exists(select 1 from public.inbound_phone_routes where ingress_number = p_number) then
    return 'ingress';
  end if;
  if exists(select 1 from public.agents where phone_number = p_number)
    or exists(select 1 from public.agent_phone_numbers where phone_number = p_number) then
    return 'ai';
  end if;
  if exists(select 1 from public.inbound_phone_routes where business_number = p_number) then
    return 'business';
  end if;
  -- Reuse the existing forwarding registry where the earlier phone setup has been deployed.
  if to_regclass('public.phone_forwarding_sources') is not null then
    execute 'select exists(select 1 from public.phone_forwarding_sources where phone_number = $1)'
      into known_forwarding_source using p_number;
    if known_forwarding_source then return 'business'; end if;
  end if;
  return null;
end $$;

create function public.recepta_voice_route(p_ingress text)
returns table(client_id uuid, ai_number text, human_number text, business_hours text, ai_assigned boolean)
language sql stable security invoker set search_path = '' as $$
  select r.client_id, r.ai_number, r.human_number, a.business_hours,
    a.retell_agent_id is not null
    and (a.phone_number = r.ai_number or exists(
      select 1 from public.agent_phone_numbers n where n.client_id = r.client_id and n.phone_number = r.ai_number
    ))
    and not exists(select 1 from public.agent_phone_numbers n where n.client_id <> r.client_id and n.phone_number = r.ai_number)
    and not exists(select 1 from public.agents other where other.client_id <> r.client_id and other.phone_number = r.ai_number)
    and public.recepta_voice_number_kind(r.ai_number) = 'ai'
  from public.inbound_phone_routes r
  join public.clients c on c.id = r.client_id and not c.deletion_pending
  join public.agents a on a.client_id = r.client_id
  where r.ingress_number = p_ingress
$$;

create function public.recepta_store_inbound_voicemail(p_account text, p_recording text, p_call text, p_callback uuid)
returns void language sql security invoker set search_path = '' as $$
  insert into public.inbound_voicemails(recording_sid, account_sid, callback_id, expires_at)
  select p_recording, p_account, eligible.id, coalesce(eligible.expires, now())
  from (select 1) seed
  left join lateral (
    select q.id, q.created_at + make_interval(days => c.call_retention_days) as expires
    from public.callback_requests q join public.clients c on c.id = q.client_id
    where q.id = p_callback and q.retell_call_id = 'twilio:' || p_call and not c.deletion_pending
  ) eligible on true
  on conflict do nothing
$$;

revoke all on function public.recepta_voice_number_kind(text), public.recepta_voice_route(text),
  public.recepta_store_inbound_voicemail(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.recepta_voice_number_kind(text), public.recepta_voice_route(text),
  public.recepta_store_inbound_voicemail(text, text, text, uuid) to service_role;
