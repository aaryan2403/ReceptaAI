alter table public.subscriptions
  add column if not exists current_period_start timestamptz,
  add column if not exists current_period_end timestamptz;

update public.subscriptions
set
  current_period_start = coalesce(
    current_period_start,
    now()
  ),
  current_period_end = coalesce(
    current_period_end,
    next_billing_date,
    now() + interval '1 month'
  );

create table if not exists public.call_minute_reservations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  period_start timestamptz not null,
  reserved_seconds integer not null check (reserved_seconds >= 60),
  used_seconds integer,
  status text not null default 'active'
    check (status in ('active', 'completed', 'expired')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.call_minute_reservations
  enable row level security;

create index if not exists call_minute_reservations_client_status_idx
  on public.call_minute_reservations (
    client_id,
    status,
    period_start
  );

create or replace function public.reserve_recepta_call(
  p_client_id uuid,
  p_monthly_seconds bigint,
  p_period_start timestamptz
)
returns table (
  reservation_id uuid,
  reserved_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used_seconds bigint := 0;
  v_reserved_seconds bigint := 0;
  v_remaining_seconds bigint := 0;
  v_reservation_id uuid;
  v_seconds_to_reserve integer;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(p_client_id::text, 0)
  );

  update public.call_minute_reservations
  set status = 'expired'
  where client_id = p_client_id
    and status = 'active'
    and created_at < now() - interval '3 hours';

  select coalesce(
    sum(greatest(duration_seconds, 0)),
    0
  )
  into v_used_seconds
  from public.calls
  where client_id = p_client_id
    and started_at >= p_period_start;

  select coalesce(sum(r.reserved_seconds), 0)
  into v_reserved_seconds
  from public.call_minute_reservations r
  where r.client_id = p_client_id
    and r.period_start = p_period_start
    and r.status = 'active';

  v_remaining_seconds :=
    greatest(
      p_monthly_seconds -
      v_used_seconds -
      v_reserved_seconds,
      0
    );

  if v_remaining_seconds < 60 then
    return;
  end if;

  v_seconds_to_reserve := least(
    v_remaining_seconds,
    180
  )::integer;

  insert into public.call_minute_reservations (
    client_id,
    period_start,
    reserved_seconds
  )
  values (
    p_client_id,
    p_period_start,
    v_seconds_to_reserve
  )
  returning id into v_reservation_id;

  return query
  select
    v_reservation_id,
    v_seconds_to_reserve;
end;
$$;

revoke all on function public.reserve_recepta_call(
  uuid,
  bigint,
  timestamptz
) from public;

grant execute on function public.reserve_recepta_call(
  uuid,
  bigint,
  timestamptz
) to service_role;

comment on table public.call_minute_reservations is
  'Atomic reservations that prevent concurrent Retell calls from exceeding a client monthly allowance.';
