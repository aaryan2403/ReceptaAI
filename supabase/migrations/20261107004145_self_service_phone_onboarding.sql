-- Only a trusted handler can initialize a verified Auth customer.
create function public.initialize_recepta_customer(
  p_client_id uuid, p_email text, p_company text, p_plan text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare
  model_id text;
  model_rate numeric;
begin
  if p_plan is null or p_plan not in ('Recepta Standard', 'Recepta Pro')
    or p_company is null or length(trim(p_company)) not between 2 and 120
    or p_email is null or length(p_email) not between 3 and 320 then
    raise exception 'Invalid customer setup.';
  end if;
  if exists(select 1 from public.clients where id=p_client_id) then return false; end if;
  select id, customer_price_per_minute_cad into model_id, model_rate
  from public.ai_models
  where is_active and id='gpt-4-1' and customer_price_per_minute_cad>=0;
  if not found then raise exception 'Onboarding model is unavailable.'; end if;
  insert into public.clients(id,company_name,contact_email,role,status)
    values(p_client_id,trim(p_company),lower(p_email),'client','setup')
    on conflict(id) do nothing;
  if not found then return false; end if;
  insert into public.agents(client_id,agent_name,status,demo_mode)
    values(p_client_id,trim(p_company)||' Receptionist','setup',false);
  insert into public.subscriptions(client_id,plan_name,ai_model_id,monthly_minutes,monthly_price,status)
    values(p_client_id,p_plan,model_id,300,
      round(case when p_plan='Recepta Pro' then 299 else 199 end+300*model_rate,2),'pending');
  return true;
end $$;
revoke all on function public.initialize_recepta_customer(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.initialize_recepta_customer(uuid,text,text,text) to service_role;

-- Keep an operations record after a customer is removed. Avoid saving OTPs,
-- provider secrets, raw payloads or telephone numbers in the audit table.
create table public.phone_operation_audit (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  resource text not null,
  action text not null check(action in ('insert','update','delete')),
  occurred_at timestamptz not null default now()
);
create index phone_operation_audit_client_date on public.phone_operation_audit(client_id,occurred_at desc);
alter table public.phone_operation_audit enable row level security;
revoke all on public.phone_operation_audit from public,anon,authenticated,service_role;
grant select,insert on public.phone_operation_audit to service_role;
create policy server_only on public.phone_operation_audit to service_role using(true) with check(true);

create function recepta_private.audit_recepta_phone_operation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.phone_operation_audit(client_id,resource,action)
    values(case when tg_op='DELETE' then old.client_id else new.client_id end,tg_table_name,lower(tg_op));
  return null;
end $$;
revoke all on function recepta_private.audit_recepta_phone_operation() from public,anon,authenticated;
grant execute on function recepta_private.audit_recepta_phone_operation() to service_role;
create trigger audit_recepta_phone_assignment after insert or update or delete on public.agent_phone_numbers
  for each row execute function recepta_private.audit_recepta_phone_operation();
create trigger audit_recepta_phone_settings after insert or update or delete on public.phone_setups
  for each row execute function recepta_private.audit_recepta_phone_operation();
create trigger audit_recepta_phone_provisioning after insert or update or delete on public.phone_provisioning
  for each row execute function recepta_private.audit_recepta_phone_operation();
