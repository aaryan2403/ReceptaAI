-- Transfer hours are independent of admin-controlled store hours.
alter table public.phone_setups add column transfer_schedule jsonb, add column reception_observed_at timestamptz;
-- reception_observed_at is separate from legacy browser-reported test dates.
-- Null means 24/7 for backward-compatible existing configurations.

create table public.phone_reception_tests (
  client_id uuid primary key references public.clients(id) on delete cascade,
  revision integer not null,
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  retell_call_id text
);
alter table public.phone_reception_tests enable row level security;
revoke all on public.phone_reception_tests from public,anon,authenticated;
grant select,insert,update,delete on public.phone_reception_tests to service_role;
create policy server_only on public.phone_reception_tests to service_role using(true) with check(true);

-- Canonical comparison also catches legacy formatted US/Canadian numbers.
create function public.recepta_normalized_phone(p text) returns text language sql immutable set search_path='' as $$
  select case length(regexp_replace(p,'[^0-9]','','g')) when 10 then '+1'||regexp_replace(p,'[^0-9]','','g')
    else '+'||regexp_replace(p,'[^0-9]','','g') end;
$$;
create function public.recepta_unsafe_destination(p_number text) returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.agents where public.recepta_normalized_phone(phone_number)=p_number)
    or exists(select 1 from public.agent_phone_numbers where public.recepta_normalized_phone(phone_number)=p_number)
    or exists(select 1 from public.phone_forwarding_sources where public.recepta_normalized_phone(phone_number)=p_number);
$$;
revoke all on function public.recepta_normalized_phone(text),public.recepta_unsafe_destination(text) from public,anon,authenticated;
grant execute on function public.recepta_normalized_phone(text),public.recepta_unsafe_destination(text) to service_role;

create or replace function public.save_recepta_phone_setup(p_client_id uuid,p_expected_revision integer,p_settings jsonb)
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
  if worker is not null and (worker=business or public.recepta_unsafe_destination(worker)) then
    raise exception 'Use a direct worker number that does not forward to Recepta.';
  end if;
  if worker is not null then
    insert into public.phone_transfer_destinations(client_id,phone_number,enabled)
    values(p_client_id,worker,enabled) on conflict(client_id) where is_primary do update set phone_number=excluded.phone_number,enabled=excluded.enabled,authorized_at=now();
  else
    update public.phone_transfer_destinations set enabled=false where client_id=p_client_id;
  end if;
  update public.phone_setups set mode=p_settings->>'mode',business_number=business,carrier=p_settings->>'carrier',line_type=p_settings->>'line_type',
    transfer_schedule=coalesce(p_settings->'transfer_schedule',s.transfer_schedule),
    revision=revision+1,sync_state='pending',synced_agent_id=p_settings->>'agent_id',
    forwarding_confirmed_at=null,reception_tested_at=null,reception_observed_at=null,transfer_tested_at=null,updated_at=now()
  where client_id=p_client_id returning revision into p_expected_revision;
  return p_expected_revision;
end $$;

create function public.confirm_recepta_reception_test(p_client_id uuid,p_hash text,p_call_id text,p_started_at timestamptz)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.phone_setups; t public.phone_reception_tests;
begin
  select * into s from public.phone_setups where client_id=p_client_id for update;
  select * into t from public.phone_reception_tests where client_id=p_client_id for update;
  if s.client_id is null or t.client_id is null or s.sync_state<>'synced' or s.revision<>t.revision
    or t.expires_at<=now() or t.code_hash<>p_hash or p_started_at<t.created_at then return false; end if;
  if t.confirmed_at is not null then return t.retell_call_id=p_call_id; end if;
  update public.phone_reception_tests set confirmed_at=now(),retell_call_id=p_call_id where client_id=p_client_id;
  update public.phone_setups set reception_observed_at=now()
    where client_id=p_client_id;
  return true;
end $$;
revoke all on function public.confirm_recepta_reception_test(uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.confirm_recepta_reception_test(uuid,text,text,timestamptz) to service_role;

alter table public.callback_requests add column caller_name text, add column request_details text,
  add column preferred_callback_time text, add column answered_call boolean not null default false;


create function public.capture_recepta_human_callback(p_client_id uuid,p_call_id text,p_from text,p_to text,p_name text,p_reason text,p_preferred text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
  if not exists(select 1 from public.clients where id=p_client_id and not coalesce(deletion_pending,false)) then raise exception 'Account unavailable.'; end if;
  insert into public.callback_requests(client_id,retell_call_id,caller_number,called_number,reason,caller_name,request_details,preferred_callback_time,answered_call)
    values(p_client_id,p_call_id,p_from,p_to,'agent_unavailable',p_name,p_reason,p_preferred,true)
    on conflict(retell_call_id) do nothing returning id into v_id;
  if v_id is not null then
    insert into public.service_jobs(job_key,client_id,kind,payload)
      values('callback:'||p_client_id::text||':'||p_call_id,p_client_id,'callback_email',jsonb_build_object('callback_id',v_id));
  end if;
end $$;
revoke all on function public.capture_recepta_human_callback(uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.capture_recepta_human_callback(uuid,text,text,text,text,text,text) to service_role;
