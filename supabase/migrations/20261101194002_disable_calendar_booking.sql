-- Retire the optional slot ledger and Google integration without deleting any
-- existing appointment requests, confirmed records, or migration history.
update public.booking_settings set enabled = false, updated_at = now() where enabled;

drop trigger if exists recepta_booking_capacity on public.appointments;
drop trigger if exists recepta_booking_calendar_queue on public.appointments;

-- Old deployments must not continue reserving slots, connecting calendars,
-- refreshing external events, or processing mirror jobs through the Data API.
do $$
declare t text; f record;
begin
  foreach t in array array[
    'booking_settings', 'google_calendar_connections',
    'google_calendar_oauth_states', 'booking_calendar_events', 'booking_calendar_jobs'
  ] loop
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;

  for f in
    select oid::regprocedure as signature from pg_proc
    where pronamespace = 'public'::regnamespace and proname in (
      'recepta_booking_remaining', 'guard_recepta_booking',
      'queue_recepta_calendar_booking', 'reserve_recepta_booking',
      'cancel_recepta_booking', 'update_recepta_booking_settings',
      'sync_recepta_calendar_snapshot', 'claim_recepta_calendar_jobs',
      'disconnect_recepta_calendar'
    )
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.signature);
  end loop;
end $$;

-- Keep the pre-existing server-only request intake permission intact.
grant execute on function public.capture_recepta_appointment_request(uuid, text, jsonb)
  to service_role;
