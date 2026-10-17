alter table public.clients add column deletion_pending boolean not null default false,
  add column call_retention_days integer not null default 90 check(call_retention_days between 7 and 365);

create table public.callback_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  retell_call_id text not null unique,
  caller_number text,
  called_number text,
  reason text not null check(reason in ('outside_answering_hours','agent_unavailable','allowance_unavailable','admission_unavailable')),
  status text not null default 'pending' check(status in ('pending','contacted','resolved','unreachable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index callback_requests_client_idx on public.callback_requests(client_id,created_at desc);
alter table public.callback_requests enable row level security;
revoke all on public.callback_requests from public,anon,authenticated;
grant select,insert,update,delete on public.callback_requests to service_role;

-- Provider cleanup and callback email are durable jobs. Deletion tombstones must
-- survive removal of the account, so client_id deliberately has no foreign key.
create table public.service_jobs (
  job_key text primary key,
  client_id uuid,
  kind text not null check(kind in ('callback_email','delete_client','retention_call')),
  payload jsonb not null default '{}',
  status text not null default 'queued' check(status in ('queued','running','complete','needs_attention')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  mail_payload jsonb,
  first_send_at timestamptz,
  provider_message_id text,
  delivery_status text,
  delivery_event_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index service_jobs_due_idx on public.service_jobs(next_attempt_at,created_at) where status in ('queued','running');
create index service_jobs_client_idx on public.service_jobs(client_id);
create index service_jobs_provider_idx on public.service_jobs(provider_message_id) where provider_message_id is not null;
alter table public.service_jobs enable row level security;
revoke all on public.service_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.service_jobs to service_role;

create function public.record_recepta_callback(p_client_id uuid,p_call_id text,p_from text,p_to text,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
  if not exists(select 1 from public.clients where id=p_client_id and not deletion_pending) then return; end if;
  insert into public.callback_requests(client_id,retell_call_id,caller_number,called_number,reason)
    values(p_client_id,p_call_id,p_from,p_to,p_reason) on conflict(retell_call_id) do nothing returning id into v_id;
  if v_id is not null then
    insert into public.service_jobs(job_key,client_id,kind,payload)
      values('callback:'||p_client_id::text||':'||p_call_id,p_client_id,'callback_email',jsonb_build_object('callback_id',v_id));
  end if;
end $$;

create function public.claim_recepta_service_jobs(p_limit integer default 2,p_key text default null)
returns setof public.service_jobs language plpgsql security invoker set search_path='' as $$
begin
  update public.service_jobs set status='needs_attention',lease_token=null,lease_expires_at=null,
    last_error='Automatic email retries paused before the provider idempotency window expired.'
    where kind='callback_email' and status in ('queued','running') and first_send_at<now()-interval '23 hours'
    and (lease_expires_at is null or lease_expires_at<=now());
  return query update public.service_jobs j set status='running',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes'
    where j.job_key in(select q.job_key from public.service_jobs q where q.status in ('queued','running')
      and q.next_attempt_at<=now() and (q.lease_expires_at is null or q.lease_expires_at<=now())
      and (p_key is null or q.job_key=p_key) order by q.next_attempt_at,q.created_at
      for update skip locked limit least(greatest(p_limit,1),5)) returning j.*;
end $$;

create function public.finish_recepta_service_job(p_key text,p_lease uuid,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.service_jobs set status=case when p_error is null then 'complete' when attempts>=12 then 'needs_attention' else 'queued' end,
    completed_at=case when p_error is null then now() else null end,last_error=left(p_error,500),
    next_attempt_at=now()+interval '5 minutes',lease_token=null,lease_expires_at=null,
    payload=case when p_error is null and kind='delete_client' then '{}'::jsonb else payload end
    where job_key=p_key and lease_token=p_lease and status='running';
  return found;
end $$;

create function public.start_recepta_client_deletion(p_client_id uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare v_job text:='delete-client:'||p_client_id::text; v_client public.clients%rowtype; v_payload jsonb;
begin
  select * into v_client from public.clients where id=p_client_id for update;
  if not found then
    if exists(select 1 from public.service_jobs where job_key=v_job) then return v_job; end if;
    raise exception 'Client not found';
  end if;
  if v_client.role='admin' then raise exception 'An admin account cannot be deleted here'; end if;
  perform 1 from public.subscriptions where client_id=p_client_id for update;
  select jsonb_build_object('stripe_customer_id',s.stripe_customer_id,'stripe_subscription_id',s.stripe_subscription_id,
    'agent_id',a.retell_agent_id,'numbers',coalesce((select jsonb_agg(jsonb_build_object('number',n.phone_number,'source',n.source)) from public.agent_phone_numbers n where n.client_id=p_client_id),'[]'::jsonb))
    into v_payload from public.clients c left join public.subscriptions s on s.client_id=c.id
    left join public.agents a on a.client_id=c.id where c.id=p_client_id;
  v_payload:=jsonb_set(v_payload,'{numbers}',coalesce(v_payload->'numbers','[]'::jsonb)||coalesce((
    select jsonb_agg(jsonb_build_object('number',a.phone_number,'source','manual')) from public.agents a
    where a.client_id=p_client_id and a.phone_number is not null and not exists(
      select 1 from public.agent_phone_numbers n where n.client_id=p_client_id and n.phone_number=a.phone_number)
  ),'[]'::jsonb));
  insert into public.service_jobs(job_key,client_id,kind,payload) values(v_job,p_client_id,'delete_client',v_payload)
    on conflict(job_key) do nothing;
  update public.clients set deletion_pending=true,status='paused' where id=p_client_id;
  update public.agents set status='paused' where client_id=p_client_id;
  return v_job;
end $$;

-- Pause call admission and financial changes throughout cleanup, including late
-- paid webhooks. Existing provider IDs remain available until cleanup succeeds.
create function public.guard_recepta_deleting_client() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.clients where id=new.client_id and deletion_pending) then
    if tg_table_name='agents' then new.status:='paused';
    elsif new.status='active' then new.status:='cancelled'; end if;
  end if;
  return new;
end $$;
create trigger guard_deleting_agent before insert or update on public.agents
  for each row execute function public.guard_recepta_deleting_client();
create trigger guard_deleting_subscription before insert or update on public.subscriptions
  for each row execute function public.guard_recepta_deleting_client();

create function public.guard_recepta_deleting_number() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_deleting boolean;
begin
  -- Serialize insertion with deletion's client lock so a purchased number
  -- cannot appear after the deletion snapshot was taken.
  select deletion_pending into v_deleting from public.clients where id=new.client_id for share;
  if v_deleting then raise exception 'Client is awaiting deletion'; end if;
  return new;
end $$;
create trigger guard_deleting_number before insert or update on public.agent_phone_numbers
  for each row execute function public.guard_recepta_deleting_number();

alter table public.call_notifications add column delivery_status text, add column delivery_event_at timestamptz;
alter table public.billing_notifications add column delivery_status text, add column delivery_event_at timestamptz;
alter table public.billing_notifications add column provider_message_id text, add column mail_payload jsonb,
  add column first_send_at timestamptz;
create index call_notifications_provider_idx on public.call_notifications(provider_message_id) where provider_message_id is not null;
create index billing_notifications_provider_idx on public.billing_notifications(provider_message_id) where provider_message_id is not null;

create table public.integration_settings(key text primary key,value jsonb not null,updated_at timestamptz not null default now());
alter table public.integration_settings enable row level security;
revoke all on public.integration_settings from public,anon,authenticated;
grant select,insert,update,delete on public.integration_settings to service_role;

-- Signed delivery events can arrive before send acceptance is saved. Retain a
-- small receipt ledger and reconcile again when the provider ID is persisted.
create table public.email_delivery_receipts (
  event_id text primary key,provider_message_id text not null,status text not null,event_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index email_delivery_receipts_provider_idx on public.email_delivery_receipts(provider_message_id,event_at desc);
alter table public.email_delivery_receipts enable row level security;
revoke all on public.email_delivery_receipts from public,anon,authenticated;
grant select,insert,update,delete on public.email_delivery_receipts to service_role;

create function public.apply_recepta_email_delivery(p_provider_id text) returns void
language plpgsql security invoker set search_path='' as $$
declare v_event public.email_delivery_receipts%rowtype; v_table text;
begin
  select * into v_event from public.email_delivery_receipts where provider_message_id=p_provider_id
    order by event_at desc,case status when 'complained' then 5 when 'bounced' then 4 when 'failed' then 3 when 'delivered' then 2 else 1 end desc limit 1;
  if not found then return; end if;
  foreach v_table in array array['call_notifications','billing_notifications','service_jobs'] loop
    execute format('update public.%I set delivery_status=$1,delivery_event_at=$2 where provider_message_id=$3 and (delivery_event_at is null or delivery_event_at<=$2)',v_table)
      using v_event.status,v_event.event_at,p_provider_id;
  end loop;
end $$;
create function public.reconcile_recepta_email_delivery() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.provider_message_id is not null and (tg_op='INSERT' or old.provider_message_id is distinct from new.provider_message_id) then
    perform public.apply_recepta_email_delivery(new.provider_message_id);
  end if;
  return new;
end $$;
create trigger reconcile_call_delivery after insert or update of provider_message_id on public.call_notifications for each row execute function public.reconcile_recepta_email_delivery();
create trigger reconcile_billing_delivery after insert or update of provider_message_id on public.billing_notifications for each row execute function public.reconcile_recepta_email_delivery();
create trigger reconcile_callback_delivery after insert or update of provider_message_id on public.service_jobs for each row execute function public.reconcile_recepta_email_delivery();

alter table public.calls add column content_erased_at timestamptz,add column provider_erased_at timestamptz;
create index calls_retention_due_idx on public.calls(started_at) where provider_erased_at is null;

create function public.protect_recepta_erased_content() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if (tg_op='UPDATE' and old.content_erased_at is not null) or new.content_erased_at is not null then
    new.caller_name:=null;new.caller_number:=null;new.transcript:=null;new.recording_url:=null;new.summary:=null;
    new.outcome:=null;new.content_erased_at:=case when tg_op='UPDATE' then coalesce(old.content_erased_at,new.content_erased_at,now()) else coalesce(new.content_erased_at,now()) end;
  end if;
  return new;
end $$;
-- Run after the lifecycle merge, which otherwise preserves historical media.
create trigger zz_protect_erased_content before insert or update on public.calls
  for each row execute function public.protect_recepta_erased_content();

create function public.erase_recepta_call_content(p_call_id uuid,p_client_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare v_retell_id text;
begin
  update public.calls set content_erased_at=now(),provider_erased_at=now()
    where id=p_call_id and client_id=p_client_id returning retell_call_id into v_retell_id;
  update public.appointments set customer_name='Deleted caller',customer_email=null,customer_phone=null,
    company_name=null,service=null,notes=null where client_id=p_client_id and retell_call_id=v_retell_id;
  update public.call_notifications set mail_payload=null where client_id=p_client_id and retell_call_id=v_retell_id;
end $$;

create function public.protect_recepta_erased_appointment() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.calls where client_id=new.client_id and retell_call_id=new.retell_call_id and content_erased_at is not null) then
    new.customer_name:='Deleted caller';new.customer_email:=null;new.customer_phone:=null;
    new.company_name:=null;new.service:=null;new.notes:=null;
  end if;
  return new;
end $$;
create trigger zz_protect_erased_appointment before insert or update on public.appointments
  for each row execute function public.protect_recepta_erased_appointment();

create function public.queue_recepta_retention() returns integer
language plpgsql security invoker set search_path='' as $$
declare v_count integer;
begin
  insert into public.service_jobs(job_key,client_id,kind,payload)
    select 'retention:'||c.id::text,c.client_id,'retention_call',jsonb_build_object('call_id',c.id,'retell_call_id',c.retell_call_id)
    from public.calls c join public.clients owner on owner.id=c.client_id
    where c.provider_erased_at is null and c.call_status in ('ended','error','not_connected')
      and c.started_at<now()-make_interval(days=>owner.call_retention_days) and not owner.deletion_pending
    order by c.started_at limit 100 on conflict(job_key) do nothing;
  get diagnostics v_count=row_count;
  delete from public.callback_requests r using public.clients c where r.client_id=c.id and r.created_at<now()-make_interval(days=>c.call_retention_days);
  update public.service_jobs j set status='complete',mail_payload=null,payload='{}',completed_at=now(),
    last_error='Callback content expired under the retention policy.',lease_token=null,lease_expires_at=null
    from public.clients c where j.client_id=c.id and j.kind='callback_email' and j.status<>'complete'
      and j.created_at<now()-make_interval(days=>c.call_retention_days);
  update public.service_jobs set mail_payload=null,payload='{}' where kind='callback_email' and status='complete' and completed_at<now()-interval '30 days';
  update public.billing_notifications set mail_payload=null,payload='{}' where sent_at<now()-interval '30 days';
  update public.call_notifications set mail_payload=null where accepted_at<now()-interval '30 days';
  delete from public.email_delivery_receipts where created_at<now()-interval '30 days';
  delete from public.service_jobs where status='complete' and completed_at<now()-interval '30 days';
  return v_count;
end $$;

create or replace function public.claim_recepta_billing_notifications(p_limit integer default 5)
returns setof public.billing_notifications language plpgsql security invoker set search_path='' as $$
begin
  update public.billing_notifications set last_error='Automatic retries paused; provider delivery must be reviewed.' where sent_at is null and first_send_at<now()-interval '23 hours';
  return query update public.billing_notifications set last_attempt_at=now(),attempts=attempts+1
    where notification_key in(select notification_key from public.billing_notifications
      where sent_at is null and (last_attempt_at is null or last_attempt_at<now()-interval '10 minutes')
      and (first_send_at is null or first_send_at>now()-interval '23 hours')
      order by coalesce(last_attempt_at,created_at),created_at for update skip locked limit least(greatest(p_limit,1),5)) returning *;
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace='public'::regnamespace
    and p.proname in ('record_recepta_callback','claim_recepta_service_jobs','finish_recepta_service_job','start_recepta_client_deletion','guard_recepta_deleting_client','guard_recepta_deleting_number',
      'apply_recepta_email_delivery','reconcile_recepta_email_delivery','protect_recepta_erased_content','protect_recepta_erased_appointment','erase_recepta_call_content','queue_recepta_retention','claim_recepta_billing_notifications') loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end $$;

do $$ declare v_table text; begin
  foreach v_table in array array['callback_requests','service_jobs','integration_settings','email_delivery_receipts'] loop
    execute format('create policy service_only on public.%I to service_role using(true) with check(true)',v_table);
  end loop;
end $$;

create or replace function public.configure_recepta_subscription(p_client_id uuid,p_configuration jsonb)
returns setof public.subscriptions
language plpgsql security invoker set search_path='' as $$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_configuration jsonb;
  v_current jsonb;
begin
  select * into v_old from public.subscriptions where client_id=p_client_id for update;
  if not found then raise exception 'Subscription is not configured'; end if;
  if exists(select 1 from public.clients where id=p_client_id and deletion_pending) then raise exception 'Client is awaiting deletion'; end if;
  if jsonb_typeof(p_configuration) is distinct from 'object' or exists (
    select 1 from jsonb_object_keys(p_configuration) k where k not in
      ('plan_name','monthly_price','monthly_minutes','ai_model_id','pii_redaction_enabled',
       'safety_guardrails_enabled','extra_phone_numbers','phone_number_country','phone_number_area_code')
  ) then raise exception 'Only billing configuration may be changed'; end if;
  v_next := jsonb_populate_record(v_old,p_configuration);
  if v_next.plan_name not in ('Recepta Standard','Recepta Pro') or v_next.plan_name is null
    or v_next.monthly_minutes is null or v_next.monthly_minutes<1 or v_next.monthly_minutes>100000000
    or nullif(btrim(v_next.ai_model_id),'') is null or v_next.monthly_price is null or v_next.monthly_price<0
    or v_next.extra_phone_numbers is null or v_next.extra_phone_numbers<0 or v_next.extra_phone_numbers>20
    or v_next.pii_redaction_enabled is null or v_next.safety_guardrails_enabled is null
    then raise exception 'Invalid billing configuration'; end if;
  v_configuration := jsonb_build_object('plan_name',v_next.plan_name,'monthly_price',v_next.monthly_price,
    'monthly_minutes',v_next.monthly_minutes,'ai_model_id',v_next.ai_model_id,
    'pii_redaction_enabled',v_next.pii_redaction_enabled,'safety_guardrails_enabled',v_next.safety_guardrails_enabled,
    'extra_phone_numbers',v_next.extra_phone_numbers);
  v_current := jsonb_build_object('plan_name',v_old.plan_name,'monthly_price',v_old.monthly_price,
    'monthly_minutes',v_old.monthly_minutes,'ai_model_id',v_old.ai_model_id,
    'pii_redaction_enabled',v_old.pii_redaction_enabled,'safety_guardrails_enabled',v_old.safety_guardrails_enabled,
    'extra_phone_numbers',v_old.extra_phone_numbers);
  if p_configuration ? 'phone_number_country' then
    if p_configuration->>'phone_number_country' not in ('CA','US') then raise exception 'Invalid phone country'; end if;
    v_configuration := v_configuration || jsonb_build_object('phone_number_country',p_configuration->>'phone_number_country',
      'phone_number_area_code',p_configuration->>'phone_number_area_code');
  end if;
  if nullif(btrim(v_old.stripe_subscription_id),'') is null then
    return query update public.subscriptions set plan_name=v_next.plan_name,monthly_price=v_next.monthly_price,
      monthly_minutes=v_next.monthly_minutes,ai_model_id=v_next.ai_model_id,
      pii_redaction_enabled=v_next.pii_redaction_enabled,safety_guardrails_enabled=v_next.safety_guardrails_enabled,
      extra_phone_numbers=v_next.extra_phone_numbers,status='pending',rollover_seconds=0,
      current_period_start=null,current_period_end=null,next_billing_date=null,
      pending_configuration=v_configuration,configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  else
    -- Keep the original subscription, paid period and allowance intact, including
    -- cancelled/past-due state. Renewal cannot accidentally apply this quote.
    return query update public.subscriptions set
      pending_configuration=case when (v_configuration-'phone_number_country'-'phone_number_area_code')=v_current then null else v_configuration end,
      configuration_revision=configuration_revision+1
      where client_id=p_client_id returning *;
  end if;
end; $$;

create or replace function public.activate_recepta_checkout(
  p_client_id uuid, p_stripe_subscription_id text, p_customer_id text,
  p_period_start timestamptz, p_period_end timestamptz,
  p_configuration jsonb, p_replaces_subscription_id text default null
)
returns setof public.subscriptions
language plpgsql security invoker set search_path = ''
as $$
declare
  v_old public.subscriptions%rowtype;
  v_next public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then raise exception 'Invalid billing period'; end if;
  select * into v_old from public.subscriptions where client_id = p_client_id for update;
  if not found then return; end if;
  if exists(select 1 from public.clients where id=p_client_id and deletion_pending) then return; end if;
  if v_old.stripe_subscription_id = p_stripe_subscription_id then
    if v_old.current_period_start = p_period_start and v_old.status = 'active' then
      return next v_old;
    end if;
    return;
  end if;
  if p_replaces_subscription_id is not null then
    if v_old.stripe_subscription_id is distinct from p_replaces_subscription_id then return; end if;
  elsif v_old.status = 'active' and v_old.stripe_subscription_id is not null then
    return;
  end if;
  v_next := jsonb_populate_record(v_old, p_configuration);
  if p_replaces_subscription_id is not null and v_old.status = 'active'
    and v_old.current_period_start <= p_period_start and v_old.current_period_end > p_period_start then
    v_used := public.recepta_committed_usage(p_client_id,
      v_old.current_period_start,p_period_start);
    v_monthly := greatest(coalesce(v_old.monthly_minutes, 0), 0)::bigint * 60;
    v_rollover := least(
      greatest(v_monthly - greatest(v_used - least(coalesce(v_old.rollover_seconds, 0), v_monthly), 0), 0),
      greatest(coalesce(v_next.monthly_minutes, 0), 0)::bigint * 60
    );
  end if;
  -- A confirmed paid Checkout converts the prospect to normal customer calls.
  -- Replay guards above return before this, preserving a later admin demo choice.
  update public.agents set demo_mode=false where client_id=p_client_id;
  return query update public.subscriptions set
    plan_name = v_next.plan_name, monthly_price = v_next.monthly_price,
    monthly_minutes = v_next.monthly_minutes, ai_model_id = v_next.ai_model_id,
    pii_redaction_enabled = v_next.pii_redaction_enabled,
    safety_guardrails_enabled = v_next.safety_guardrails_enabled,
    extra_phone_numbers = v_next.extra_phone_numbers,
    status = 'active', rollover_seconds = v_rollover,
    pending_configuration = case when p_configuration->>'quote_revision' = v_old.configuration_revision::text then null else v_old.pending_configuration end,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end, stripe_subscription_id = p_stripe_subscription_id,
    stripe_customer_id = p_customer_id, cancel_at_period_end = false
    where client_id = p_client_id returning *;
end;
$$;

create or replace function public.renew_recepta_subscription(
  p_stripe_subscription_id text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns setof public.subscriptions
language plpgsql security invoker set search_path = ''
as $$
declare
  v_subscription public.subscriptions%rowtype;
  v_used bigint := 0;
  v_monthly bigint := 0;
  v_rollover bigint := 0;
begin
  if p_period_end <= p_period_start then
    raise exception 'Invalid billing period';
  end if;
  select * into v_subscription from public.subscriptions
    where stripe_subscription_id = p_stripe_subscription_id for update;
  if not found then return; end if;
  if exists(select 1 from public.clients where id=v_subscription.client_id and deletion_pending) then return; end if;
  if v_subscription.current_period_start > p_period_start then return; end if;
  if v_subscription.current_period_start = p_period_start
    and v_subscription.current_period_end <> p_period_end then return; end if;

  v_monthly := greatest(coalesce(v_subscription.monthly_minutes, 0), 0)::bigint * 60;
  v_rollover := least(greatest(coalesce(v_subscription.rollover_seconds, 0), 0), v_monthly);
  if v_subscription.current_period_start < p_period_start then
    -- A gap in paid cycles forfeits the old allowance. Only a consecutive
    -- paid renewal can carry minutes into the new cycle.
    if v_subscription.current_period_end = p_period_start then
      v_used := public.recepta_committed_usage(v_subscription.client_id,
        v_subscription.current_period_start,p_period_start);
      v_rollover := greatest(v_monthly - greatest(v_used - v_rollover, 0), 0);
    else
      v_rollover := 0;
    end if;
  elsif v_subscription.current_period_start is null then
    v_rollover := 0;
  end if;

  return query update public.subscriptions set
    status = 'active', rollover_seconds = v_rollover,
    current_period_start = p_period_start, current_period_end = p_period_end,
    next_billing_date = p_period_end
    where client_id = v_subscription.client_id returning *;
end;
$$;
