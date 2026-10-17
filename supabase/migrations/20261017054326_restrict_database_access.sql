-- Public visitors use the server's public pricing/demo endpoints. No application
-- table or privileged function needs anonymous Data API access.
revoke all on all tables in schema public from public,anon;
revoke all on all sequences in schema public from public,anon;
revoke create on schema public from public,anon,authenticated;
alter default privileges in schema public revoke all on tables from public,anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;

create schema if not exists recepta_private;
revoke all on schema recepta_private from public,anon;
grant usage on schema recepta_private to authenticated,service_role;

-- These narrow RLS lookups intentionally need the table owner's privileges to
-- avoid recursively applying clients' own policies. The schema is not exposed
-- by the Data API, and the functions only disclose the requester's own state.
create function recepta_private.is_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.clients where id=(select auth.uid()) and role='admin');
$$;
create function recepta_private.account_available() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.clients where id=(select auth.uid()) and not deletion_pending);
$$;
revoke all on all functions in schema recepta_private from public,anon,authenticated;
grant execute on function recepta_private.is_admin(),recepta_private.account_available() to authenticated,service_role;

create or replace function public.is_admin() returns boolean
language sql stable security invoker set search_path='' as $$
  select recepta_private.is_admin();
$$;
revoke all on function public.is_admin() from public,anon;
grant execute on function public.is_admin() to authenticated,service_role;

-- Browser code reads its own tenant rows. Financial records, call ledgers,
-- private queues, provider bindings and secrets are written only by the server.
revoke insert,update,delete,truncate,references,trigger on all tables in schema public from authenticated;
grant update(company_name,contact_email,status) on public.clients to authenticated;
grant update(agent_name,business_hours,status) on public.agents to authenticated;
grant all on all tables in schema public to service_role;

do $$ declare v_table text; r record; begin
  foreach v_table in array array['employees','employee_schedules','employee_schedule_overrides','onboarding'] loop
    if to_regclass('public.'||v_table) is not null then
      execute format('grant insert,update,delete on public.%I to authenticated',v_table);
    end if;
  end loop;
  for r in select tablename from pg_tables where schemaname='public' and tablename in
    ('clients','agents','subscriptions','calls','appointments','onboarding','employees','employee_schedules',
      'employee_schedule_overrides','employee_calendar_blocks','appointment_customer_contacts','agent_phone_numbers','customer_requests') loop
    execute format('alter table public.%I enable row level security',r.tablename);
    execute format('create policy account_available on public.%I as restrictive to authenticated using(recepta_private.is_admin() or recepta_private.account_available()) with check(recepta_private.is_admin() or recepta_private.account_available())',r.tablename);
  end loop;
  -- The former customer calendar tools are unused by appointment-request intake.
  for r in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('recepta_book_employee_appointment','recepta_create_employee_block') loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
  foreach v_table in array array['billing_notifications','call_notifications','call_minute_reservations','recepta_demo_links'] loop
    if to_regclass('public.'||v_table) is not null then
      execute format('create policy service_only on public.%I to service_role using(true) with check(true)',v_table);
    end if;
  end loop;
end $$;
