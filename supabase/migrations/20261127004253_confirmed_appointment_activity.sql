create index if not exists appointments_confirmed_activity_idx
  on public.appointments (client_id, created_at)
  where status in ('booked', 'completed');

-- The server derives the tenant and time zone from the authenticated account.
-- Day boundaries are local calendar midnights, including DST transitions.
create function public.recepta_confirmed_appointment_activity(p_client_id uuid, p_time_zone text)
returns table (day date, count bigint)
language sql stable security invoker set search_path = '' as $$
  with bounds as (
    select (statement_timestamp() at time zone p_time_zone)::date as today
  ), daily as (
    select (a.created_at at time zone p_time_zone)::date as day, count(*) as count
    from public.appointments a cross join bounds w
    where a.client_id = p_client_id
      and a.status in ('booked', 'completed')
      and a.created_at >= ((w.today - 6)::timestamp at time zone p_time_zone)
      and a.created_at <= statement_timestamp()
    group by 1
  )
  select w.today - d.days_ago, coalesce(daily.count, 0)
  from bounds w cross join generate_series(0, 6) d(days_ago)
  left join daily on daily.day = w.today - d.days_ago
  order by 1;
$$;

revoke all on function public.recepta_confirmed_appointment_activity(uuid, text) from public, anon, authenticated;
grant execute on function public.recepta_confirmed_appointment_activity(uuid, text) to service_role;
