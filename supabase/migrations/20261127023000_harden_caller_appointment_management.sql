-- Caller moves must satisfy both the existing booking rules and configured store hours.
create function public.recepta_caller_store_hours_allow(p_hours text,p_start timestamptz,p_end timestamptz)
returns boolean language plpgsql stable security invoker set search_path='' as $$
declare
  config jsonb; hours jsonb; zone text; local_day date; day_rule jsonb; day_start date;
  opens time; closes time; first_open timestamptz; last_close timestamptz;
  names constant text[] := array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
begin
  if p_hours is null or lower(btrim(p_hours))='24/7' then return true; end if;
  begin
    config := p_hours::jsonb;
  exception when invalid_text_representation then
    -- Legacy free text has no structured store hours.
    return true;
  end;
  if jsonb_typeof(config)='array' then hours:=config;
  elsif config->>'mode'='custom' then hours:=config->'hours';
  else return true;
  end if;
  if jsonb_typeof(hours) is distinct from 'array' then return false; end if;
  if jsonb_array_length(hours)<>7 then return false; end if;
  zone:=coalesce(nullif(btrim(config->>'timeZone'),''),'America/Toronto');
  if not exists(select 1 from pg_timezone_names where name=zone) then return false; end if;
  local_day:=(p_start at time zone zone)::date;
  for day_start in select local_day union all select local_day-1 loop
    select value into day_rule from jsonb_array_elements(hours)
      where value->>'day'=names[extract(isodow from day_start)::integer];
    if day_rule->>'open' is distinct from 'true'
      or coalesce(day_rule->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(day_rule->>'end','') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then continue; end if;
    opens:=(day_rule->>'start')::time;
    closes:=(day_rule->>'end')::time;
    if opens=closes then continue; end if;
    select min(t) into first_open from public.recepta_wall_time(day_start+opens,zone) t;
    select max(t) into last_close from public.recepta_wall_time(
      (day_start+case when closes<opens then 1 else 0 end)+closes,zone) t;
    if p_start>=first_open and p_start<last_close and p_end<=last_close then return true; end if;
  end loop;
  return false;
end $$;
revoke all on function public.recepta_caller_store_hours_allow(text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.recepta_caller_store_hours_allow(text,timestamptz,timestamptz) to service_role;

create index appointments_caller_reference_idx on public.appointments
  (client_id, (left(replace(id::text,'-',''),12)));

-- Reuse the existing tenant lock, scheduling engine, versioned ledger and mail queue.
-- These functions accept identity only from the server after Retell signature verification.
create function public.recepta_caller_appointment(
  p_client uuid, p_agent text, p_call text, p_phone text, p_reference text,
  p_action text, p_version integer default null, p_date date default null,
  p_time time default null, p_confirmed boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  a public.appointments; s public.booking_settings; access jsonb; agent_hours text; appointment_ids uuid[];
  denied jsonb := '{"success":false,"reason":"verification_failed"}';
  result jsonb; matches timestamptz[]; target timestamptz; stored text;
  alternatives jsonb := '[]'; candidate jsonb; day_offset integer;
begin
  if p_action is null or p_action not in ('find','check','reschedule','cancel')
    or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
    or nullif(p_agent,'') is null or nullif(p_call,'') is null or coalesce(p_reference,'') !~ '^([0-9a-f]{12}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$' then
    return denied;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client::text,12738));
  perform 1 from public.clients where id=p_client for share;
  perform 1 from public.subscriptions where client_id=p_client for share;
  select business_hours into agent_hours from public.agents where client_id=p_client and retell_agent_id=p_agent for share;
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
        and r.service_grant_id is not distinct from (access->>'grant_id')::uuid and r.period_end>clock_timestamp()
        and r.created_at+make_interval(secs=>r.reserved_seconds)>clock_timestamp()) then
    return '{"success":false,"reason":"service_unavailable"}';
  end if;
  if length(p_reference)=12 and p_action='find' then
    select array_agg(id) into appointment_ids from (
      select id from public.appointments
      where client_id=p_client and left(replace(id::text,'-',''),12)=p_reference limit 2
    ) ids;
    -- A short reference must identify exactly one appointment within the tenant.
    if coalesce(cardinality(appointment_ids),0)<>1 then return denied; end if;
  elsif length(p_reference)>12 then
    appointment_ids := array[p_reference::uuid];
  else
    return denied;
  end if;
  select * into a from public.appointments where client_id=p_client and id=appointment_ids[1] for update;
  if not found or a.customer_name='Deleted caller' then return denied; end if;
  stored := regexp_replace(coalesce(a.customer_phone,''),'[^0-9+]','','g');
  if stored ~ '^[0-9]{10}$' then stored := '+1'||stored;
  elsif stored ~ '^1[0-9]{10}$' then stored := '+'||stored; end if;
  if stored is distinct from p_phone then return denied; end if;
  if p_action='find' then
    if a.status<>'booked' or a.appointment_time is null or a.appointment_time<=clock_timestamp() then return denied; end if;
    return jsonb_build_object('success',true,'status','booked','appointment_id',a.id,
      'booking_version',a.booking_version,'start',public.recepta_schedule_stamp(a.appointment_time,coalesce(a.booking_time_zone,'UTC')),
      'time_zone',coalesce(a.booking_time_zone,'UTC'),'duration_minutes',a.duration_minutes);
  end if;
  if p_version is null then return denied; end if;
  if p_action='cancel' then
    if p_confirmed is distinct from true then return '{"success":false,"reason":"confirmation_required"}'; end if;
    if a.status='cancelled' and a.booking_version=p_version+1 then
      return jsonb_build_object('success',true,'status','cancelled','appointment_id',a.id,'booking_version',a.booking_version,'already_applied',true);
    end if;
  else
    if p_date is null or p_time is null then return '{"success":false,"reason":"invalid_local_date_or_time"}'; end if;
    select * into s from public.booking_settings where client_id=p_client;
    if not found or not s.enabled then return '{"success":false,"reason":"automatic_booking_disabled"}'; end if;
    if p_date>(clock_timestamp() at time zone s.time_zone)::date+366 then
      return '{"success":false,"reason":"outside_booking_horizon","alternatives":[]}';
    end if;
    select array_agg(t order by t) into matches from public.recepta_wall_time(p_date+p_time,s.time_zone) t;
    if cardinality(matches)=1 then target:=matches[1]; end if;
    if p_action='reschedule' and a.status='booked' and a.booking_version=p_version+1 and a.appointment_time=target then
      return jsonb_build_object('success',true,'status','booked','appointment_id',a.id,'booking_version',a.booking_version,
        'start',public.recepta_schedule_stamp(a.appointment_time,coalesce(a.booking_time_zone,'UTC')),
        'time_zone',coalesce(a.booking_time_zone,'UTC'),'already_applied',true);
    end if;
  end if;
  if a.booking_version is distinct from p_version then return '{"success":false,"reason":"appointment_changed"}'; end if;
  if a.status<>'booked' or a.appointment_time is null or a.appointment_time<=clock_timestamp() then
    return '{"success":false,"reason":"appointment_not_eligible"}';
  end if;
  if p_action='cancel' then
    result:=public.recepta_change_appointment(p_client,p_action,null,a.id,p_version);
  elsif target is null then
    result:=jsonb_build_object('success',false,'available',false,'reason',
      case when cardinality(matches)>1 then 'ambiguous_local_time' else 'nonexistent_local_time' end);
  elsif not public.recepta_caller_store_hours_allow(agent_hours,target,
      target+make_interval(mins=>coalesce(a.duration_minutes,s.duration_minutes))) then
    result:='{"success":false,"available":false,"reason":"outside_store_hours"}';
  elsif p_action='check' then
    result:=public.recepta_scheduling_slot(s,target,a.id,a.duration_minutes,a.booking_buffer_minutes);
    if (result->>'available')::boolean then return result||'{"alternatives":[]}'::jsonb; end if;
  else
    -- The existing RPC rechecks capacity under the same tenant lock as ordinary booking.
    result:=public.recepta_change_appointment(p_client,p_action,target,a.id,p_version);
  end if;
  if (result->>'success')::boolean is true then
    select * into a from public.appointments where client_id=p_client and id=appointment_ids[1];
    if p_action='cancel' then
      perform public.recepta_queue_appointment_email(a);
    elsif a.booking_version>p_version then
      update public.service_jobs set payload=payload||'{"action":"rescheduled"}'::jsonb
        where job_key in ('appointment:'||a.id||':'||a.booking_version||':owner',
                          'appointment:'||a.id||':'||a.booking_version||':customer');
    end if;
    return result||jsonb_build_object('booking_version',a.booking_version);
  end if;
  if p_action in ('reschedule','check') then
    -- Reuse the existing availability engine in appointment-aware mode (excludes this booking).
    for day_offset in 0..7 loop
      exit when jsonb_array_length(alternatives)>=3;
      if p_date+day_offset>(clock_timestamp() at time zone s.time_zone)::date+366 then exit; end if;
      for candidate in select value from jsonb_array_elements(coalesce(
        public.recepta_scheduling_availability(p_client,p_date+day_offset,null,null,false,a.id)->'slots','[]'::jsonb))
      loop
        exit when jsonb_array_length(alternatives)>=3;
        if (candidate->>'available')::boolean is true and (candidate->>'start')::timestamptz<>a.appointment_time
          and (day_offset>0 or (candidate->>'wall_time')::time>=p_time)
          and (select count(*)=1 from public.recepta_wall_time(p_date+day_offset+(candidate->>'wall_time')::time,s.time_zone))
          and public.recepta_caller_store_hours_allow(agent_hours,(candidate->>'start')::timestamptz,(candidate->>'end')::timestamptz) then
          alternatives:=alternatives||jsonb_build_array(candidate->>'start');
        end if;
      end loop;
    end loop;
    return result||jsonb_build_object('alternatives',alternatives,'time_zone',s.time_zone,'available',false);
  end if;
  return result;
end $$;
revoke all on function public.recepta_caller_appointment(uuid,text,text,text,text,text,integer,date,time,boolean) from public,anon,authenticated;
grant execute on function public.recepta_caller_appointment(uuid,text,text,text,text,text,integer,date,time,boolean) to service_role;

-- Supersede the draft UUID-only RPC before the updated preview is deployed.
drop function public.recepta_caller_appointment(uuid,text,text,text,uuid,text,integer,date,time,boolean);

create or replace function public.recepta_caller_management_sync_candidates()
returns table(client_id uuid,agent_id text) language sql security invoker set search_path='' as $$
  select b.client_id,a.retell_agent_id
  from public.booking_settings b join public.agents a on a.client_id=b.client_id
  cross join lateral public.recepta_service_access(b.client_id,a.retell_agent_id) access
  where a.retell_agent_id is not null and access->>'plan'='Recepta Pro'
    and (access->>'assignment_valid')::boolean is true and access->>'retention_operation' is null
    and b.caller_management_synced_agent_id is distinct from a.retell_agent_id
    and (b.caller_management_sync_attempted_at is null or b.caller_management_sync_attempted_at<clock_timestamp()-interval '15 minutes')
  order by b.caller_management_sync_attempted_at nulls first,b.client_id limit 1;
$$;
