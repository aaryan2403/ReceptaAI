-- Requests retain preferences without claiming to reserve a calendar slot.
alter table public.appointments
  add column if not exists requested_date text,
  add column if not exists requested_time text,
  add column if not exists requested_timezone text,
  alter column duration_minutes drop not null,
  alter column duration_minutes drop default;

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('pending', 'booked', 'cancelled', 'completed'));
alter table public.appointments add constraint appointments_pending_has_no_slot
  check (status <> 'pending' or
    (appointment_time is null and appointment_end_time is null
      and duration_minutes is null and employee_id is null));

-- Atomically deduplicate tool retries. Never downgrade a confirmed/cancelled row.
create or replace function public.capture_recepta_appointment_request(
  p_client_id uuid, p_call_id text, p_details jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  if nullif(btrim(p_call_id), '') is null then
    raise exception 'A provider call ID is required.';
  end if;
  insert into public.appointments (
    client_id, retell_call_id, customer_name, customer_email, customer_phone,
    company_name, service, notes, requested_date, requested_time, requested_timezone,
    status, source, appointment_time, appointment_end_time, duration_minutes, employee_id
  ) values (
    p_client_id, p_call_id, p_details->>'customer_name', p_details->>'customer_email',
    p_details->>'customer_phone', p_details->>'company_name', p_details->>'service',
    p_details->>'notes', p_details->>'requested_date', p_details->>'requested_time',
    p_details->>'requested_timezone', 'pending', 'retell', null, null, null, null
  ) on conflict (retell_call_id) where retell_call_id is not null do update set
    customer_name = coalesce(excluded.customer_name, appointments.customer_name),
    customer_email = coalesce(excluded.customer_email, appointments.customer_email),
    customer_phone = coalesce(excluded.customer_phone, appointments.customer_phone),
    company_name = coalesce(excluded.company_name, appointments.company_name),
    service = coalesce(excluded.service, appointments.service),
    notes = excluded.notes,
    requested_date = coalesce(excluded.requested_date, appointments.requested_date),
    requested_time = coalesce(excluded.requested_time, appointments.requested_time),
    requested_timezone = coalesce(excluded.requested_timezone, appointments.requested_timezone),
    updated_at = now()
  where appointments.client_id = p_client_id and appointments.status = 'pending'
  returning jsonb_build_object('id', id, 'status', status) into v_result;

  if v_result is null then
    select jsonb_build_object('id', id, 'status', status) into v_result
      from public.appointments where client_id = p_client_id and retell_call_id = p_call_id;
  end if;
  if v_result is null then
    raise exception 'Could not capture this appointment request.';
  end if;
  return v_result;
end;
$$;
revoke all on function public.capture_recepta_appointment_request(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.capture_recepta_appointment_request(uuid, text, jsonb)
  to service_role;

comment on column public.appointments.requested_date is 'Caller preference, not a confirmed reservation.';
comment on column public.appointments.requested_time is 'Caller preference retained verbatim; no time slot is implied.';
