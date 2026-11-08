create schema if not exists recepta_private;
alter table public.phone_provisioning
  add column twilio_number_sid text,
  add column number_import_state text not null default 'idle' check(number_import_state in ('idle','pending','ready'));

-- A deleted account must not erase the only record of an uncertain purchase.
create function recepta_private.guard_unfinished_phone_provisioning()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.phone_provisioning where client_id=old.id and
    (state in ('creating_llm','creating_agent') or number_state<>'idle' or pending_number is not null or number_import_state='pending')) then
    raise exception 'Phone provisioning needs reconciliation before removing this account. Provider assets are preserved.';
  end if;
  return old;
end $$;
revoke all on function recepta_private.guard_unfinished_phone_provisioning() from public,anon,authenticated;
grant execute on function recepta_private.guard_unfinished_phone_provisioning() to service_role;
create trigger preserve_unfinished_phone_provisioning before delete on public.clients
  for each row execute function recepta_private.guard_unfinished_phone_provisioning();
