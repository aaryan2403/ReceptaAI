-- Admission records continue to authenticate signed call tools and cap call duration.
-- Their maximum possible durations are not billable usage or balance holds.
-- Only reported actual durations are charged. Concurrent calls may overshoot
-- the remaining allowance before their provider usage is reported.
create or replace function public.recepta_committed_usage(p_client_id uuid,p_period_start timestamptz,p_period_end timestamptz)
returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce(sum(amount),0)::bigint from (
    select greatest(coalesce(r.used_seconds,0),coalesce(c.duration_seconds,0),0)::bigint as amount
    from public.call_minute_reservations r left join public.calls c
      on c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
    where r.client_id=p_client_id and r.period_start=p_period_start
    union all
    select greatest(coalesce(c.duration_seconds,0),0)::bigint
    from public.calls c
    where c.client_id=p_client_id and c.started_at>=p_period_start and c.started_at<p_period_end
      and not exists(select 1 from public.call_minute_reservations r
        where r.client_id=c.client_id and r.retell_call_id=c.retell_call_id)
  ) usage;
$$;

create or replace function public.recepta_service_grant_usage(p_grant uuid,p_period_start timestamptz)
returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce(sum(greatest(coalesce(r.used_seconds,0),coalesce(c.duration_seconds,0),0)),0)::bigint
  from public.call_minute_reservations r left join public.calls c
    on c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
  where r.service_grant_id=p_grant and r.period_start=p_period_start;
$$;

create or replace function public.recepta_service_grant_usage(p_grant uuid)
returns bigint language sql stable security invoker set search_path='' as $$
  select coalesce(sum(greatest(coalesce(r.used_seconds,0),coalesce(c.duration_seconds,0),0)),0)::bigint
  from public.call_minute_reservations r left join public.calls c
    on c.client_id=r.client_id and c.retell_call_id=r.retell_call_id
  where r.service_grant_id=p_grant;
$$;

revoke all on function public.recepta_committed_usage(uuid,timestamptz,timestamptz),public.recepta_service_grant_usage(uuid,timestamptz),public.recepta_service_grant_usage(uuid) from public,anon,authenticated;
grant execute on function public.recepta_committed_usage(uuid,timestamptz,timestamptz),public.recepta_service_grant_usage(uuid,timestamptz),public.recepta_service_grant_usage(uuid) to service_role;
