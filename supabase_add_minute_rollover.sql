-- Run this file once in the Supabase SQL Editor before deploying the code.
-- It is safe to run more than once.

alter table public.subscriptions
  add column if not exists rollover_seconds bigint not null default 0
  check (rollover_seconds >= 0);

update public.subscriptions
set rollover_seconds = least(
  greatest(coalesce(rollover_seconds, 0), 0),
  greatest(coalesce(monthly_minutes, 0), 0)::bigint * 60
)
where rollover_seconds is not null;

comment on column public.subscriptions.rollover_seconds is
  'Unused paid call time carried into the current billing period. It is capped at one monthly allowance and replaced at each paid renewal.';
