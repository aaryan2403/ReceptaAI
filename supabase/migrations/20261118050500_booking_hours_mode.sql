-- One simple per-tenant choice: book within store hours or allow booking anytime.
-- The backend still applies the configured per-hour booking limit in either mode.
alter table public.booking_settings
  add column booking_hours_mode text not null default 'store_hours'
  check (booking_hours_mode in ('store_hours', 'anytime'));

create or replace function public.recepta_save_scheduling_settings(p_client uuid, p_rules jsonb, p_prepare boolean)
returns public.booking_settings language plpgsql security invoker set search_path = '' as $$
declare v_settings public.booking_settings; v_day record; v_mode text := coalesce(p_rules->>'booking_hours_mode', 'store_hours');
begin
  perform pg_advisory_xact_lock(hashtextextended(p_client::text, 12738));
  perform 1 from public.clients where id=p_client and not deletion_pending for share;
  if not found then raise exception 'Client unavailable' using errcode='42501'; end if;
  if p_prepare is not true then
    perform 1 from public.subscriptions where client_id=p_client for share;
    if not public.recepta_scheduling_access(p_client) then
      raise exception 'Active Recepta Pro required' using errcode='42501';
    end if;
  end if;
  if not exists (select 1 from pg_timezone_names where name=p_rules->>'time_zone' and (name like '%/%' or name='UTC'))
    or jsonb_typeof(p_rules->'weekly') is distinct from 'object'
    or jsonb_typeof(p_rules->'exceptions') is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_rules->'weekly')) <> 7
    or (select count(*) from jsonb_object_keys(p_rules->'exceptions')) > 366 then
    raise exception 'Invalid scheduling timezone or calendar rules' using errcode='22023';
  end if;
  if v_mode not in ('store_hours', 'anytime') then
    raise exception 'Invalid booking hours mode' using errcode='22023';
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
    start_interval_minutes, time_zone, hourly_limit, weekly, exceptions, email_owner, email_customer, booking_hours_mode)
  values(p_client,(p_rules->>'enabled')::boolean,(p_rules->>'capacity')::integer,(p_rules->>'duration_minutes')::integer,
    (p_rules->>'buffer_minutes')::integer,(p_rules->>'start_interval_minutes')::integer,p_rules->>'time_zone',
    (p_rules->>'hourly_limit')::integer,p_rules->'weekly',p_rules->'exceptions',
    (p_rules->>'email_owner')::boolean,(p_rules->>'email_customer')::boolean,v_mode)
  on conflict(client_id) do update set enabled=excluded.enabled,capacity=excluded.capacity,
    duration_minutes=excluded.duration_minutes,buffer_minutes=excluded.buffer_minutes,
    start_interval_minutes=excluded.start_interval_minutes,time_zone=excluded.time_zone,hourly_limit=excluded.hourly_limit,
    weekly=excluded.weekly,exceptions=excluded.exceptions,email_owner=excluded.email_owner,
    email_customer=excluded.email_customer,booking_hours_mode=excluded.booking_hours_mode,updated_at=clock_timestamp()
  returning * into v_settings;
  return v_settings;
end $$;

-- Preserve 24/7 availability for appointments that cross local midnight.
create or replace function public.recepta_scheduling_slot(p_settings public.booking_settings, p_start timestamptz,
  p_exclude uuid default null, p_duration integer default null, p_buffer integer default null, p_existing boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = '' as $
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
  -- A continuously open 24/7 calendar must permit appointments that cross
  -- local midnight, while retaining per-hour start limits on each day.
  if p_settings.booking_hours_mode = 'anytime' or
    (v_day->>'start' = '00:00' and v_day->>'end' = '24:00'
     and not exists (
       select 1 from jsonb_each(p_settings.weekly) x
       where x.value->>'start' <> '00:00' or x.value->>'end' <> '24:00'
          or x.value->>'open' <> 'true'
     )) then
    v_close := v_end;
  end if;
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
    v_block_start := greatest(v_date+(v_block->>'start')::time, date_trunc('hour',v_wall));
    v_block_end := least(v_date+(v_block->>'end')::time, date_trunc('hour',v_wall)+interval '1 hour');
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
end $;

-- Only server-side authorized handlers can prepare an unpaid test account.
revoke all on function public.recepta_save_scheduling_settings(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.recepta_save_scheduling_settings(uuid, jsonb, boolean) to service_role;
