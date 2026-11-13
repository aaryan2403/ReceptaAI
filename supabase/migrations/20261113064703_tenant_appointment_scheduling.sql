-- Reactivate the tenant settings row and the existing appointment ledger.
-- Retired calendar endpoints, tables, jobs and functions remain inaccessible.
alter table public.booking_settings
  alter column capacity drop not null,
  add column start_interval_minutes integer not null default 15 check (start_interval_minutes between 1 and 1440),
  add column time_zone text not null default 'America/Toronto',
  add column hourly_limit integer check (hourly_limit >= 0),
  add column weekly jsonb not null default '{}' check (jsonb_typeof(weekly) = 'object'),
  add column exceptions jsonb not null default '{}' check (jsonb_typeof(exceptions) = 'object'),
  add column email_owner boolean not null default false,
  add column email_customer boolean not null default false,
  add column sync_agent_id text,
  add column sync_error text,
  add column synced_at timestamptz;
alter table public.booking_settings drop constraint booking_settings_capacity_check;
alter table public.booking_settings add check (capacity > 0);
grant select, insert, update on public.booking_settings to service_role;

alter table public.appointments
  add column booking_time_zone text,
  add column booking_email_consent boolean not null default false;

create table public.appointment_history (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  action text not null check (action in ('requested','booked','confirmed','rescheduled','cancelled')),
  previous_start timestamptz,
  new_start timestamptz,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index appointment_history_client_idx on public.appointment_history(client_id, appointment_id, id);
create index appointments_client_status_created_idx on public.appointments(client_id, status, created_at desc);
alter table public.appointment_history enable row level security;
revoke all on public.appointment_history from public, anon, authenticated;
grant select, insert on public.appointment_history to service_role;
revoke insert, update, delete, truncate on public.appointments from public, anon, authenticated;

alter table public.service_jobs drop constraint service_jobs_kind_check;
alter table public.service_jobs add check (kind in ('callback_email','delete_client','retention_call','appointment_email'));

create function public.recepta_schedule_day_valid(p_day jsonb)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare v_block jsonb; v_start time; v_end time; v_last time;
begin
  if jsonb_typeof(p_day) is distinct from 'object'
    or jsonb_typeof(p_day->'open') is distinct from 'boolean'
    or jsonb_typeof(p_day->'blocks') is distinct from 'array'
    or jsonb_array_length(p_day->'blocks') > 24 then return false; end if;
  if coalesce(p_day->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(p_day->>'end','') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
    or (p_day->>'start')::time >= (p_day->>'end')::time then return false; end if;
  for v_block in select value from jsonb_array_elements(p_day->'blocks') loop
    if coalesce(v_block->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(v_block->>'end','') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
      or jsonb_typeof(v_block->'limit') is distinct from 'number'
      or coalesce(v_block->>'limit','') !~ '^[0-9]{1,10}$'
      or (v_block->>'limit')::numeric > 2147483647 then return false; end if;
    v_start := (v_block->>'start')::time;
    v_end := (v_block->>'end')::time;
    if v_start >= v_end or v_start < v_last then return false; end if;
    v_last := v_end;
  end loop;
  return true;
end $$;

create function public.recepta_scheduling_access(p_client uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.clients c join public.subscriptions s on s.client_id=c.id
    where c.id=p_client and not c.deletion_pending and s.plan_name='Recepta Pro' and s.status='active'
  );
$$;

create function public.recepta_save_scheduling_settings(p_client uuid, p_rules jsonb)
returns public.booking_settings language plpgsql security invoker set search_path = '' as $$
declare v_settings public.booking_settings; v_day record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client::text, 12738));
  perform 1 from public.clients where id=p_client for share;
  perform 1 from public.subscriptions where client_id=p_client for share;
  if not public.recepta_scheduling_access(p_client) then raise exception 'Active Recepta Pro required' using errcode='42501'; end if;
  if not exists (select 1 from pg_timezone_names where name=p_rules->>'time_zone' and (name like '%/%' or name='UTC'))
    or jsonb_typeof(p_rules->'weekly') is distinct from 'object'
    or jsonb_typeof(p_rules->'exceptions') is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_rules->'weekly')) <> 7
    or (select count(*) from jsonb_object_keys(p_rules->'exceptions')) > 366 then
    raise exception 'Invalid scheduling timezone or calendar rules' using errcode='22023';
  end if;
  for v_day in select * from jsonb_each(p_rules->'weekly') loop
    if v_day.key !~ '^[1-7]$' or not public.recepta_schedule_day_valid(v_day.value) then
      raise exception 'Invalid weekly schedule' using errcode='22023';
    end if;
  end loop;
  for v_day in select * from jsonb_each(p_rules->'exceptions') loop
    if v_day.key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or not public.recepta_schedule_day_valid(v_day.value) then
      raise exception 'Invalid date exception' using errcode='22023';
    end if;
    perform v_day.key::date;
  end loop;

  insert into public.booking_settings(client_id, enabled, capacity, duration_minutes, buffer_minutes,
    start_interval_minutes, time_zone, hourly_limit, weekly, exceptions, email_owner, email_customer)
  values(p_client,(p_rules->>'enabled')::boolean,(p_rules->>'capacity')::integer,(p_rules->>'duration_minutes')::integer,
    (p_rules->>'buffer_minutes')::integer,(p_rules->>'start_interval_minutes')::integer,p_rules->>'time_zone',
    (p_rules->>'hourly_limit')::integer,p_rules->'weekly',p_rules->'exceptions',
    (p_rules->>'email_owner')::boolean,(p_rules->>'email_customer')::boolean)
  on conflict(client_id) do update set enabled=excluded.enabled,capacity=excluded.capacity,
    duration_minutes=excluded.duration_minutes,buffer_minutes=excluded.buffer_minutes,
    start_interval_minutes=excluded.start_interval_minutes,time_zone=excluded.time_zone,hourly_limit=excluded.hourly_limit,
    weekly=excluded.weekly,exceptions=excluded.exceptions,email_owner=excluded.email_owner,
    email_customer=excluded.email_customer,updated_at=clock_timestamp()
  returning * into v_settings;
  return v_settings;
end $$;

-- Return all actual instants matching a wall time. The repeated hour can produce
-- two instants; a nonexistent spring-forward time produces none.
create function public.recepta_wall_time(p_wall timestamp, p_zone text)
returns setof timestamptz language sql stable security invoker set search_path = '' as $$
  select distinct candidate
  from unnest(array[p_wall, p_wall - interval '1 day', p_wall + interval '1 day']) sampled(wall)
  cross join lateral (
    select (p_wall + (wall at time zone p_zone - wall at time zone 'UTC')) at time zone 'UTC' as candidate
  ) resolved
  where candidate at time zone p_zone = p_wall;
$$;

create function public.recepta_schedule_stamp(p_instant timestamptz, p_zone text)
returns text language sql stable security invoker set search_path = '' as $$
  select to_char(p_instant at time zone p_zone,'YYYY-MM-DD"T"HH24:MI:SS')
    || case when minutes < 0 then '-' else '+' end
    || lpad((abs(minutes)/60)::text,2,'0') || ':' || lpad((abs(minutes)%60)::text,2,'0')
  from (select extract(epoch from ((p_instant at time zone p_zone)-(p_instant at time zone 'UTC')))::int / 60 as minutes) delta;
$$;

create function public.recepta_scheduling_slot(p_settings public.booking_settings, p_start timestamptz,
  p_exclude uuid default null, p_duration integer default null, p_buffer integer default null, p_existing boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_wall timestamp := p_start at time zone p_settings.time_zone;
  v_date date := v_wall::date;
  v_day jsonb := coalesce(p_settings.exceptions->v_date::text,p_settings.weekly->(extract(isodow from v_wall)::int)::text);
  v_open timestamp; v_close timestamptz; v_end timestamptz; v_occupied_end timestamptz;
  v_block jsonb; v_limit integer; v_block_start timestamp; v_block_end timestamp;
  v_starts integer := 0; v_peak integer := 0; v_reason text;
  v_duration integer := coalesce(p_duration,p_settings.duration_minutes);
  v_buffer integer := coalesce(p_buffer,p_settings.buffer_minutes);
begin
  if not p_existing and (p_start is null or p_start <= statement_timestamp()) then
    return jsonb_build_object('available',false,'reason','past_time');
  end if;
  if not coalesce((v_day->>'open')::boolean,false) then
    return jsonb_build_object('available',false,'reason','closed');
  end if;
  v_open := v_date+(v_day->>'start')::time;
  select max(t) into v_close from public.recepta_wall_time(v_date+(v_day->>'end')::time,p_settings.time_zone) t;
  if v_close is null then
    select min(t) into v_close
    from (
      select actual as t
      from generate_series(v_date+(v_day->>'end')::time,v_date::timestamp+interval '2 days',interval '1 minute') w
      cross join lateral public.recepta_wall_time(w,p_settings.time_zone) actual
      order by w,actual limit 1
    ) next_valid_wall_time;
  end if;
  v_end := p_start+make_interval(mins=>v_duration);
  v_occupied_end := v_end+make_interval(mins=>v_buffer);
  if v_wall < v_open or v_wall >= v_date+(v_day->>'end')::time or v_end > v_close then
    return jsonb_build_object('available',false,'reason','outside_booking_hours');
  end if;
  if mod(extract(epoch from (v_wall-v_open))::numeric,p_settings.start_interval_minutes*60) <> 0 then
    return jsonb_build_object('available',false,'reason','off_start_interval');
  end if;
  select value into v_block from jsonb_array_elements(v_day->'blocks')
    where v_wall::time >= (value->>'start')::time and v_wall::time < (value->>'end')::time;
  if found then
    v_limit := (v_block->>'limit')::integer;
    v_block_start := v_date+(v_block->>'start')::time;
    v_block_end := v_date+(v_block->>'end')::time;
  else
    v_limit := p_settings.hourly_limit;
    v_block_start := date_trunc('hour',v_wall);
    v_block_end := v_block_start+interval '1 hour';
  end if;

  if v_limit is not null then
    -- A custom block replaces the default hourly rule for starts inside it.
    -- The two occurrences of a fall-back wall-clock hour share its start limit.
    select count(*)::integer into v_starts
    from public.appointments a
    where a.client_id=p_settings.client_id and a.status='booked' and a.id is distinct from p_exclude
      and a.appointment_time >= (v_date::timestamp at time zone p_settings.time_zone)-interval '1 day'
      and a.appointment_time < ((v_date+1)::timestamp at time zone p_settings.time_zone)+interval '1 day'
      and a.appointment_time at time zone p_settings.time_zone >= v_block_start
      and a.appointment_time at time zone p_settings.time_zone < v_block_end
      and (v_block is not null or not exists (
        select 1 from jsonb_array_elements(v_day->'blocks') b
        where (a.appointment_time at time zone p_settings.time_zone)::time >= (b->>'start')::time
          and (a.appointment_time at time zone p_settings.time_zone)::time < (b->>'end')::time
      ));
    if v_starts >= v_limit then v_reason := 'hourly_capacity_reached'; end if;
  end if;

  if p_settings.capacity is not null then
    -- Count peak occupancy, not the number of appointments that intersect at
    -- any point. Each existing appointment keeps the duration and buffer it had when booked.
    with occupied as materialized (
      select a.appointment_time as starts,
        coalesce(a.appointment_end_time,a.appointment_time+make_interval(mins=>coalesce(a.duration_minutes,30)))
          +make_interval(mins=>a.booking_buffer_minutes) as ends
      from public.appointments a
      where a.client_id=p_settings.client_id and a.status='booked'
        and a.id is distinct from p_exclude and a.appointment_time < v_occupied_end
    ), overlapping as materialized (
      select greatest(starts,p_start) as starts, ends from occupied where ends > p_start
    ), deltas as (
      select starts as at_time,1 as change from overlapping
      union all select ends,-1 from overlapping
    ), grouped as (
      select at_time,sum(change) as change from deltas group by at_time
    )
    select coalesce(max(used),0)::integer into v_peak
    from (select sum(change) over (order by at_time) as used from grouped) running;
    if v_peak >= p_settings.capacity then v_reason := coalesce(v_reason,'simultaneous_capacity_reached'); end if;
  end if;
  return jsonb_build_object('available',v_reason is null,'reason',v_reason,
    'start',public.recepta_schedule_stamp(p_start,p_settings.time_zone),
    'end',public.recepta_schedule_stamp(v_end,p_settings.time_zone),
    'time_zone',p_settings.time_zone,'duration_minutes',v_duration,
    'hourly_remaining',case when v_limit is not null then greatest(v_limit-v_starts,0) end,
    'hourly_limit',v_limit,'simultaneous_limit',p_settings.capacity,
    'simultaneous_remaining',case when p_settings.capacity is not null then greatest(p_settings.capacity-v_peak,0) end);
end $$;

create function public.recepta_scheduling_availability(p_client uuid, p_date date, p_time time default null,
  p_start timestamptz default null, p_automatic boolean default true, p_appointment_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_settings public.booking_settings; v_date date; v_wall timestamp; v_today date;
  v_day jsonb; v_slot jsonb; v_slots jsonb := '[]'; v_matches timestamptz[];
  v_alternatives jsonb := '[]'; v_candidate timestamptz; v_result jsonb; v_appt public.appointments;
begin
  if not public.recepta_scheduling_access(p_client) then return '{"available":false,"reason":"pro_required","alternatives":[]}'::jsonb; end if;
  select * into v_settings from public.booking_settings where client_id=p_client;
  if p_automatic and not coalesce(v_settings.enabled,false) then
    return '{"available":false,"reason":"automatic_booking_disabled","alternatives":[]}'::jsonb;
  end if;
  if v_settings.client_id is null or v_settings.weekly='{}' then return '{"available":false,"reason":"schedule_not_set","alternatives":[]}'::jsonb; end if;
  if not p_automatic and p_appointment_id is not null then
    select * into v_appt from public.appointments where client_id=p_client and id=p_appointment_id and status='booked';
  end if;
  v_today := (statement_timestamp() at time zone v_settings.time_zone)::date;
  v_date := coalesce((p_start at time zone v_settings.time_zone)::date,p_date,v_today);
  if v_date > v_today+366 then return '{"available":false,"reason":"outside_booking_horizon","alternatives":[]}'::jsonb; end if;
  if p_start is not null then
    v_slot := public.recepta_scheduling_slot(v_settings,p_start);
  elsif p_time is not null then
    select array_agg(t order by t) into v_matches from public.recepta_wall_time(v_date+p_time,v_settings.time_zone) t;
    if cardinality(v_matches)=1 then
      v_slot := public.recepta_scheduling_slot(v_settings,v_matches[1]);
    elsif cardinality(v_matches)>1 then
      v_slot := '{"available":false,"reason":"ambiguous_local_time"}';
      select coalesce(jsonb_agg(item->>'start' order by t),'[]') into v_alternatives
      from unnest(v_matches) t cross join lateral public.recepta_scheduling_slot(v_settings,t) item
      where (item->>'available')::boolean;
    else
      v_slot := '{"available":false,"reason":"nonexistent_local_time"}';
    end if;
  else
    v_slot := '{"available":false,"reason":"choose_a_time"}';
  end if;
  if (v_slot->>'available')::boolean then return v_slot||jsonb_build_object('alternatives','[]'::jsonb); end if;

  -- Dashboard asks for all scheduled starts on a single date; Retell gets
  -- up to three real alternatives over the requested day and the following week.
  if p_start is not null then
    p_date := (p_start at time zone v_settings.time_zone)::date;
    p_time := (p_start at time zone v_settings.time_zone)::time;
  end if;
  for v_date in select greatest(v_date,v_today)+n from generate_series(0,case when p_automatic then 7 else 0 end) n
      where (p_automatic or v_date>=v_today) and greatest(v_date,v_today)+n<=v_today+366 loop
    v_day := coalesce(v_settings.exceptions->v_date::text,v_settings.weekly->(extract(isodow from v_date)::int)::text);
    if not coalesce((v_day->>'open')::boolean,false) then continue; end if;
    for v_candidate in
      select actual from generate_series(v_date+(v_day->>'start')::time,
        v_date+(v_day->>'end')::time-interval '1 minute',make_interval(mins=>v_settings.start_interval_minutes)) wall
      cross join lateral public.recepta_wall_time(wall,v_settings.time_zone) actual
      where actual>statement_timestamp() order by actual
    loop
      exit when p_automatic and jsonb_array_length(v_alternatives)>=3;
      v_wall := v_candidate at time zone v_settings.time_zone;
      if p_automatic and v_wall::date=p_date and p_time is not null and v_wall::time<p_time then continue; end if;
      v_result := public.recepta_scheduling_slot(v_settings,v_candidate,v_appt.id,v_appt.duration_minutes,v_appt.booking_buffer_minutes);
      if not p_automatic then
        v_slots := v_slots || jsonb_build_array(v_result||jsonb_build_object('wall_time',to_char(v_wall,'HH24:MI'),
          'start',public.recepta_schedule_stamp(v_candidate,v_settings.time_zone)));
      elsif (v_result->>'available')::boolean and not (v_alternatives ? (v_result->>'start')) then
        v_alternatives := v_alternatives || jsonb_build_array(v_result->>'start');
      end if;
    end loop;
    exit when p_automatic and jsonb_array_length(v_alternatives)>=3;
  end loop;
  return v_slot||jsonb_build_object('alternatives',v_alternatives,'slots',v_slots,'time_zone',v_settings.time_zone);
end $$;

create function public.recepta_appointment_conflicts(p_client uuid, p_ids uuid[])
returns table(appointment_id uuid, reason text) language sql stable security invoker set search_path = '' as $$
  select a.id, slot->>'reason'
  from public.booking_settings settings
  join public.appointments a on a.client_id=settings.client_id
  cross join lateral public.recepta_scheduling_slot(settings,a.appointment_time,a.id,a.duration_minutes,a.booking_buffer_minutes,true) slot
  where settings.client_id=p_client and settings.weekly<>'{}' and a.id=any(p_ids)
    and a.status='booked' and a.appointment_time>statement_timestamp()
    and (slot->>'available')::boolean=false;
$$;

create function public.recepta_queue_appointment_email(p_appointment public.appointments)
returns void language sql security invoker set search_path = '' as $$
  insert into public.service_jobs(job_key,client_id,kind,payload)
  select 'appointment:'||p_appointment.id||':'||p_appointment.booking_version||':'||recipient,
    p_appointment.client_id,'appointment_email',
    jsonb_build_object('appointment_id',p_appointment.id,'version',p_appointment.booking_version,'status',p_appointment.status,'recipient',recipient)
  from public.booking_settings settings
  cross join (values ('owner'),('customer')) audience(recipient)
  where settings.client_id=p_appointment.client_id
    and ((recipient='owner' and settings.email_owner)
      or (recipient='customer' and settings.email_customer and p_appointment.booking_email_consent and p_appointment.customer_email is not null))
  on conflict(job_key) do nothing;
$$;

create function public.recepta_change_appointment(p_client uuid, p_action text, p_start timestamptz default null,
  p_id uuid default null, p_version integer default null, p_call_id text default null, p_details jsonb default '{}',
  p_actor uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_settings public.booking_settings; v_appt public.appointments; v_previous timestamptz;
  v_slot jsonb; v_duration integer; v_buffer integer; v_new boolean := false;
begin
  if p_action is null or p_action not in ('book','confirm','reschedule','cancel') then raise exception 'Invalid appointment action' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client::text,12738));
  -- Lock the same authorization rows that billing and deletion update.
  perform 1 from public.clients where id=p_client for share;
  perform 1 from public.subscriptions where client_id=p_client for share;
  if not public.recepta_scheduling_access(p_client) then return '{"success":false,"reason":"pro_required"}'; end if;

  if p_action='book' then
    if nullif(btrim(p_call_id),'') is null or nullif(btrim(p_details->>'customer_name'),'') is null
      or nullif(btrim(p_details->>'customer_phone'),'') is null then
      return '{"success":false,"reason":"missing_caller_details"}';
    end if;
    select * into v_appt from public.appointments where client_id=p_client and retell_call_id=p_call_id for update;
    if found and v_appt.status<>'pending' then
      return jsonb_build_object('success',v_appt.status='booked' and p_start is not distinct from v_appt.appointment_time,
        'status',v_appt.status,'appointment_id',v_appt.id,
        'reason',case when v_appt.status='booked' and p_start is distinct from v_appt.appointment_time then 'call_already_booked' end,
        'start',public.recepta_schedule_stamp(v_appt.appointment_time,coalesce(v_appt.booking_time_zone,'UTC')),
        'duration_minutes',v_appt.duration_minutes,'time_zone',v_appt.booking_time_zone);
    end if;
  else
    select * into v_appt from public.appointments where client_id=p_client and id=p_id for update;
    if not found then return '{"success":false,"reason":"appointment_not_found"}'; end if;
    if p_version is distinct from v_appt.booking_version then return '{"success":false,"reason":"appointment_changed"}'; end if;
    if not ((p_action='cancel' and v_appt.status in ('pending','booked'))
      or (p_action='confirm' and v_appt.status='pending')
      or (p_action='reschedule' and v_appt.status='booked')) then return '{"success":false,"reason":"invalid_appointment_status"}'; end if;
  end if;

  v_previous := v_appt.appointment_time;
  if p_action='cancel' then
    update public.appointments set status='cancelled',booking_version=booking_version+1,updated_at=now()
      where id=v_appt.id returning * into v_appt;
  else
    select * into v_settings from public.booking_settings where client_id=p_client;
    if not found or v_settings.weekly='{}' then return '{"success":false,"reason":"schedule_not_set"}'; end if;
    if p_action='book' and not v_settings.enabled then return '{"success":false,"reason":"automatic_booking_disabled"}'; end if;
    if (p_start at time zone v_settings.time_zone)::date > (statement_timestamp() at time zone v_settings.time_zone)::date+366 then
      return '{"success":false,"reason":"outside_booking_horizon"}';
    end if;
    v_duration := case when p_action='reschedule' then coalesce(v_appt.duration_minutes,v_settings.duration_minutes) else v_settings.duration_minutes end;
    v_buffer := case when p_action='reschedule' then v_appt.booking_buffer_minutes else v_settings.buffer_minutes end;
    v_slot := public.recepta_scheduling_slot(v_settings,p_start,v_appt.id,v_duration,v_buffer);
    if not (v_slot->>'available')::boolean then return v_slot||'{"success":false}'::jsonb; end if;
    if p_action='reschedule' and p_start=v_previous then
      return v_slot||jsonb_build_object('success',true,'status','booked','appointment_id',v_appt.id);
    end if;

    if p_action='book' and v_appt.id is null then
      insert into public.appointments(client_id,retell_call_id,customer_name,customer_phone,customer_email,company_name,
        service,notes,source,status,appointment_time,appointment_end_time,duration_minutes,booking_buffer_minutes,
        booking_time_zone,booking_email_consent)
      values(p_client,p_call_id,p_details->>'customer_name',p_details->>'customer_phone',p_details->>'customer_email',
        p_details->>'company_name',p_details->>'service',p_details->>'notes','retell','booked',p_start,
        p_start+make_interval(mins=>v_duration),v_duration,v_buffer,v_settings.time_zone,
        coalesce((p_details->>'email_consent')::boolean,false))
      on conflict(retell_call_id) where retell_call_id is not null do nothing returning * into v_appt;
      if not found then return '{"success":false,"reason":"call_already_assigned"}'; end if;
      v_new := true;
    else
      update public.appointments set status='booked',appointment_time=p_start,appointment_end_time=p_start+make_interval(mins=>v_duration),
        duration_minutes=v_duration,booking_buffer_minutes=v_buffer,booking_time_zone=v_settings.time_zone,
        booking_version=booking_version+1,updated_at=now(),
        customer_name=coalesce(p_details->>'customer_name',customer_name),customer_phone=coalesce(p_details->>'customer_phone',customer_phone),
        customer_email=coalesce(p_details->>'customer_email',customer_email),company_name=coalesce(p_details->>'company_name',company_name),
        service=coalesce(p_details->>'service',service),notes=coalesce(p_details->>'notes',notes),
        booking_email_consent=coalesce((p_details->>'email_consent')::boolean,booking_email_consent)
        where id=v_appt.id returning * into v_appt;
    end if;
  end if;
  insert into public.appointment_history(appointment_id,client_id,action,previous_start,new_start,actor_id)
    values(v_appt.id,p_client,case when p_action='cancel' then 'cancelled' when p_action='reschedule' then 'rescheduled'
      when v_new then 'booked' else 'confirmed' end,v_previous,case when p_action<>'cancel' then p_start end,p_actor);
  if p_action<>'cancel' then perform public.recepta_queue_appointment_email(v_appt); end if;
  return coalesce(v_slot,'{}'::jsonb)||jsonb_build_object('success',true,'status',v_appt.status,'appointment_id',v_appt.id);
end $$;

-- Keep the pre-existing function signature and raw caller preferences. A
-- signed retry cannot re-create a cancelled booking or downgrade a confirmed one.
create or replace function public.capture_recepta_appointment_request(p_client_id uuid, p_call_id text, p_details jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_appt public.appointments; v_existing boolean;
begin
  if nullif(btrim(p_call_id),'') is null or nullif(btrim(p_details->>'customer_name'),'') is null then
    raise exception 'Caller name and provider call ID are required.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text,12738));
  perform 1 from public.clients where id=p_client_id for share;
  perform 1 from public.subscriptions where client_id=p_client_id for share;
  if not public.recepta_scheduling_access(p_client_id) then raise exception 'Active Recepta Pro required' using errcode='42501'; end if;
  select * into v_appt from public.appointments where client_id=p_client_id and retell_call_id=p_call_id;
  v_existing := found;
  if v_existing and v_appt.status<>'pending' then return jsonb_build_object('id',v_appt.id,'status',v_appt.status); end if;
  insert into public.appointments(client_id,retell_call_id,customer_name,customer_email,customer_phone,company_name,service,notes,
    requested_date,requested_time,requested_timezone,status,source,booking_email_consent)
  values(p_client_id,p_call_id,p_details->>'customer_name',p_details->>'customer_email',p_details->>'customer_phone',
    p_details->>'company_name',p_details->>'service',p_details->>'notes',p_details->>'requested_date',p_details->>'requested_time',
    p_details->>'requested_timezone','pending','retell',coalesce((p_details->>'email_consent')::boolean,false))
  on conflict(retell_call_id) where retell_call_id is not null do update set
    customer_name=coalesce(excluded.customer_name,appointments.customer_name),
    customer_email=coalesce(excluded.customer_email,appointments.customer_email),
    customer_phone=coalesce(excluded.customer_phone,appointments.customer_phone),
    company_name=coalesce(excluded.company_name,appointments.company_name),
    service=coalesce(excluded.service,appointments.service),notes=coalesce(excluded.notes,appointments.notes),
    requested_date=coalesce(excluded.requested_date,appointments.requested_date),
    requested_time=coalesce(excluded.requested_time,appointments.requested_time),
    requested_timezone=coalesce(excluded.requested_timezone,appointments.requested_timezone),
    booking_email_consent=coalesce((p_details->>'email_consent')::boolean,appointments.booking_email_consent),updated_at=now()
  where appointments.client_id=p_client_id and appointments.status='pending'
  returning * into v_appt;
  if not found then raise exception 'Could not capture this appointment request.'; end if;
  if not v_existing then
    insert into public.appointment_history(appointment_id,client_id,action) values(v_appt.id,p_client_id,'requested');
    perform public.recepta_queue_appointment_email(v_appt);
  end if;
  return jsonb_build_object('id',v_appt.id,'status',v_appt.status);
end $$;

-- Share the existing durable Resend queue, including its lease and retry window.
create or replace function public.claim_recepta_service_jobs(p_limit integer default 2,p_key text default null)
returns setof public.service_jobs language plpgsql security invoker set search_path='' as $$
begin
  update public.service_jobs set status='needs_attention',lease_token=null,lease_expires_at=null,
    last_error='Automatic email retries paused before the provider idempotency window expired.'
    where kind in ('callback_email','appointment_email') and status in ('queued','running') and first_send_at<now()-interval '23 hours'
    and (lease_expires_at is null or lease_expires_at<=now());
  return query update public.service_jobs j set status='running',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
    where j.job_key in(select q.job_key from public.service_jobs q where q.status in ('queued','running')
      and q.next_attempt_at<=now() and (q.lease_expires_at is null or q.lease_expires_at<=now())
      and (p_key is null or q.job_key=p_key) order by q.next_attempt_at,q.created_at
      for update skip locked limit least(greatest(p_limit,1),5)) returning j.*;
end $$;

create function public.recepta_clear_erased_appointment_mail()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.customer_name='Deleted caller' and old.customer_name is distinct from new.customer_name then
    update public.service_jobs set mail_payload=null,status='complete',completed_at=now(),lease_token=null,lease_expires_at=null
      where client_id=new.client_id and kind='appointment_email' and payload->>'appointment_id'=new.id::text;
  end if;
  return new;
end $$;
create trigger clear_erased_appointment_mail after update on public.appointments
  for each row execute function public.recepta_clear_erased_appointment_mail();

do $$ declare f record; begin
  for f in select oid::regprocedure as signature from pg_proc
    where pronamespace='public'::regnamespace and proname in (
      'recepta_schedule_day_valid','recepta_scheduling_access','recepta_save_scheduling_settings','recepta_wall_time',
      'recepta_schedule_stamp','recepta_scheduling_slot','recepta_scheduling_availability','recepta_queue_appointment_email',
      'recepta_change_appointment','recepta_appointment_conflicts','capture_recepta_appointment_request','recepta_clear_erased_appointment_mail'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
