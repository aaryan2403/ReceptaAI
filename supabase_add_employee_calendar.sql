-- Run this file once in the Supabase SQL Editor before deploying the code.
-- It is safe to run more than once.

alter table public.appointments
  add column if not exists employee_id uuid,
  add column if not exists appointment_end_time timestamptz,
  add column if not exists duration_minutes integer not null default 30,
  add column if not exists company_name text,
  add column if not exists notes text,
  add column if not exists internal_notes text,
  add column if not exists source text not null default 'dashboard',
  add column if not exists retell_call_id text,
  add column if not exists updated_at timestamptz not null default now();

update public.appointments
set appointment_end_time =
  appointment_time + make_interval(mins => greatest(duration_minutes, 1))
where appointment_time is not null
  and appointment_end_time is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_employee_id_fkey'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_employee_id_fkey
      foreign key (employee_id)
      references public.employees(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_duration_minutes_check'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_duration_minutes_check
      check (duration_minutes between 5 and 480);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_source_check'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_source_check
      check (source in ('retell', 'dashboard', 'admin', 'imported'));
  end if;
end;
$$;

create index if not exists appointments_employee_time_idx
  on public.appointments (employee_id, appointment_time)
  where status = 'booked';

create unique index if not exists appointments_retell_call_id_key
  on public.appointments (retell_call_id)
  where retell_call_id is not null;

create table if not exists public.employee_calendar_blocks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  title text not null,
  details text,
  block_type text not null default 'unavailable'
    check (block_type in ('unavailable', 'break', 'meeting', 'time_off')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create index if not exists employee_calendar_blocks_lookup_idx
  on public.employee_calendar_blocks (employee_id, starts_at, ends_at);

create table if not exists public.appointment_customer_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  company_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointment_customer_contacts_client_idx
  on public.appointment_customer_contacts (client_id, name);

alter table public.employee_calendar_blocks enable row level security;
alter table public.appointment_customer_contacts enable row level security;

drop policy if exists recepta_clients_read_own_calendar_blocks
  on public.employee_calendar_blocks;

create policy recepta_clients_read_own_calendar_blocks
  on public.employee_calendar_blocks
  for select
  to authenticated
  using (client_id = auth.uid());

drop policy if exists recepta_clients_manage_own_calendar_blocks
  on public.employee_calendar_blocks;

create policy recepta_clients_manage_own_calendar_blocks
  on public.employee_calendar_blocks
  for all
  to authenticated
  using (client_id = auth.uid())
  with check (client_id = auth.uid());

drop policy if exists recepta_clients_read_own_appointment_contacts
  on public.appointment_customer_contacts;

create policy recepta_clients_read_own_appointment_contacts
  on public.appointment_customer_contacts
  for select
  to authenticated
  using (client_id = auth.uid());

drop policy if exists recepta_clients_manage_own_appointment_contacts
  on public.appointment_customer_contacts;

create policy recepta_clients_manage_own_appointment_contacts
  on public.appointment_customer_contacts
  for all
  to authenticated
  using (client_id = auth.uid())
  with check (client_id = auth.uid());

create or replace function public.recepta_book_employee_appointment(
  p_client_id uuid,
  p_employee_id uuid,
  p_start timestamptz,
  p_duration_minutes integer,
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_company_name text default null,
  p_service text default null,
  p_notes text default null,
  p_internal_notes text default null,
  p_source text default 'dashboard',
  p_retell_call_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end timestamptz;
  v_appointment_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_client_id then
    raise exception 'You cannot book an appointment for another account.';
  end if;

  if p_duration_minutes < 5 or p_duration_minutes > 480 then
    raise exception 'Appointment duration must be between 5 and 480 minutes.';
  end if;

  if not exists (
    select 1
    from public.employees
    where id = p_employee_id
      and client_id = p_client_id
      and is_active = true
  ) then
    raise exception 'The selected employee is not active for this account.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));
  v_end := p_start + make_interval(mins => p_duration_minutes);

  if exists (
    select 1
    from public.appointments
    where employee_id = p_employee_id
      and status = 'booked'
      and appointment_time < v_end
      and coalesce(
        appointment_end_time,
        appointment_time + make_interval(mins => greatest(duration_minutes, 1))
      ) > p_start
  ) then
    raise exception 'That employee already has an appointment during this time.';
  end if;

  if exists (
    select 1
    from public.employee_calendar_blocks
    where employee_id = p_employee_id
      and starts_at < v_end
      and ends_at > p_start
  ) then
    raise exception 'That employee is unavailable during this time.';
  end if;

  insert into public.appointments (
    client_id,
    employee_id,
    customer_name,
    customer_email,
    customer_phone,
    company_name,
    service,
    notes,
    internal_notes,
    appointment_time,
    appointment_end_time,
    duration_minutes,
    status,
    source,
    retell_call_id,
    updated_at
  ) values (
    p_client_id,
    p_employee_id,
    nullif(trim(p_customer_name), ''),
    nullif(trim(coalesce(p_customer_email, '')), ''),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    nullif(trim(coalesce(p_company_name, '')), ''),
    nullif(trim(coalesce(p_service, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    nullif(trim(coalesce(p_internal_notes, '')), ''),
    p_start,
    v_end,
    p_duration_minutes,
    'booked',
    p_source,
    nullif(trim(coalesce(p_retell_call_id, '')), ''),
    now()
  )
  returning id into v_appointment_id;

  return v_appointment_id;
end;
$$;

create or replace function public.recepta_create_employee_block(
  p_client_id uuid,
  p_employee_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_title text,
  p_details text default null,
  p_block_type text default 'unavailable'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_block_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_client_id then
    raise exception 'You cannot block time for another account.';
  end if;

  if p_end <= p_start then
    raise exception 'The blocked time must end after it starts.';
  end if;

  if p_block_type not in ('unavailable', 'break', 'meeting', 'time_off') then
    raise exception 'Choose a valid blocked-time type.';
  end if;

  if not exists (
    select 1
    from public.employees
    where id = p_employee_id
      and client_id = p_client_id
  ) then
    raise exception 'The selected employee does not belong to this account.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  if exists (
    select 1
    from public.appointments
    where employee_id = p_employee_id
      and status = 'booked'
      and appointment_time < p_end
      and coalesce(
        appointment_end_time,
        appointment_time + make_interval(mins => greatest(duration_minutes, 1))
      ) > p_start
  ) then
    raise exception 'This blocked time overlaps an existing appointment.';
  end if;

  if exists (
    select 1
    from public.employee_calendar_blocks
    where employee_id = p_employee_id
      and starts_at < p_end
      and ends_at > p_start
  ) then
    raise exception 'This blocked time overlaps another calendar block.';
  end if;

  insert into public.employee_calendar_blocks (
    client_id,
    employee_id,
    title,
    details,
    block_type,
    starts_at,
    ends_at,
    updated_at
  ) values (
    p_client_id,
    p_employee_id,
    trim(p_title),
    nullif(trim(coalesce(p_details, '')), ''),
    p_block_type,
    p_start,
    p_end,
    now()
  )
  returning id into v_block_id;

  return v_block_id;
end;
$$;

revoke all on function public.recepta_book_employee_appointment(
  uuid, uuid, timestamptz, integer, text, text, text, text, text, text, text, text, text
) from public, anon;

grant execute on function public.recepta_book_employee_appointment(
  uuid, uuid, timestamptz, integer, text, text, text, text, text, text, text, text, text
) to authenticated, service_role;

revoke all on function public.recepta_create_employee_block(
  uuid, uuid, timestamptz, timestamptz, text, text, text
) from public, anon;

grant execute on function public.recepta_create_employee_block(
  uuid, uuid, timestamptz, timestamptz, text, text, text
) to authenticated, service_role;

comment on table public.employee_calendar_blocks is
  'Employee breaks, meetings, time off and other unavailable calendar periods.';

comment on table public.appointment_customer_contacts is
  'Optional saved customer list used to prefill Recepta appointment bookings.';

notify pgrst, 'reload schema';
