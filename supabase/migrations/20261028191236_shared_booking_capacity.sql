-- One capacity ledger for staff entries, AI bookings and connected Google calendars.
create table public.booking_settings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  enabled boolean not null default false,
  capacity integer not null default 1 check (capacity between 1 and 50),
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  buffer_minutes integer not null default 0 check (buffer_minutes between 0 and 120),
  updated_at timestamptz not null default now()
);
create table public.google_calendar_connections (
  client_id uuid primary key references public.clients(id) on delete cascade,
  encrypted_refresh_token text not null,
  selected_calendars jsonb not null default '[]',
  write_calendar_id text,
  synced_at timestamptz,
  sync_error text,
  updated_at timestamptz not null default now()
);
create table public.google_calendar_oauth_states (
  state_hash text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  browser_hash text not null,
  expires_at timestamptz not null
);
create index google_calendar_oauth_client_idx on public.google_calendar_oauth_states(client_id);
create table public.booking_calendar_events (
  client_id uuid not null references public.clients(id) on delete cascade,
  calendar_id text not null,
  event_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  title text not null default 'Calendar appointment',
  html_link text,
  local_appointment_id uuid references public.appointments(id) on delete set null,
  primary key (client_id, calendar_id, event_id)
);
create index booking_calendar_events_time_idx on public.booking_calendar_events(client_id, starts_at, ends_at);
create index booking_calendar_events_local_idx on public.booking_calendar_events(local_appointment_id);
alter table public.appointments
  add column booking_key text,
  add column booking_version integer not null default 1,
  add column booking_buffer_minutes integer not null default 0,
  add column google_calendar_id text;
create unique index appointments_booking_key_idx on public.appointments(client_id, booking_key) where booking_key is not null;
create index appointments_client_booked_time_idx on public.appointments(client_id, appointment_time) where status = 'booked';
create table public.booking_calendar_jobs (
  appointment_id uuid primary key references public.appointments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null,
  calendar_id text not null,
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text
);
create index booking_calendar_jobs_retry_idx on public.booking_calendar_jobs(retry_at);
create index booking_calendar_jobs_client_idx on public.booking_calendar_jobs(client_id);

-- All new tables are server-only. The API derives client_id from the verified session.
do $$ declare t text; begin
  foreach t in array array['booking_settings','google_calendar_connections','google_calendar_oauth_states','booking_calendar_events','booking_calendar_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

-- Peak occupancy across the entire interval, with half-open boundaries. Counting
-- all intersecting events would incorrectly reject back-to-back appointments.
create function public.recepta_booking_remaining(p_client_id uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid default null)
returns integer language sql stable security invoker set search_path = '' as $$
  with settings as (select coalesce((select capacity from public.booking_settings where client_id=p_client_id),1) as capacity),
  occupied as (
    select a.appointment_time-make_interval(mins=>a.booking_buffer_minutes) as s,
      coalesce(a.appointment_end_time,a.appointment_time+make_interval(mins=>coalesce(a.duration_minutes,30)))+make_interval(mins=>a.booking_buffer_minutes) as e
    from public.appointments a where a.client_id=p_client_id and a.status='booked' and (p_exclude is null or a.id<>p_exclude)
    union all
    select e.starts_at,e.ends_at from public.booking_calendar_events e where e.client_id=p_client_id
      and not exists(select 1 from public.appointments a where a.id=e.local_appointment_id and a.client_id=p_client_id and a.status='booked')
  ), relevant as (select * from occupied where s<p_end and e>p_start),
  probes as (select p_start as t union select s from relevant where s>=p_start),
  peak as (select coalesce(max((select count(*) from relevant where s<=t and e>t)),0)::integer as n from probes)
  select settings.capacity-peak.n from settings,peak;
$$;

create function public.guard_recepta_booking() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_settings public.booking_settings; v_remaining integer; v_calendar public.google_calendar_connections;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.client_id::text,419));
  -- External changes reflect actual Google events even when a human exceeded capacity.
  -- Only server-only sync RPCs set this transaction-local flag.
  if current_setting('recepta.google_import',true)='on' then return new; end if;
  if new.status<>'booked' then return new; end if;
  if tg_op='UPDATE' and old.status='booked' and new.appointment_time is not distinct from old.appointment_time
    and new.appointment_end_time is not distinct from old.appointment_end_time
    and new.employee_id is not distinct from old.employee_id then return new; end if;
  select * into v_settings from public.booking_settings where client_id=new.client_id;
  if not found then raise exception 'Save your booking rules first.'; end if;
  if new.source='retell' and not v_settings.enabled then raise exception 'AI booking is not enabled for this account.'; end if;
  if not exists(select 1 from public.subscriptions where client_id=new.client_id and plan_name='Recepta Pro' and status='active'
    and stripe_subscription_id is not null and current_period_start<=now() and current_period_end>now()) then
    raise exception 'An active paid Recepta Pro plan is required to book.';
  end if;
  if new.appointment_time is null or new.appointment_end_time is null or new.appointment_end_time<=new.appointment_time
    or new.appointment_time<now() or new.appointment_time>now()+interval '90 days'
    or new.duration_minutes is null or new.duration_minutes not between 5 and 480 then raise exception 'Choose a valid future appointment within 90 days.'; end if;
  select * into v_calendar from public.google_calendar_connections where client_id=new.client_id;
  if found and (v_calendar.write_calendar_id is null or jsonb_array_length(v_calendar.selected_calendars)=0
    or v_calendar.sync_error is not null or v_calendar.synced_at is null or v_calendar.synced_at<now()-interval '60 seconds') then
    raise exception 'Google Calendar availability must be refreshed before booking.';
  end if;
  new.booking_buffer_minutes:=v_settings.buffer_minutes;
  v_remaining:=public.recepta_booking_remaining(new.client_id,
    new.appointment_time-make_interval(mins=>new.booking_buffer_minutes),
    new.appointment_end_time+make_interval(mins=>new.booking_buffer_minutes),new.id);
  if v_remaining<1 then raise exception 'That time is full. Choose another time.'; end if;
  if new.employee_id is not null and exists(select 1 from public.appointments a where a.client_id=new.client_id
    and a.employee_id=new.employee_id and a.id<>new.id and a.status='booked'
    and a.appointment_time-make_interval(mins=>a.booking_buffer_minutes)<new.appointment_end_time+make_interval(mins=>new.booking_buffer_minutes)
    and coalesce(a.appointment_end_time,a.appointment_time+make_interval(mins=>coalesce(a.duration_minutes,30)))+make_interval(mins=>a.booking_buffer_minutes)>new.appointment_time-make_interval(mins=>new.booking_buffer_minutes)) then
    raise exception 'The selected employee is already booked.';
  end if;
  return new;
end $$;
create trigger recepta_booking_capacity before insert or update on public.appointments for each row execute function public.guard_recepta_booking();

create function public.queue_recepta_calendar_booking() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_calendar text;
begin
  if current_setting('recepta.google_import',true)='on' then return new; end if;
  if tg_op='UPDATE' and new.booking_version=old.booking_version then return new; end if;
  if new.status not in ('booked','cancelled') or new.appointment_time is null then return new; end if;
  select write_calendar_id into v_calendar from public.google_calendar_connections where client_id=new.client_id;
  if v_calendar is null then return new; end if;
  insert into public.booking_calendar_jobs(appointment_id,client_id,version,calendar_id) values(new.id,new.client_id,new.booking_version,v_calendar)
  on conflict(appointment_id) do update set version=excluded.version,retry_at=now(),last_error=null;
  return new;
end $$;
create trigger recepta_booking_calendar_queue after insert or update on public.appointments for each row execute function public.queue_recepta_calendar_booking();

create function public.reserve_recepta_booking(p_client_id uuid,p_booking_key text,p_details jsonb,p_id uuid default null,p_version integer default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.appointments; v_start timestamptz; v_duration integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  if nullif(btrim(p_booking_key),'') is null then raise exception 'A booking request key is required.'; end if;
  insert into public.booking_settings(client_id) values(p_client_id) on conflict(client_id) do nothing;
  if p_id is null then
    select * into a from public.appointments where client_id=p_client_id and
      (booking_key=p_booking_key or (p_details->>'retell_call_id' is not null and retell_call_id=p_details->>'retell_call_id'));
    if found and a.status<>'pending' then return to_jsonb(a); end if;
  else
    select * into a from public.appointments where client_id=p_client_id and id=p_id;
    if not found then raise exception 'Booking not found.'; end if;
    if a.status='cancelled' or a.booking_version is distinct from p_version then raise exception 'This booking changed. Refresh before editing.'; end if;
  end if;
  if nullif(btrim(p_details->>'customer_name'),'') is null then raise exception 'Customer name is required.'; end if;
  v_start:=(p_details->>'start')::timestamptz;
  v_duration:=(p_details->>'duration_minutes')::integer;
  if a.id is null then
    insert into public.appointments(client_id,booking_key,customer_name,customer_phone,customer_email,service,notes,employee_id,
      appointment_time,appointment_end_time,duration_minutes,status,source,retell_call_id)
    values(p_client_id,p_booking_key,p_details->>'customer_name',p_details->>'customer_phone',p_details->>'customer_email',
      p_details->>'service',p_details->>'notes',nullif(p_details->>'employee_id','')::uuid,
      v_start,v_start+make_interval(mins=>v_duration),v_duration,'booked',coalesce(p_details->>'source','dashboard'),p_details->>'retell_call_id') returning * into a;
  else
    update public.appointments set booking_key=coalesce(booking_key,p_booking_key),customer_name=p_details->>'customer_name',
      customer_phone=p_details->>'customer_phone',customer_email=p_details->>'customer_email',service=p_details->>'service',notes=p_details->>'notes',
      employee_id=nullif(p_details->>'employee_id','')::uuid,appointment_time=v_start,appointment_end_time=v_start+make_interval(mins=>v_duration),
      duration_minutes=v_duration,status='booked',booking_version=booking_version+1,updated_at=now()
    where id=a.id returning * into a;
  end if;
  return to_jsonb(a);
end $$;

create function public.cancel_recepta_booking(p_client_id uuid,p_id uuid,p_version integer) returns void language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  update public.appointments set status='cancelled',booking_version=booking_version+1,updated_at=now()
    where client_id=p_client_id and id=p_id and booking_version=p_version and status in ('booked','pending');
  if not found then raise exception 'This booking changed. Refresh before cancelling.'; end if;
end $$;

create function public.update_recepta_booking_settings(p_client_id uuid,p_enabled boolean,p_capacity integer,p_duration integer,p_buffer integer)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  insert into public.booking_settings(client_id,enabled,capacity,duration_minutes,buffer_minutes)
    values(p_client_id,p_enabled,p_capacity,p_duration,p_buffer)
  on conflict(client_id) do update set enabled=p_enabled,capacity=p_capacity,duration_minutes=p_duration,buffer_minutes=p_buffer,updated_at=now();
end $$;

-- Replace a complete calendar snapshot atomically; failed/truncated reads never clear availability.
create function public.sync_recepta_calendar_snapshot(p_client_id uuid,p_events jsonb,p_synced_at timestamptz,p_connection_version timestamptz default null)
returns void language plpgsql security invoker set search_path='' as $$
declare e jsonb; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  if p_connection_version is not null and not exists(select 1 from public.google_calendar_connections where client_id=p_client_id and updated_at=p_connection_version) then
    raise exception 'Google Calendar connection changed. Refresh availability again.';
  end if;
  perform set_config('recepta.google_import','on',true);
  delete from public.booking_calendar_events where client_id=p_client_id;
  for e in select * from jsonb_array_elements(p_events) loop
    v_id:=null;
    if e->>'event_id' ~ '^recepta[0-9a-f]{32}$' then
      select id into v_id from public.appointments where client_id=p_client_id and google_calendar_id=e->>'calendar_id'
        and 'recepta'||replace(id::text,'-','')=e->>'event_id'
        and not exists(select 1 from public.booking_calendar_jobs where appointment_id=appointments.id);
    end if;
    if v_id is not null then
      if (e->>'cancelled')::boolean then
        update public.appointments set status='cancelled',booking_version=booking_version+1,updated_at=now() where id=v_id and status='booked';
      elsif (e->>'ends_at')::timestamptz-(e->>'starts_at')::timestamptz between interval '5 minutes' and interval '480 minutes' then
        update public.appointments set appointment_time=(e->>'starts_at')::timestamptz,appointment_end_time=(e->>'ends_at')::timestamptz,
          duration_minutes=extract(epoch from ((e->>'ends_at')::timestamptz-(e->>'starts_at')::timestamptz))/60,
          booking_version=booking_version+1,updated_at=now()
        where id=v_id and status='booked' and (appointment_time is distinct from (e->>'starts_at')::timestamptz or appointment_end_time is distinct from (e->>'ends_at')::timestamptz);
      else v_id:=null;
      end if;
    end if;
    if not coalesce((e->>'cancelled')::boolean,false) then
      insert into public.booking_calendar_events(client_id,calendar_id,event_id,starts_at,ends_at,title,html_link,local_appointment_id)
      values(p_client_id,e->>'calendar_id',e->>'event_id',(e->>'starts_at')::timestamptz,(e->>'ends_at')::timestamptz,
        coalesce(e->>'title','Calendar appointment'),e->>'html_link',v_id);
    end if;
  end loop;
  update public.google_calendar_connections set synced_at=p_synced_at,sync_error=null where client_id=p_client_id;
end $$;

create function public.claim_recepta_calendar_jobs(p_client_id uuid default null) returns setof public.booking_calendar_jobs
language sql security invoker set search_path='' as $$
  update public.booking_calendar_jobs set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '90 seconds',attempts=attempts+1
  where appointment_id in (select appointment_id from public.booking_calendar_jobs where retry_at<=now()
    and (p_client_id is null or client_id=p_client_id) and (lease_expires_at is null or lease_expires_at<now())
    order by retry_at for update skip locked limit 5) returning *;
$$;

create function public.disconnect_recepta_calendar(p_client_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,419));
  update public.booking_settings set enabled=false,updated_at=now() where client_id=p_client_id;
  delete from public.google_calendar_connections where client_id=p_client_id;
  delete from public.booking_calendar_events where client_id=p_client_id;
  delete from public.booking_calendar_jobs where client_id=p_client_id;
end $$;

-- Old authenticated booking RPC must not bypass the new API's schedule/plan validation.
do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and
    proname in ('recepta_booking_remaining','guard_recepta_booking','queue_recepta_calendar_booking','reserve_recepta_booking',
    'cancel_recepta_booking','update_recepta_booking_settings','sync_recepta_calendar_snapshot','claim_recepta_calendar_jobs','disconnect_recepta_calendar','recepta_book_employee_appointment') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
revoke insert,update,delete on public.appointments from anon,authenticated;
