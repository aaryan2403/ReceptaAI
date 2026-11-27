-- Explicit operator opt-in for non-sensitive businesses only. Default is reference verification.
create table public.recepta_caller_name_lookup_enabled (
  client_id uuid primary key references public.clients(id) on delete cascade
);
alter table public.recepta_caller_name_lookup_enabled enable row level security;
revoke all on public.recepta_caller_name_lookup_enabled from public, anon, authenticated;
grant select, insert, delete on public.recepta_caller_name_lookup_enabled to service_role;

create function public.recepta_find_appointments_by_name(
  p_client uuid, p_agent text, p_call text, p_phone text, p_name text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  denied constant jsonb := '{"success":false,"reason":"reference_required"}';
  access jsonb; ids uuid[]; appointment_id uuid; record jsonb; records jsonb := '[]'::jsonb;
  normalized_name text := lower(btrim(regexp_replace(coalesce(p_name,''),'[[:space:]]+',' ','g')));
begin
  if length(normalized_name)<2 or length(normalized_name)>160
    or coalesce(p_phone,'') !~ '^\+[1-9][0-9]{7,14}$'
    or nullif(p_agent,'') is null or nullif(p_call,'') is null then return denied; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client::text,12738));
  if not exists (select 1 from public.recepta_caller_name_lookup_enabled e where e.client_id=p_client) then return denied; end if;
  access := public.recepta_service_access(p_client,p_agent);
  if access->>'plan' is distinct from 'Recepta Pro'
    or access->>'status' is distinct from 'active'
    or (access->>'can_reserve')::boolean is distinct from true
    or coalesce(access->>'agent_status','') not in ('live','testing')
    or (access->>'assignment_valid')::boolean is distinct from true
    or (access->>'appointments')::boolean is distinct from true
    or not exists (select 1 from public.call_minute_reservations r
      where r.client_id=p_client and r.retell_agent_id=p_agent and r.retell_call_id=p_call
        and r.status='active' and r.reserved_seconds>0
        and r.service_grant_id is not distinct from (access->>'grant_id')::uuid
        and r.period_end>clock_timestamp()
        and r.created_at+make_interval(secs=>r.reserved_seconds)>clock_timestamp())
  then return denied; end if;
  select array_agg(id) into ids from (
    select a.id from public.appointments a
    cross join lateral (select regexp_replace(coalesce(a.customer_phone,''),'[^0-9+]','','g') as raw) n
    where a.client_id=p_client and a.status='booked' and a.appointment_time>clock_timestamp()
      and a.customer_name<>'Deleted caller'
      and lower(btrim(regexp_replace(a.customer_name,'[[:space:]]+',' ','g')))=normalized_name
      and case when n.raw ~ '^[0-9]{10}$' then '+1'||n.raw
        when n.raw ~ '^1[0-9]{10}$' then '+'||n.raw else n.raw end=p_phone
    order by a.appointment_time,a.id limit 6
  ) matched;
  if coalesce(cardinality(ids),0) not between 1 and 5 then return denied; end if;
  foreach appointment_id in array ids loop
    record := public.recepta_caller_appointment(p_client,p_agent,p_call,p_phone,appointment_id::text,'find');
    if record->>'success' is distinct from 'true' then return denied; end if;
    records := records||jsonb_build_array(record);
  end loop;
  return jsonb_build_object('success',true,'appointments',records);
end $$;
revoke all on function public.recepta_find_appointments_by_name(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.recepta_find_appointments_by_name(uuid,text,text,text,text) to service_role;
