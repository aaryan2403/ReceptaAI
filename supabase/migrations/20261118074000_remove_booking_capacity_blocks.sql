-- Use one hourly limit for every open hour, including schedules with legacy blocks.
create or replace function public.recepta_scheduling_slot(p_settings public.booking_settings, p_start timestamptz,
  p_exclude uuid default null, p_duration integer default null, p_buffer integer default null, p_existing boolean default false)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_wall timestamp := p_start at time zone p_settings.time_zone;
  v_date date := v_wall::date;
  v_day jsonb := coalesce(p_settings.exceptions->v_date::text,p_settings.weekly->(extract(isodow from v_wall)::int)::text);
  v_open timestamp; v_close timestamptz; v_end timestamptz; v_occupied_end timestamptz;
  v_limit integer := p_settings.hourly_limit;
  v_hour_start timestamp := date_trunc('hour',v_wall);
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
  if v_limit is not null then
    -- The two occurrences of a fall-back wall-clock hour share its start limit.
    select count(*)::integer into v_starts
    from public.appointments a
    where a.client_id=p_settings.client_id and a.status='booked' and a.id is distinct from p_exclude
      and a.appointment_time >= (v_date::timestamp at time zone p_settings.time_zone)-interval '1 day'
      and a.appointment_time < ((v_date+1)::timestamp at time zone p_settings.time_zone)+interval '1 day'
      and a.appointment_time at time zone p_settings.time_zone >= v_hour_start
      and a.appointment_time at time zone p_settings.time_zone < v_hour_start+interval '1 hour';
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
