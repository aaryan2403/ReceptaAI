-- Run this file once in the Supabase SQL Editor before deploying the code.
-- It is safe to run more than once.

alter table public.subscriptions
  add column if not exists rollover_seconds bigint not null default 0
  check (rollover_seconds >= 0);

comment on column public.subscriptions.rollover_seconds is
  'Unused paid call time carried from completed billing periods. The current allowance is monthly_minutes * 60 plus rollover_seconds.';

