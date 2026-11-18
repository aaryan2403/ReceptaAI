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

-- Only server-side authorized handlers can prepare an unpaid test account.
revoke all on function public.recepta_save_scheduling_settings(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.recepta_save_scheduling_settings(uuid, jsonb, boolean) to service_role;
