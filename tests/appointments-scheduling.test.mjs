import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { bookingDay, defaultSchedulingSettings } from '../src/lib/appointmentScheduling.ts'

const db = new PGlite()
const tenant = '00000000-0000-0000-0000-000000000101'
const other = '00000000-0000-0000-0000-000000000102'
const secret = 'synthetic-retell-key'
const fixture = `
  do $$ begin
    if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  end $$;
  grant usage on schema public to service_role;
  create table clients(id uuid primary key, deletion_pending boolean not null default false, company_name text, contact_email text);
  create table subscriptions(client_id uuid primary key, plan_name text, status text, stripe_subscription_id text,
    current_period_start timestamptz, current_period_end timestamptz, monthly_minutes integer, rollover_seconds bigint);
  create table agents(client_id uuid primary key, retell_agent_id text, business_hours text, status text, phone_number text, demo_mode boolean not null default false);
  create table agent_phone_numbers(client_id uuid, phone_number text, is_primary boolean);
  create table call_minute_reservations(id uuid primary key default gen_random_uuid(), client_id uuid,
    retell_call_id text unique, period_start timestamptz, period_end timestamptz, reserved_seconds integer,
    used_seconds integer, status text not null default 'active', retell_agent_id text, demo_mode boolean);
  create table calls(client_id uuid, retell_call_id text, call_status text);
  create table employees(id uuid, client_id uuid, name text, role text, is_active boolean, created_at timestamptz);
  grant select on employees to service_role;
  create function recepta_committed_usage(uuid,timestamptz,timestamptz) returns bigint language sql as 'select 0::bigint';
  grant select, insert, update on call_minute_reservations, calls to service_role;
  grant select on agent_phone_numbers to service_role;
  create table appointments(id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id),
    retell_call_id text,customer_name text,customer_email text,customer_phone text,company_name text,service text,notes text,
    status text not null default 'booked',source text not null,appointment_time timestamptz,appointment_end_time timestamptz,
    duration_minutes integer,employee_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
  create unique index appointments_retell_call_id_key on appointments(retell_call_id) where retell_call_id is not null;
  alter table appointments enable row level security;
  create policy tenant_select on appointments for select to authenticated using (client_id::text = current_setting('recepta.test_user',true));
  grant select,insert,update,delete on appointments to authenticated;
  create table service_jobs (job_key text primary key, client_id uuid, kind text check (kind in ('callback_email','delete_client','retention_call')),
    payload jsonb, status text default 'queued', attempts integer default 0, next_attempt_at timestamptz default now(), lease_token uuid,
    lease_expires_at timestamptz,last_error text, created_at timestamptz default now(), first_send_at timestamptz,
    mail_payload jsonb, completed_at timestamptz, provider_message_id text, delivery_status text);
  create function finish_recepta_service_job(p_key text,p_lease uuid,p_error text default null)
  returns boolean language plpgsql security invoker as $$
  begin
    update service_jobs set status=case when p_error is null then 'complete' else 'queued' end,
      completed_at=case when p_error is null then now() end,last_error=p_error,lease_token=null,lease_expires_at=null
    where job_key=p_key and lease_token=p_lease and status='running';
    return found;
  end $$;
  grant select,insert,update,delete on service_jobs to service_role;
  grant select,insert,update,delete on clients,subscriptions,agents,appointments to service_role;
`
const migrationFiles = [
  '20261014055537_appointment_request_intake.sql',
  '20261028191236_shared_booking_capacity.sql',
  '20261101194002_disable_calendar_booking.sql',
  '20261113064703_tenant_appointment_scheduling.sql',
  '20261116074255_appointment_setup_and_paid_access.sql',
  '20261116113500_internal_appointment_test_entitlement.sql',
  '20261119185856_admin_service_access.sql',
  '20261119204250_admin_client_status.sql',
  '20261127004253_confirmed_appointment_activity.sql',
]

const pgUrl = process.env.RECEPTA_TEST_PG_URL
let native
const statements = await Promise.all(migrationFiles.map(file => readFile('supabase/migrations/' + file, 'utf8')))
const base = async (database) => {
  await database.exec(fixture)
  for (const migration of statements) await database.exec(migration)
  await database.query("insert into clients(id,company_name,contact_email) values($1,'First business','owner@example.test'),($2,'Second business','other@example.test')", [tenant, other])
  await database.query(`insert into subscriptions(client_id,plan_name,status,stripe_subscription_id,current_period_start,current_period_end,monthly_minutes)
    values($1,'Recepta Pro','active','sub_test_one',now()-interval '1 day',now()+interval '1 month',100),
          ($2,'Recepta Pro','active','sub_test_two',now()-interval '1 day',now()+interval '1 month',100)`, [tenant, other])
  await database.query("insert into agents(client_id,retell_agent_id,business_hours,status,phone_number) values($1,'agent_one',null,'live',null),($2,'agent_two',null,'live',null)", [tenant, other])
}
before(async () => { await base(db); await db.exec('set role service_role') })
after(async () => { await db.close(); await native?.end() })

const detail = { customer_name: 'Test Caller', customer_phone: '+14165550123', customer_email: 'buyer@example.test', email_consent: true }
const allDays = () => Object.fromEntries(Array.from({ length: 7 }, (_, index) => [String(index + 1), bookingDay(true)]))
const rules = (options = {}) => ({ ...defaultSchedulingSettings(), enabled: true, weekly: allDays(), ...options })
const futureDate = (days = 14) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
const localStart = async (date, time, zone = 'America/Toronto') =>
  (await db.query("select public.recepta_schedule_stamp(t,$3) as stamp from public.recepta_wall_time($1::date+$2::time,$3) t order by t", [date, time, zone])).rows[0]?.stamp
const call = async (name, parameters, database = db) => {
  const placeholders = parameters.map((_, i) => '$' + (i + 1)).join(',')
  return (await database.query('select public.' + name + '(' + placeholders + ') as result', parameters)).rows[0].result
}
const save = (id, config, database = db) => call('recepta_save_scheduling_settings', [id, config], database)
const book = (id, start, callId, details = detail, database = db) =>
  call('recepta_change_appointment', [id, 'book', start, null, null, callId, details], database)
const available = (id, day, time, stamp = null, auto = true) =>
  call('recepta_scheduling_availability', [id, day, time, stamp, auto])
const action = (id, name, start, appt, version) => call('recepta_change_appointment', [id, name, start, appt, version])

test('tenant-specific settings apply durations, grid intervals, and up to ten overlapping bookings', async () => {
  const date = futureDate()
  assert.equal((await available(tenant,date,'09:00')).reason,'automatic_booking_disabled')
  for (const [index, duration, interval, capacity] of [[0,15,5,2],[1,30,15,3],[2,60,30,10]]) {
    const day = futureDate(14+index)
    await save(tenant, rules({ duration_minutes: duration, start_interval_minutes: interval, capacity }))
    await save(other, rules({ duration_minutes: 15, start_interval_minutes: 5, capacity: 1, time_zone: 'Asia/Kolkata' }))
    const start = await localStart(day,'09:00')
    assert.equal((await available(tenant,day,'09:01')).reason,'off_start_interval')
    assert.equal((await available(tenant,day,`09:${String(interval).padStart(2,'0')}`)).available,true)
    for (let n=0; n<capacity; n++) {
      const booked = await book(tenant,start,`capacity-${capacity}-${n}`)
      assert.equal(booked.duration_minutes,duration)
      assert.equal(booked.success,true)
    }
    assert.equal((await book(tenant,start,`capacity-${capacity}-extra`)).reason,'simultaneous_capacity_reached')
    const otherSlot = await available(other,day,'09:00')
    assert.equal(otherSlot.available,true)
    assert.match(otherSlot.start,/\+05:30$/)
    assert.equal((await book(other,otherSlot.start,`other-${index}`)).success,true)
  }
  assert.equal((await available(tenant,date,'09:00')).available,true)
})

test('hourly start limits, peak occupancy and buffer handle crossing boundaries and cancellation', async () => {
  const date = futureDate(25)
  const day = { ...bookingDay(true), blocks: [
    { start:'09:00', end:'10:00', limit:4 }, { start:'10:00', end:'11:00', limit:10 },
    { start:'11:00', end:'12:00', limit:0 },
  ] }
  await save(tenant,rules({ hourly_limit:2, capacity:10, buffer_minutes:10, exceptions:{ [date]:day } }))
  const starts = Object.fromEntries(await Promise.all(['09:45','10:00','10:15','10:30','11:00'].map(async time=>[time,await localStart(date,time)])))
  const first = await book(tenant,starts['09:45'],'boundary-0')
  for (let n=1;n<4;n++) assert.equal((await book(tenant,starts['09:45'],`boundary-${n}`)).success,true)
  assert.equal((await book(tenant,starts['09:45'],'boundary-extra')).reason,'hourly_capacity_reached')
  for (let n=0;n<6;n++) assert.equal((await book(tenant,starts['10:00'],`following-${n}`)).success,true)
  assert.equal((await book(tenant,starts['10:15'],'within-buffer')).reason,'simultaneous_capacity_reached')
  assert.equal((await available(tenant,date,'10:00')).hourly_remaining,4)
  assert.equal((await book(tenant,starts['10:30'],'after-buffer')).success,true)
  assert.equal((await available(tenant,date,'11:00')).reason,'hourly_capacity_reached')
  assert.equal((await available(tenant,date,'11:00')).alternatives.length,3)
  assert.equal((await action(tenant,'cancel',null,first.appointment_id,1)).success,true)
  assert.equal((await available(tenant,date,'09:45')).available,true)
  assert.equal((await book(tenant,starts['09:45'],'boundary-0')).status,'cancelled')
  assert.deepEqual((await db.query("select action from appointment_history where appointment_id=$1 order by id", [first.appointment_id])).rows.map(row=>row.action), ['booked','cancelled'])

  const blockDate = futureDate(27)
  const block = { ...bookingDay(true), blocks: [{ start:'09:00', end:'12:00', limit:1 }] }
  await save(tenant,rules({ hourly_limit:0, capacity:5, exceptions:{ [blockDate]:block } }))
  assert.equal((await book(tenant,await localStart(blockDate,'09:00'),'multi-hour-block')).success,true)
  assert.equal((await available(tenant,blockDate,'09:45')).reason,'hourly_capacity_reached')
  assert.equal((await available(tenant,blockDate,'10:00')).available,true)
  assert.equal((await available(tenant,blockDate,'12:00')).reason,'hourly_capacity_reached')

  const next = futureDate(26)
  await save(tenant,rules({ capacity:1, duration_minutes:15, start_interval_minutes:5, buffer_minutes:5 }))
  assert.equal((await book(tenant,await localStart(next,'09:00'),'peak-first')).success,true)
  assert.equal((await book(tenant,await localStart(next,'09:20'),'peak-second')).success,true)
  await save(tenant,rules({ capacity:2, duration_minutes:30, start_interval_minutes:5 }))
  assert.equal((await book(tenant,await localStart(next,'09:05'),'intersects-two-but-peak-is-one')).success,true)
})

test('date exceptions replace recurring hours and preserve previous durations during reschedule', async () => {
  const date = futureDate(34)
  const next = futureDate(35)
  const weekly = Object.fromEntries(Object.keys(allDays()).map(key => [key,bookingDay()]))
  await save(tenant,rules({ weekly, exceptions:{ [date]:{ ...bookingDay(true), start:'13:00', end:'14:30' } } }))
  assert.equal((await available(tenant,date,'09:00')).reason,'outside_booking_hours')
  assert.equal((await available(tenant,next,'13:00')).reason,'closed')
  const requested = await call('capture_recepta_appointment_request',[tenant,'manual-confirm',{ ...detail, requested_date:date, requested_time:'13:00' }])
  assert.equal(requested.status,'pending')
  const initial = await localStart(date,'13:00')
  const confirmed = await action(tenant,'confirm',initial,requested.id,1)
  assert.equal(confirmed.duration_minutes,30)
  await save(tenant,rules({ duration_minutes:60, buffer_minutes:30 }))
  const moved = await action(tenant,'reschedule',await localStart(next,'14:00'),requested.id,2)
  assert.equal(moved.duration_minutes,30)
  assert.equal((await action(tenant,'reschedule',initial,requested.id,2)).reason,'appointment_changed')
  assert.equal((await action(other,'cancel',null,requested.id,3)).reason,'appointment_not_found')
  assert.equal((await available(tenant,date,'13:00')).available,true)
})

test('daylight-saving gaps are skipped and both repeated-hour offsets are explicit', async () => {
  const zone = 'America/Toronto'
  const date = (month, nth) => {
    const now = new Date()
    for (const year of [now.getUTCFullYear(),now.getUTCFullYear()+1]) {
      const first = new Date(Date.UTC(year,month-1,1))
      const day = 1 + (7-first.getUTCDay())%7 + 7*(nth-1)
      const sunday = new Date(Date.UTC(year,month-1,day))
      if (sunday.getTime() > now.getTime()+86400000) return sunday.toISOString().slice(0,10)
    }
  }
  const spring = date(3,2), fall = date(11,1)
  const dst = { ...bookingDay(true), start:'00:00',end:'04:00',blocks:[{start:'01:00',end:'02:00',limit:1}] }
  await save(tenant,rules({ capacity:null, exceptions:{ [spring]:dst,[fall]:dst }, time_zone:zone }))
  const missing = await available(tenant,spring,'02:15')
  assert.equal(missing.reason,'nonexistent_local_time')
  assert.ok(missing.alternatives.some(value=>value.includes('T03:00:00-04:00')))
  const ambiguous = await available(tenant,fall,'01:30')
  assert.equal(ambiguous.reason,'ambiguous_local_time')
  assert.deepEqual(ambiguous.alternatives.slice(0,2),[fall+'T01:30:00-04:00',fall+'T01:30:00-05:00'])
  assert.equal((await book(tenant,ambiguous.alternatives[0],'dst-first')).success,true)
  assert.equal((await book(tenant,ambiguous.alternatives[1],'dst-second')).reason,'hourly_capacity_reached')
})

test('database grants deny anonymous access and cross-tenant reads and prevent direct capacity bypass', async () => {
  const permissions = (await db.query(`select
    has_table_privilege('authenticated','public.appointments','insert') as insert,
    has_table_privilege('anon','public.booking_settings','select') as settings,
    has_table_privilege('authenticated','public.appointment_history','select') as history,
    has_function_privilege('authenticated','public.recepta_change_appointment(uuid,text,timestamptz,uuid,integer,text,jsonb,uuid)','execute') as book,
    has_function_privilege('service_role','public.reserve_recepta_booking(uuid,text,jsonb,uuid,integer)','execute') as retired`)).rows[0]
  assert.deepEqual(permissions,{insert:false,settings:false,history:false,book:false,retired:false})
  await db.exec(`reset role; set role authenticated; set recepta.test_user='${other}'`)
  try {
    assert.equal((await db.query('select count(*)::int n from appointments where client_id=$1',[tenant])).rows[0].n,0)
  } finally { await db.exec('reset role; set role service_role') }
})

test('independent PostgreSQL sessions serialize the last slot and preserve same-call retry identity', { skip: !pgUrl }, async () => {
  const url = new URL(pgUrl)
  assert.ok(['localhost','127.0.0.1','::1'].includes(url.hostname), 'Concurrency tests require a disposable local database.')
  const { default: pg } = await import('pg')
  native = new pg.Pool({ connectionString:pgUrl })
  await base({ exec:sql=>native.query(sql), query:(sql,args)=>native.query(sql,args) })
  const start = await localStart(futureDate(44),'09:00')
  await save(tenant,rules({ capacity:1 }),native)
  const first = await native.connect(), second = await native.connect()
  try {
    await first.query('begin')
    const booked = await book(tenant,start,'race-first',detail,first)
    let resolved = false
    const race = book(tenant,start,'race-second',detail,second).then(result=>{ resolved=true;return result })
    let waiting = false
    for (let attempt=0;attempt<100;attempt++) {
      const status = (await native.query('select wait_event from pg_stat_activity where pid=$1',[second.processID])).rows[0]
      if (status?.wait_event === 'advisory') { waiting = true; break }
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waiting,true)
    assert.equal(resolved,false)
    await first.query('commit')
    assert.equal((await race).reason,'simultaneous_capacity_reached')
    assert.equal((await book(tenant,start,'race-first',detail,second)).appointment_id,booked.appointment_id)
    assert.equal((await native.query("select count(*)::int n from appointments where status='booked'")).rows[0].n,1)
  } finally { await first.query('rollback'); first.release(); second.release() }
})

test('two concurrent signed QA authorizations cannot consume more than one remaining tool action', { skip: !pgUrl }, async () => {
  assert.ok(native, 'The isolated PostgreSQL concurrency fixture must exist.')
  const actor = '00000000-0000-0000-0000-000000000103'
  const grant=await native.query(
    "select public.recepta_grant_appointment_test($1,$2,$3,$4,$5,$6) as result",
    [tenant,'agent_one',new Date(Date.now()+3600000).toISOString(),1,1,actor])
    .catch(async error => {
      // Set the test client to pending without changing any real billing project.
      if (error.code !== '22023') throw error
      await native.query("update subscriptions set status='pending',stripe_subscription_id=null where client_id=$1",[tenant])
      return native.query("select public.recepta_grant_appointment_test($1,$2,$3,$4,$5,$6) as result",
        [tenant,'agent_one',new Date(Date.now()+3600000).toISOString(),1,1,actor])
    })
  const grantId=grant.rows[0].result.id
  const first=await native.connect(),second=await native.connect()
  try {
    await first.query('begin')
    const firstResult=await first.query("select public.recepta_authorize_appointment_tool($1,$2,$3,$4) as result",
      [tenant,'agent_one','qa-race-one','recepta_save_appointment_details'])
    assert.equal(firstResult.rows[0].result.allowed,true)
    let secondResolved=false
    const secondCall=second.query("select public.recepta_authorize_appointment_tool($1,$2,$3,$4) as result",
      [tenant,'agent_one','qa-race-two','recepta_save_appointment_details'])
      .then(result=>{ secondResolved=true; return result })
    await new Promise(resolve=>setTimeout(resolve,40))
    assert.equal(secondResolved,false,'The second authorization must wait for the grant lock.')
    await first.query('commit')
    const secondResult=await secondCall
    assert.equal(secondResult.rows[0].result.allowed,false)
    assert.equal(secondResult.rows[0].result.reason,'test_limit_exhausted')
    const counts=(await native.query('select used_calls,used_invocations from recepta_appointment_test_grants where id=$1',[grantId])).rows[0]
    assert.deepEqual(counts,{used_calls:1,used_invocations:1})
    assert.equal((await native.query('select count(*)::int n from recepta_appointment_test_usage where grant_id=$1',[grantId])).rows[0].n,1)
  } finally {
    await first.query('rollback').catch(()=>{})
    first.release(); second.release()
    await native.query('select public.recepta_revoke_appointment_test($1,$2,$3)',[tenant,'agent_one',actor])
    await native.query("update subscriptions set status='active',stripe_subscription_id='sub_test_one' where client_id=$1",[tenant])
  }
})

let signedHandler, dashboardHandler, adminTestHandler, serviceHandler, inbound, emailBuilder, jobRunner
const bundle = async (path) => {
  const output = await build({ entryPoints:[path], bundle:true, platform:'node', format:'esm',write:false,
    plugins:[{ name:'test-database',setup(builder) {
      builder.onResolve({ filter:/^@supabase\/supabase-js$/ },()=>({path:'supabase',namespace:'test'}))
      builder.onLoad({ filter:/.*/, namespace:'test' },()=>({ contents:'export const createClient = () => globalThis.__appointmentSchedulingDb', loader:'js' }))
    } }],
  })
  return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
}

const initializeHandlers = async () => {
  process.env.SUPABASE_URL = 'https://synthetic.test'
  process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
  process.env.RETELL_API_KEY = secret
  process.env.RETELL_STAGING_API_KEY = 'staging-only'
  process.env.ADMIN_EMAIL = 'admin@example.test'
  const dateValue = value => value instanceof Date ? value.toISOString() : value
  const users = {
    tenant:{ id:tenant, email:'owner@example.test', user_metadata:{ appointment_custom_fields:['Service type'] } },
    other:{ id:other, email:'other@example.test' },
    admin:{ id:'00000000-0000-0000-0000-000000000103',email:'admin@example.test' },
  }
  const columnsFor = {
    recepta_change_appointment:['p_client','p_action','p_start','p_id','p_version','p_call_id','p_details','p_actor'],
    recepta_scheduling_availability:['p_client','p_date','p_time','p_start','p_automatic','p_appointment_id'],
    capture_recepta_appointment_request:['p_client_id','p_call_id','p_details'],
    recepta_authorize_appointment_tool:['p_client','p_agent','p_call_id','p_tool'],
    recepta_appointment_test_check:['p_client','p_agent'],
    recepta_service_access:['p_client','p_agent'],
    recepta_save_service_access:['p_client','p_actor','p_action','p_mode','p_plan','p_agent','p_reason','p_expires_at','p_max_minutes','p_revision'],
    recepta_manage_client_service:['p_client','p_actor','p_action','p_mode','p_plan','p_agent','p_reason','p_expires_at','p_max_minutes','p_revision','p_agent_status'],
    reserve_recepta_agent_call:['p_client_id','p_call_id','p_agent_id'],
    recepta_grant_appointment_test:['p_client','p_agent','p_expires_at','p_max_calls','p_max_invocations','p_actor'],
    recepta_revoke_appointment_test:['p_client','p_agent','p_actor'],
    recepta_appointment_conflicts:['p_client','p_ids'],
    recepta_confirmed_appointment_activity:['p_client_id','p_time_zone'],
    recepta_save_scheduling_settings:['p_client','p_rules','p_prepare'],
    claim_recepta_service_jobs:['p_limit','p_key'],
    finish_recepta_service_job:['p_key','p_lease','p_error'],
  }
  globalThis.__appointmentSchedulingDb = {
    auth:{
      getUser:async token=>({data:{user:users[token]},error:null}),
      admin:{getUserById:async id=>({ data:{user:Object.values(users).find(user=>user.id===id)},error:null })},
    },
    from(table) {
      let select='*', count=false, update, single=false, limit=1000, offset=0
      const filters=[], values=[], ordering=[]
      const where = (column, op, value) => { values.push(value); filters.push(column+' '+op+' $'+values.length); return builder }
      const execute = async () => {
        try {
          const clause=filters.length ? ' where '+filters.join(' and ') : ''
          const order=ordering.length ? ' order by '+ordering.join(',') : ''
          const total=count ? (await db.query('select count(*)::int n from '+table+clause,values)).rows[0].n : null
          let rows
          if (update) {
            const fields=Object.keys(update).map((name,index)=>name+'=$'+(values.length+index+1)).join(',')
            rows=(await db.query('update '+table+' set '+fields+clause+' returning '+select,[...values,...Object.values(update)])).rows
          } else {
            rows=(await db.query('select '+select+' from '+table+clause+order+' limit '+limit+' offset '+offset,values)).rows
          }
          rows=rows.map(row=>Object.fromEntries(Object.entries(row).map(([name,value])=>[name,dateValue(value)])))
          return { data:single ? rows[0]??null : rows,error:null,count:total }
        } catch(error) { return { data:null,error } }
      }
      const builder = {
        select:(cols,options)=>{ select=cols;count=Boolean(options?.count);return builder },
        eq:(col,value)=>where(col,'=',value), gte:(col,value)=>where(col,'>=',value), gt:(col,value)=>where(col,'>',value),
        order:(col,{ascending=true}={})=>{ ordering.push(col+(ascending?' asc':' desc'));return builder },
        range:(start,end)=>{ offset=start;limit=end-start+1;return builder },
        limit:number=>{ limit=number;return builder },
        update:changes=>{ update=changes;return builder },
        maybeSingle:()=>{ single=true;return execute() },
        then:(resolve,reject)=>execute().then(resolve,reject),
      }
      return builder
    },
    async rpc(name, args) {
      if (name === 'record_recepta_callback') return { data:null,error:null }
      const fields = columnsFor[name].filter(field=>field in args)
      const references=fields.map((field,index)=>field+' => $'+(index+1)).join(',')
      const parameters=fields.map(field=>args[field])
      try {
        if (name === 'recepta_confirmed_appointment_activity') {
          const result = await db.query(
            'select day::text, count::int from public.recepta_confirmed_appointment_activity($1,$2)', parameters,
          )
          return { data: result.rows, error: null }
        }
        if (name === 'recepta_appointment_conflicts' || name === 'claim_recepta_service_jobs' || name === 'reserve_recepta_agent_call') {
          return { data:(await db.query('select * from public.'+name+'('+references+')',parameters)).rows,error:null }
        }
        const result=(await db.query('select to_jsonb(public.'+name+'('+references+')) as result',parameters)).rows[0].result
        return { data:name==='recepta_save_scheduling_settings' ? [result] : result,error:null }
      } catch(error) { return { data:null,error } }
    },
  }
  signedHandler = (await bundle('netlify/functions/retell-appointment.ts')).default
  dashboardHandler = (await bundle('netlify/functions/appointment-scheduling.ts')).default
  adminTestHandler = (await bundle('netlify/functions/admin-appointment-test-entitlement.ts')).default
  serviceHandler = (await bundle('netlify/functions/admin-service-access.ts')).default
  inbound = (await bundle('netlify/functions/retell-inbound.ts')).default
  emailBuilder = (await bundle('netlify/lib/appointmentNotification.ts')).loadAppointmentEmail
  jobRunner = (await bundle('netlify/lib/serviceJobs.ts')).processServiceJobs
}

const invoke = async (name, args, callId='test-call', changes={}, key=secret) => {
  const body = JSON.stringify({ name, args, call:{ agent_id:'agent_one', call_id:callId, from_number:'+14165550123',...changes } })
  const now = Date.now()
  const digest = createHmac('sha256',key).update(body+now).digest('hex')
  return signedHandler(new Request('https://synthetic.test',{ method:'POST',headers:{'x-retell-signature':`v=${now},d=${digest}`},body }))
}

const adminTest = (method,body,token='admin') => adminTestHandler(new Request('https://synthetic.test/.netlify/functions/admin-appointment-test-entitlement',{ method,
  headers: { Authorization:'Bearer '+token, 'Content-Type':'application/json' },
  ...(body ? {body:JSON.stringify(body)} : {}) }))

const dashboard = (params='',token='tenant',method='GET',body) => dashboardHandler(new Request('https://synthetic.test/?'+params,{
  method,headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined,
}))

test('preview appointment handler fails closed unless its Supabase URL is the isolated staging database', async () => {
  if (!signedHandler) await initializeHandlers()
  const previousContext = process.env.CONTEXT
  const previousUrl = process.env.SUPABASE_URL
  const previousForced = process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
  try {
    process.env.CONTEXT = 'deploy-preview'
    delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
    process.env.SUPABASE_URL = 'https://qkdsdaboxkysabnbjmej.supabase.co'
    const mismatch = await signedHandler(new Request('https://synthetic.test', { method: 'GET' }))
    assert.equal(mismatch.status,405)
    assert.equal(mismatch.headers.get('x-recepta-preview-database'),'mismatch')
    const denied = await signedHandler(new Request('https://synthetic.test', {
      method:'POST', body:'{}',
    }))
    assert.equal(denied.status,503)
    assert.equal((await denied.json()).code,'preview_database_mismatch')
    process.env.SUPABASE_URL = 'https://mvufjeqxqvpcfqwmihpy.supabase.co'
    const valid = await signedHandler(new Request('https://synthetic.test', { method:'GET' }))
    assert.equal(valid.status,405)
    assert.equal(valid.headers.get('x-recepta-preview-database'),'staging')
    const invalidSignature = await signedHandler(new Request('https://synthetic.test', {
      method:'POST', body:'{}',
    }))
    assert.equal(invalidSignature.status,401)
  } finally {
    if (previousContext === undefined) delete process.env.CONTEXT
    else process.env.CONTEXT = previousContext
    if (previousUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = previousUrl
    if (previousForced === undefined) delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
    else process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE = previousForced
  }
})

test('signed Retell requests persist in PostgreSQL and surface in the authorized dashboard with intake and email jobs', async () => {
  await initializeHandlers()
  const date = futureDate(51)
  await save(tenant,rules({ email_owner:true,email_customer:true }))
  const activityBefore = await (await dashboard('view=confirmed-activity')).json()
  assert.equal(activityBefore.days.length, 7)
  assert.equal(activityBefore.timeZone, 'America/Toronto')
  const totals = activity => activity.days.reduce((total, day) => total + day.count, 0)
  const otherBefore = await (await dashboard('view=confirmed-activity','other')).json()

  const checked = await invoke('recepta_check_availability',{ requested_date:date,requested_time:'10:00',client_id:other })
  assert.equal(checked.status,200)
  const slot = await checked.json()
  assert.equal(slot.available,true)
  const args={...detail,start:slot.start,customer_email_consent:true,appointment_details:[
    {label:'SERVICE TYPE',value:'Roof repair'},{label:'Unconfigured field',value:'ignored'},
  ]}
  const response=await invoke('recepta_book_appointment',args)
  assert.equal(response.status,200)
  const saved=await response.json()
  assert.equal(saved.status,'booked')
  assert.equal(saved.booking_reference,saved.appointment_id)
  const retry=await (await invoke('recepta_book_appointment',args)).json()
  assert.equal(retry.appointment_id,saved.appointment_id)
  const recovered=await (await invoke('recepta_save_appointment_details',args)).json()
  assert.equal(recovered.booking_reference,saved.booking_reference)
  assert.equal(recovered.status,'booked')
  assert.equal(Date.parse(recovered.start),Date.parse(slot.start))
  const newStart=await localStart(date,'11:00')
  const duplicateIntent=await (await invoke('recepta_book_appointment',{...args,start:newStart})).json()
  assert.equal(duplicateIntent.reason,'call_already_booked')
  assert.equal(duplicateIntent.start,slot.start)
  const noRoom=await (await invoke('recepta_book_appointment',args,'another-call')).json()
  assert.equal(noRoom.success,false)
  assert.equal(noRoom.reason,'simultaneous_capacity_reached')
  assert.ok(noRoom.alternatives.length)
  assert.equal((await invoke('recepta_book_appointment',args,'mismatch',{ metadata:{recepta_client_id:other} })).status,403)
  assert.equal((await invoke('recepta_book_appointment',args,'bad-signature',{},'incorrect')).status,401)
  const pending=await (await invoke('recepta_save_appointment_details',{
    ...args,preferred_date:date,preferred_time:'10:00',
  },'another-call')).json()
  assert.equal(pending.status,'pending')
  const visible = await (await dashboard('status=booked')).json()
  const record = visible.appointments.find(item=>item.id===saved.appointment_id)
  assert.equal(record.booking_time_zone,'America/Toronto')
  assert.equal(record.customer_phone,'+14165550123')
  assert.deepEqual(JSON.parse(record.notes).details,[{ label:'Service type',value:'Roof repair' }])
  const activityAfter = await (await dashboard('view=confirmed-activity')).json()
  assert.equal(totals(activityAfter), totals(activityBefore) + 1, 'the new confirmed booking is counted just once')
  assert.equal(activityAfter.days.at(-1).count, activityBefore.days.at(-1).count + 1, 'counted on the creation day, not the future slot date')
  assert.deepEqual(await (await dashboard('view=confirmed-activity','other')).json(), otherBefore)
  assert.equal((await dashboard('view=confirmed-activity&clientId='+other)).status,403)
  const preferences = await (await dashboard('view=settings')).json()
  assert.equal(preferences.settings.enabled,true)
  assert.equal(preferences.settings.email_owner,true)
  assert.equal('appointments' in preferences,false)
  assert.equal('conflicts' in preferences,false)
  const awaiting = await (await dashboard('status=pending')).json()
  assert.ok(awaiting.appointments.some(item=>item.id===pending.appointment_id && item.appointment_time===null))
  const slots = await (await dashboard('date='+date)).json()
  assert.equal(slots.slots.find(item=>item.wall_time==='10:00').reason,'simultaneous_capacity_reached')
  const crossTenant = await dashboard('clientId='+other)
  assert.equal(crossTenant.status,403)
  assert.equal((await dashboard('clientId='+other,'admin')).status,200)
  assert.equal((await dashboard('','other','PATCH',{id:saved.appointment_id,version:1,action:'cancel'})).status,404)
  const scoped = await (await dashboard('status=booked','other')).json()
  assert.ok(!scoped.appointments.some(item=>item.id===saved.appointment_id))
  const noticeJobs=(await db.query("select job_key,payload from service_jobs where payload->>'appointment_id'=any($1) order by job_key", [[saved.appointment_id,pending.appointment_id]])).rows
  assert.equal(noticeJobs.length,4)
  for (const {payload} of noticeJobs) {
    const mail = await emailBuilder(globalThis.__appointmentSchedulingDb,tenant,payload)
    assert.equal(mail.to[0],payload.recipient==='owner'?'owner@example.test':'buyer@example.test')
    if (payload.status==='pending') {
      assert.match(mail.subject,/Awaiting Confirmation/)
      assert.doesNotMatch(mail.text,/Duration:|Ends:/)
    } else {
      assert.match(mail.text,/Duration: 30 minutes/)
      assert.match(mail.text,/Timezone: America\/Toronto/)
    }
  }
  const customerJob=noticeJobs.find(job=>job.payload.status==='booked' && job.payload.recipient==='customer')
  const originalFetch=globalThis.fetch
  const sent=[]
  process.env.RESEND_API_KEY='synthetic-resend-key'
  globalThis.fetch=async (url,request)=>{
    assert.equal(url,'https://api.resend.com/emails')
    sent.push({ key:request.headers['Idempotency-Key'],body:JSON.parse(request.body) })
    return Response.json({id:'synthetic-email-id'})
  }
  try {
    await jobRunner(globalThis.__appointmentSchedulingDb,customerJob.job_key)
    await jobRunner(globalThis.__appointmentSchedulingDb,customerJob.job_key)
    assert.deepEqual(sent.map(item=>item.key),[customerJob.job_key])
    assert.match(sent[0].body.subject,/Appointment Confirmed/)
    const completed = (await db.query('select status,provider_message_id from service_jobs where job_key=$1',[customerJob.job_key])).rows[0]
    assert.deepEqual(completed,{status:'complete',provider_message_id:'synthetic-email-id'})
  } finally { globalThis.fetch=originalFetch; delete process.env.RESEND_API_KEY }
})

test('appointment counts use local creation dates and keep excluded rows and permissions out', async () => {
  await db.exec('begin')
  try {
    const { rows: [clock] } = await db.query(`
      select ((statement_timestamp() at time zone 'UTC')::date - 1)::text utc_day,
        ((statement_timestamp() at time zone 'UTC')::date - 2)::text toronto_day
    `)
    const params = [tenant, other, clock.utc_day]
    const counts = async zone => (await db.query(
      'select day::text, count::int from public.recepta_confirmed_appointment_activity($1,$2)', [tenant, zone],
    )).rows
    const beforeToronto = await counts('America/Toronto')
    const beforeUtc = await counts('UTC')
    await db.query(`
      insert into appointments(client_id, status, source, created_at)
      values ($1, 'completed', 'retell', ($3::date + time '01:00') at time zone 'UTC'),
        ($1, 'pending', 'retell', ($3::date + time '01:00') at time zone 'UTC'),
        ($1, 'cancelled', 'retell', ($3::date + time '01:00') at time zone 'UTC'),
        ($1, 'completed', 'retell', now() - interval '8 days'),
        ($2, 'completed', 'retell', ($3::date + time '01:00') at time zone 'UTC')
    `, params)
    const toronto = await counts('America/Toronto')
    const utc = await counts('UTC')
    const delta = (after, before, day) => after.find(row => row.day === day).count - before.find(row => row.day === day).count
    assert.equal(delta(toronto, beforeToronto, clock.toronto_day), 1)
    assert.equal(delta(toronto, beforeToronto, clock.utc_day), 0)
    assert.equal(delta(utc, beforeUtc, clock.utc_day), 1)
    const { rows: [grants] } = await db.query(`select
      has_function_privilege('anon','public.recepta_confirmed_appointment_activity(uuid,text)','execute') as anon,
      has_function_privilege('authenticated','public.recepta_confirmed_appointment_activity(uuid,text)','execute') as customer`)
    assert.deepEqual(grants, {anon: false, customer: false})
  } finally {
    await db.exec('rollback')
  }
})

test('an analytics database failure is an error rather than an empty week', async () => {
  const dbClient = globalThis.__appointmentSchedulingDb
  const rpc = dbClient.rpc
  dbClient.rpc = (name, args) => name === 'recepta_confirmed_appointment_activity'
    ? { data: null, error: new Error('Synthetic database failure') }
    : rpc(name, args)
  try {
    assert.equal((await dashboard('view=confirmed-activity')).status, 500)
  } finally {
    dbClient.rpc = rpc
  }
})

test('disabled automatic booking keeps pending intake available and enforces Pro and explicit email consent', async () => {
  const date=futureDate(55)
  await save(tenant,rules({ enabled:false,email_customer:true }))
  const disabled=await (await invoke('recepta_check_availability',{ requested_date:date,requested_time:'09:00' })).json()
  assert.equal(disabled.reason,'automatic_booking_disabled')
  const local=await (await invoke('recepta_check_availability',{})).json()
  assert.match(local.business_date,/^\d{4}-\d{2}-\d{2}$/)
  assert.equal(local.time_zone,'America/Toronto')
  assert.equal(local.reason,'automatic_booking_disabled')
  const pending=await (await invoke('recepta_save_appointment_details',detail,'no-consent')).json()
  assert.equal(pending.status,'pending')
  assert.equal((await db.query("select count(*)::int n from service_jobs where payload->>'appointment_id'=$1",[pending.appointment_id])).rows[0].n,0)
  await db.query("update subscriptions set plan_name='Recepta Standard' where client_id=$1",[tenant])
  assert.equal((await dashboard()).status,403)
  assert.equal((await dashboard('view=settings')).status,403)
  assert.equal((await dashboard('view=confirmed-activity')).status,403)
  assert.equal((await invoke('recepta_save_appointment_details',detail,'standard')).status,403)
  assert.equal((await call('recepta_change_appointment',[tenant,'book',await localStart(date,'09:00'),null,null,'direct-standard',detail])).reason,'pro_required')
  await db.query("update subscriptions set plan_name='Recepta Pro',status='pending' where client_id=$1",[tenant])
  const pendingPlan=await invoke('recepta_save_appointment_details',detail,'unpaid-plan')
  assert.equal(pendingPlan.status,403)
  assert.equal((await pendingPlan.json()).code,'inactive_pro_subscription')
  assert.equal((await db.query("select count(*)::int n from appointments where retell_call_id='unpaid-plan'")).rows[0].n,0)
  await db.query("update subscriptions set status='active' where client_id=$1",[tenant])
})

test('internal appointment grants are admin-only, agent-bound, limited, auditable and revocable without paid billing', async () => {
  if (!signedHandler) await initializeHandlers()
  const adminId = '00000000-0000-0000-0000-000000000103'
  const expiresAt = new Date(Date.now()+3600000).toISOString()
  // No payment is assigned to either test tenant. Existing billing fields remain untouched after the test.
  await db.query("update subscriptions set status='pending',stripe_subscription_id=null where client_id in ($1,$2)",[tenant,other])
  try {
    assert.equal((await invoke('recepta_save_appointment_details',detail,'blocked-before-grant')).status,403)
    assert.equal((await dashboard()).status,403)
    const grantBody={clientId:tenant,agentId:'agent_one',expiresAt,maxCalls:2,maxInvocations:4}
    assert.equal((await adminTest('POST',grantBody,'other')).status,403)
    assert.equal((await adminTest('POST',{...grantBody,agentId:'agent_two'})).status,409)
    assert.equal((await adminTest('POST',{...grantBody,maxCalls:11})).status,400)
    const granted=await adminTest('POST',grantBody)
    assert.equal(granted.status,201)
    const allowed=(await granted.json()).grant
    assert.equal(allowed.client_id,tenant)
    assert.equal(allowed.retell_agent_id,'agent_one')
    assert.equal((await db.query('select status,stripe_subscription_id from subscriptions where client_id=$1',[tenant])).rows[0].status,'pending')
    const direct=await call('recepta_appointment_test_check',[tenant,'agent_one'])
    assert.equal(direct.active,true)
    assert.equal(direct.can_use,true)
    assert.equal((await call('recepta_appointment_test_check',[other,'agent_two'])).active,false)
    assert.equal((await invoke('recepta_save_appointment_details',detail,'unpaid-other',{
      agent_id:'agent_two',metadata:{recepta_client_id:other},
    })).status,403)
    assert.equal((await adminTest('GET',null,'other')).status,403)
    const acl=(await db.query(`select
      has_table_privilege('anon','public.recepta_appointment_test_grants','select') as anon_grant_read,
      has_table_privilege('authenticated','public.recepta_appointment_test_usage','select') as customer_audit_read,
      has_function_privilege('authenticated','public.recepta_grant_appointment_test(uuid,text,timestamptz,integer,integer,uuid)','execute') as customer_can_issue,
      has_function_privilege('anon','public.recepta_authorize_appointment_tool(uuid,text,text,text)','execute') as anon_can_authorize`)).rows[0]
    assert.deepEqual(acl,{
      anon_grant_read:false,customer_audit_read:false,customer_can_issue:false,anon_can_authorize:false,
    })

    const date=futureDate(70)
    const avail=await invoke('recepta_check_availability',{requested_date:date},'qa-call-1')
    assert.equal(avail.status,200)
    const pending1=await (await invoke('recepta_save_appointment_details',{
      ...detail,preferred_date:date,appointment_details:[{label:'Service type',value:'Roof repair'}],
    },'qa-call-1')).json()
    assert.equal(pending1.success,true)
    assert.equal(pending1.status,'pending')
    const pending2=await (await invoke('recepta_save_appointment_details',detail,'qa-call-2')).json()
    assert.equal(pending2.status,'pending')
    assert.equal((await invoke('recepta_check_availability',{requested_date:date},'qa-call-3')).status,403)
    assert.equal((await invoke('recepta_check_availability',{requested_date:date},'qa-call-2')).status,200)
    const exhausted=await invoke('recepta_save_appointment_details',detail,'qa-call-1')
    assert.equal(exhausted.status,403)
    assert.equal((await exhausted.json()).code,'test_entitlement_exhausted')
    const rows=(await db.query('select used_calls,used_invocations from recepta_appointment_test_grants where id=$1',[allowed.id])).rows[0]
    assert.deepEqual(rows,{used_calls:2,used_invocations:4})
    const usage=(await db.query('select tool_name,call_hash from recepta_appointment_test_usage where grant_id=$1',[allowed.id])).rows
    assert.equal(usage.length,4)
    assert.ok(usage.every(row=>row.call_hash.length===32 && !row.call_hash.includes('qa-call')))
    // After quota exhaustion the unpaid customer cannot keep invoking appointment
    // APIs, but the normal admin must still be able to see the persisted request.
    const shown=await (await dashboard('clientId='+tenant+'&status=pending','admin')).json()
    assert.ok(shown.appointments.some(a=>a.id===pending1.appointment_id))
    assert.equal((await db.query("select notes from appointments where id=$1",[pending1.appointment_id])).rows[0].notes.includes('Roof repair'),true)
    const grantStatus=await adminTest('GET',null,'admin')
    assert.equal(grantStatus.status,400) // GET requires explicit query IDs, preventing accidental full enumeration.

    const revoke=await adminTest('DELETE',{clientId:tenant,agentId:'agent_one'})
    assert.equal(revoke.status,200)
    assert.equal((await revoke.json()).revoked,true)
    assert.equal((await invoke('recepta_save_appointment_details',detail,'after-revocation')).status,403)
    assert.equal((await call('recepta_appointment_test_check',[tenant,'agent_one'])).active,false)
    await assert.rejects(call('capture_recepta_appointment_request',[tenant,'direct-no-grant',{customer_name:'Not Allowed'}]),{code:'42501'})
    assert.equal((await db.query('select revoked_by is not null as tracked from recepta_appointment_test_grants where id=$1',[allowed.id])).rows[0].tracked,true)

    const replacement=await adminTest('POST',{...grantBody,expiresAt:new Date(Date.now()+3600000).toISOString()})
    assert.equal(replacement.status,201)
    const replacementId=(await replacement.json()).grant.id
    await db.query("update recepta_appointment_test_grants set expires_at=now()-interval '1 second' where id=$1",[replacementId])
    assert.equal((await invoke('recepta_save_appointment_details',detail,'after-expiration')).status,403)
    assert.equal((await call('recepta_appointment_test_check',[tenant,'agent_one'])).active,false)
    // No grant could have enabled inbound calling, transfers, or Stripe billing.
    assert.deepEqual((await db.query('select client_id,status,stripe_subscription_id from subscriptions order by client_id')).rows
      .map(r=>({client_id:r.client_id,status:r.status,stripe_subscription_id:r.stripe_subscription_id})),[
      {client_id:tenant,status:'pending',stripe_subscription_id:null},
      {client_id:other,status:'pending',stripe_subscription_id:null},
    ])
  } finally {
    await db.query("update subscriptions set status='active', stripe_subscription_id=case when client_id=$1 then 'sub_test_one' else 'sub_test_two' end where client_id in ($1,$2)",[tenant,other])
    await db.query("update recepta_appointment_test_grants set revoked_at=coalesce(revoked_at,now()),revoked_by=coalesce(revoked_by,$1) where revoked_at is null",[adminId])
  }
})

test('admins can prepare an unpaid account while customers and callers still require paid Pro', async () => {
  if (!dashboardHandler) await initializeHandlers()
  await db.query("update subscriptions set current_period_end=now()-interval '1 hour' where client_id=$1",[tenant])
  try {
    const settings=rules({duration_minutes:37,start_interval_minutes:20,buffer_minutes:13,capacity:5,hourly_limit:7})
    const customer=await dashboard('','tenant','PUT',{settings})
    assert.equal(customer.status,403)
    assert.match((await customer.json()).error,/active Recepta Pro billing/)
    assert.equal((await dashboard('clientId='+tenant,'other','PUT',{settings})).status,403)
    const prep=await dashboard('clientId='+tenant,'admin','PUT',{settings})
    assert.equal(prep.status,200)
    const prepared=await prep.json()
    assert.equal(prepared.synced,false)
    assert.equal(prepared.settings.duration_minutes,37)
    assert.equal(prepared.settings.capacity,5)
    assert.equal((await invoke('recepta_check_availability',{})).status,403)
    await assert.rejects(save(tenant,settings),{code:'42501'})
    assert.equal((await dashboard('clientId='+tenant,'admin','POST')).status,403)
    const grants = (await db.query(`select has_function_privilege(
      'authenticated','public.recepta_save_scheduling_settings(uuid,jsonb,boolean)','execute') as prepare`)).rows[0]
    assert.equal(grants.prepare,false)
  } finally {
    await db.query("update subscriptions set current_period_end=now()+interval '1 month' where client_id=$1",[tenant])
  }
})

test('settings save registers signed Retell tools, preserves other functions and uses live database rules after later edits', async () => {
  if (!dashboardHandler) await initializeHandlers()
  const originalFetch=globalThis.fetch
  const originalUrl=process.env.URL
  process.env.URL='https://example.test'
  const existing = [
    { type:'transfer_call',name:'transfer_call',transfer_destination:{type:'predefined',number:'+14165550125'} },
    { type:'end_call',name:'end_call' },{ type:'custom',name:'business_email' },
  ]
  let written, versions=0, liveVersion=1
  const states = [{ name: 'fallback', tools: [existing[0], { type: 'custom', name: 'recepta_book_appointment' }] }]
  globalThis.fetch=async (url,request)=>{
    const path = new URL(url).pathname
    if (path === '/.netlify/functions/retell-appointment') return signedHandler(new Request(url, request))
    const agent = version => ({ agent_id:'agent_one', is_published:version === liveVersion, version,
      response_engine:{type:'retell-llm',llm_id:'llm_test',version} })
    if (path.startsWith('/get-agent')) return Response.json(agent(liveVersion))
    if (path.startsWith('/create-agent-version')) { versions++; return Response.json(agent(liveVersion + 1)) }
    if (path.startsWith('/get-retell-llm')) return Response.json(written ?? {
      general_prompt:'Business script.\n\n[RECEPTA MANAGED APPOINTMENT BOOKING]\nLegacy calendar.\n\nLegacy request instructions.\n\n[RECEPTA MANAGED CALL EMAIL]\nKeep email policy.\n\nManual transfer instructions.',
      general_tools:existing,states,default_dynamic_variables:{ business:'sample' },
    })
    if (path.startsWith('/update-retell-llm')) written=JSON.parse(request.body)
    if (path.startsWith('/publish-agent-version')) liveVersion=JSON.parse(request.body).version
    assert.ok(path.startsWith('/update-retell-llm')||path.startsWith('/publish-agent-version'))
    return Response.json({})
  }
  try {
    const date=futureDate(62)
    const response=await (await dashboard('','tenant','PUT',{settings:rules()})).json()
    assert.equal(response.synced,true,response.settings?.sync_error)
    assert.deepEqual(written.general_tools.slice(0,existing.length),existing)
    assert.equal(written.default_dynamic_variables.business,'sample')
    assert.deepEqual(written.states,[{name:'fallback',tools:[existing[0]]}])
    assert.deepEqual(written.general_tools.slice(existing.length).map(tool=>tool.name),[
      'recepta_save_appointment_details','recepta_check_availability','recepta_book_appointment',
    ])
    assert.ok(written.general_tools.slice(existing.length).every(tool=>tool.args_at_root===false && tool.url==='https://example.test/.netlify/functions/retell-appointment'))
    assert.match(written.general_prompt,/Manual transfer instructions/)
    assert.match(written.general_prompt,/only when the booking tool returns success with status booked/)
    assert.match(written.general_prompt,/Keep email policy/)
    assert.doesNotMatch(written.general_prompt,/Legacy calendar|Legacy request instructions/)
    const changed=await (await dashboard('','tenant','PUT',{settings:rules({hourly_limit:0})})).json()
    assert.equal(changed.synced,true)
    assert.equal(versions,1)
    const retry = await dashboard('clientId='+tenant, 'admin', 'POST')
    assert.equal(retry.status, 200)
    assert.equal(versions,1)
    const unchanged=await db.query('select updated_at from booking_settings where client_id=$1',[tenant])
    assert.equal((await dashboard('', 'tenant', 'POST')).status,200)
    assert.equal((await db.query('select updated_at from booking_settings where client_id=$1',[tenant])).rows[0].updated_at.getTime(),
      unchanged.rows[0].updated_at.getTime())
    written.general_tools.find(tool=>tool.name==='recepta_book_appointment').url = 'https://old.example.test'
    const setup = await (await dashboard('clientId='+tenant+'&readiness=1', 'admin')).json()
    assert.match(setup.checks.find(check=>check.label==='Published appointment tools').detail, /wrong Recepta endpoint/)
    assert.equal(setup.checks.find(check=>check.label==='Signed appointment endpoint').status,'ready')
    assert.equal(setup.checks.find(check=>check.label==='Phone routing').status,'blocked')
    assert.equal((await dashboard('clientId='+tenant+'&readiness=1', 'other')).status,403)
    assert.equal((await dashboard('clientId='+tenant, 'admin', 'POST')).status,200)
    assert.equal(versions,2)
    assert.match(written.general_tools.find(tool=>tool.name==='recepta_book_appointment').url,/example.test\/\.netlify/)
    const stopped=await (await invoke('recepta_check_availability',{requested_date:date,requested_time:'09:00'})).json()
    assert.equal(stopped.reason,'hourly_capacity_reached')
    assert.deepEqual(stopped.alternatives,[])
    const invalid=await dashboard('','tenant','PUT',{settings:rules({time_zone:'bad/zone'})})
    assert.equal(invalid.status,400)
  } finally {
    globalThis.fetch=originalFetch
    if (originalUrl === undefined) delete process.env.URL
    else process.env.URL=originalUrl
  }
})

test('service access uses verified admin, published Retell assignment, and the same inbound and appointment entitlement', async () => {
  if (!serviceHandler) await initializeHandlers()
  const originalFetch = globalThis.fetch
  const requests = []
  const requestService = (body, token = 'admin') => serviceHandler(new Request(
    'https://recepta.ca/.netlify/functions/admin-service-access?clientId=' + tenant, {
      method: body ? 'PUT' : 'GET', headers: { Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    },
  ))
  const requestCall = async (id, to = '+14165550100') => {
    const body = JSON.stringify({ event: 'call_inbound', call_inbound: { call_id: id, to_number: to, from_number: '+14165550109' } })
    const time = Date.now()
    const digest = createHmac('sha256', secret).update(body + time).digest('hex')
    const response = await inbound(new Request('https://recepta.ca/.netlify/functions/retell-inbound', {
      method: 'POST', body, headers: { 'x-retell-signature': 'v=' + time + ',d=' + digest },
    }))
    assert.equal(response.status, 200)
    return (await response.json()).call_inbound
  }
  const body = { action: 'activate_test', plan: 'Recepta Pro', agentId: 'agent_one',
    reason: 'Staging phone and appointment test', maxMinutes: 2, expiresAt: new Date(Date.now() + 3600000).toISOString() }
  const availability = id => invoke('recepta_check_availability', { requested_date: futureDate() }, id)
  await db.query("update subscriptions set status='pending', stripe_subscription_id=null where client_id=$1", [tenant])
  await db.query("update agents set status='setup', business_hours=null, phone_number='+14165550100' where client_id=$1", [tenant])
  let published = false
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, undefined)
    requests.push(String(url))
    assert.equal(options.headers.Authorization, 'Bearer ' + secret)
    if (url.includes('/get-agent/agent_one?version=latest_published')) {
      return Response.json({ agent_id: 'agent_one', version: 5, is_published: published })
    }
    if (url.includes('/get-phone-number/')) {
      return Response.json({ phone_number: '+14165550100', inbound_agents: [],
        inbound_webhook_url: 'https://recepta.ca/.netlify/functions/retell-inbound' })
    }
    throw new Error('Unexpected provider request ' + url)
  }
  try {
    const blocked = await requestCall('admin-access-before-grant')
    assert.deepEqual(blocked, { reject: true })
    assert.equal((await availability('admin-access-before-grant')).status, 403)
    assert.equal((await requestService({ ...body, revision: 0 }, 'tenant')).status, 403)
    assert.equal(requests.length, 0)
    assert.equal((await requestService({ ...body, revision: 0, reason: ' ' })).status, 400)
    assert.equal((await requestService({ ...body, revision: 0, maxMinutes: 0 })).status, 400)
    assert.equal((await requestService({ ...body, revision: 0, agentId: 'agent_two' })).status, 409)
    assert.equal((await requestService({ ...body, revision: 0 })).status, 409)
    assert.equal((await call('recepta_service_access', [tenant])).revision, 0)
    published = true

    const response = await requestService({ ...body, revision: 0 })
    assert.equal(response.status, 200, await response.clone().text())
    const { access } = await response.json()
    assert.equal(access.mode, 'internal_test')
    assert.equal(access.status, 'active')
    assert.equal(access.source, 'internal_test')
    assert.equal(access.billing_status, 'pending')
    assert.equal(access.has_stripe_subscription, false)
    assert.equal(access.remaining_seconds, 120)
    assert.equal((await requestService({ ...body, revision: 0 })).status, 409)
    assert.deepEqual((await db.query('select status, retell_agent_id, phone_number, business_hours from agents where client_id=$1', [tenant])).rows[0],
      { status: 'setup', retell_agent_id: 'agent_one', phone_number: '+14165550100', business_hours: null })
    assert.equal((await availability('no-phone-reservation')).status, 403)
    assert.deepEqual(await requestCall('wrong-number-reservation', '+14165550999'), { reject: true })

    const admitted = await requestCall('test-allowance')
    assert.equal(admitted.override_agent_id, 'agent_one')
    assert.equal(admitted.agent_override.agent.max_call_duration_ms, 120000)
    assert.equal((await requestCall('test-allowance')).metadata.recepta_reservation_id, admitted.metadata.recepta_reservation_id)
    assert.equal((await availability('test-allowance')).status, 200)
    assert.deepEqual(await requestCall('allowance-held'), { reject: true })
    await db.query("update call_minute_reservations set status='completed', used_seconds=60 where retell_call_id='test-allowance'")
    assert.equal((await call('recepta_service_access', [tenant])).remaining_seconds, 60)

    const edited = await requestService({ ...body, revision: 1, reason: 'Reviewed staging test' })
    assert.equal(edited.status, 200)
    assert.equal((await edited.json()).access.remaining_seconds, 60)
    assert.equal((await requestCall('remaining-allowance')).agent_override.agent.max_call_duration_ms, 60000)
    assert.deepEqual(await requestCall('allowance-depleted'), { reject: true })

    const revoked = await requestService({ action: 'revoke', revision: 2 })
    assert.equal(revoked.status, 200)
    assert.equal((await revoked.json()).access.status, 'pending')
    assert.deepEqual(await requestCall('after-revocation'), { reject: true })
    assert.equal((await availability('remaining-allowance')).status, 403)
    const log = (await db.query('select actor_id, action, previous_state, new_state from recepta_service_access_audit where client_id=$1 order by occurred_at', [tenant])).rows
    assert.deepEqual(log.map(item => item.action), ['activate_test', 'activate_test', 'revoke'])
    assert.ok(log.every(item => item.actor_id === '00000000-0000-0000-0000-000000000103'))
    assert.equal(log[2].previous_state.mode, 'internal_test')
    assert.equal(log[2].new_state.mode, 'pending')

    const manual = await requestService({ ...body, action: 'save', mode: 'manual', plan: 'Recepta Standard', revision: 3 })
    assert.equal(manual.status, 200)
    const { access: grant } = await manual.json()
    assert.equal(grant.source, 'manual_admin')
    assert.equal(grant.remaining_seconds, 6000)
    assert.equal((await requestCall('manual-standard')).override_agent_id, 'agent_one')
    assert.equal((await availability('manual-standard')).status, 403)
    await db.query("update recepta_service_overrides set started_at=now()-interval '2 days', expires_at=now()-interval '1 day' where client_id=$1", [tenant])
    assert.equal((await call('recepta_service_access', [tenant])).status, 'expired')
    assert.deepEqual(await requestCall('after-expiry'), { reject: true })

    const permissions = (await db.query(`select
      has_table_privilege('authenticated', 'recepta_service_overrides', 'update') as can_update,
      has_table_privilege('authenticated', 'recepta_service_access_audit', 'select') as can_read_audit,
      has_function_privilege('authenticated',
        'recepta_save_service_access(uuid,uuid,text,text,text,text,text,timestamptz,integer,integer)', 'execute') as can_grant`)).rows[0]
    assert.deepEqual(permissions, { can_update: false, can_read_audit: false, can_grant: false })
    assert.ok(requests.every(url => /\/get-(agent|phone-number)\//.test(url)))
  } finally {
    globalThis.fetch = originalFetch
    await db.query("update subscriptions set status='active', stripe_subscription_id='sub_test_one' where client_id=$1", [tenant])
    await db.query("update agents set status='live', phone_number=null where client_id=$1", [tenant])
    await call('recepta_save_service_access', [tenant, '00000000-0000-0000-0000-000000000103', 'save', 'automatic', null, null, null, null, null,
      (await call('recepta_service_access', [tenant])).revision])
  }
})

test('Admin activation synchronizes an existing Retell line and plan, and reactivation preserves the grant and usage', async () => {
  if (!serviceHandler) await initializeHandlers()
  const phone = '+14165550100'
  const originalFetch = globalThis.fetch
  const writes = []
  const transfer = { type: 'transfer_call', name: 'transfer_to_staff', transfer_destination: { number: '+14165550109' } }
  const route = { phone_number: phone, inbound_webhook_url: null, inbound_agents: [{ agent_id: 'agent_one' }],
    outbound_agents: [{ agent_id: 'agent_one' }] }
  const versions = new Map([[1, {
    agent: { agent_id: 'agent_one', version: 1, response_engine: { type: 'retell-llm', llm_id: 'llm_one', version: 1 } },
    llm: { general_prompt: 'Existing business script.', knowledge_base_ids: ['kb_existing'], general_tools: [transfer] },
  }]])
  let publishedVersion = 1
  globalThis.fetch = async (url, request) => {
    const { pathname, searchParams } = new URL(url)
    const method = request.method ?? 'GET'
    const payload = request.body ? JSON.parse(request.body) : null
    if (method !== 'GET') writes.push({ pathname, payload })
    const version = Number(searchParams.get('version')) || publishedVersion
    if (pathname.startsWith('/get-agent/')) return Response.json({ ...versions.get(version).agent, is_published: version === publishedVersion })
    if (pathname.startsWith('/create-agent-version/')) {
      const nextVersion = versions.size + 1
      const draft = structuredClone(versions.get(publishedVersion))
      draft.agent = { ...draft.agent, version: nextVersion, response_engine: { ...draft.agent.response_engine, version: nextVersion } }
      versions.set(nextVersion, draft)
      return Response.json(draft.agent)
    }
    if (pathname.startsWith('/get-retell-llm/')) return Response.json(versions.get(version).llm)
    if (pathname.startsWith('/update-retell-llm/')) Object.assign(versions.get(version).llm, payload)
    else if (pathname.startsWith('/update-agent/')) Object.assign(versions.get(version).agent, payload)
    else if (pathname.startsWith('/publish-agent-version/')) publishedVersion = payload.version
    else if (pathname.startsWith('/get-phone-number/')) return Response.json(route)
    else if (pathname.startsWith('/update-phone-number/')) Object.assign(route, payload)
    else throw new Error('Unexpected request ' + url)
    return Response.json({})
  }
  const request = (body, token = 'admin', history = false) => serviceHandler(new Request(
    'https://recepta.ca/.netlify/functions/admin-service-access?clientId=' + tenant + (history ? '&history=1' : ''), {
      method: body ? 'PUT' : 'GET', headers: { Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    },
  ))
  const save = async fields => {
    const current = await call('recepta_service_access', [tenant])
    const response = await request({
      action: 'save', mode: 'manual', agentStatus: 'live', agentId: 'agent_one',
      servicePlan: 'Recepta Pro', reason: 'Authorized service for this business', revision: current.revision,
      ...fields,
    })
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).access
  }
  const admit = async id => {
    const body = JSON.stringify({ event: 'call_inbound', call_inbound: { call_id: id, to_number: phone, from_number: '+14165550109' } })
    const time = Date.now()
    const digest = createHmac('sha256', secret).update(body + time).digest('hex')
    const response = await inbound(new Request('https://recepta.ca/.netlify/functions/retell-inbound', {
      method: 'POST', body, headers: { 'x-retell-signature': 'v=' + time + ',d=' + digest },
    }))
    assert.equal(response.status, 200)
    return (await response.json()).call_inbound
  }
  const appointment = id => invoke('recepta_check_availability', { requested_date: futureDate() }, id)
  await db.query("update subscriptions set status='pending', plan_name='Recepta Standard', stripe_subscription_id=null where client_id=$1", [tenant])
  await db.query("update agents set status='setup', phone_number=$2 where client_id=$1", [tenant, phone])
  const initialBilling = (await db.query('select * from subscriptions where client_id=$1', [tenant])).rows[0]
  try {
    const pending = await save({ mode: 'pending', agentStatus: 'setup' })
    assert.equal(pending.plan, 'Recepta Pro')
    assert.equal(pending.billing_plan, 'Recepta Standard')
    assert.deepEqual(await admit('pending-managed-pro'), { reject: true })
    assert.equal(writes.length, 0)
    assert.equal((await request({ action: 'activate', mode: 'manual', agentStatus: 'live', revision: pending.revision }, 'tenant')).status, 403)

    route.inbound_agents = [{ agent_id: 'unrelated_agent' }]
    const conflicting = await request({ action: 'activate', mode: 'manual', agentStatus: 'live', agentId: 'agent_one',
      revision: pending.revision, servicePlan: 'Recepta Pro', reason: 'Authorized', expiresAt: null })
    assert.equal(conflicting.status, 409)
    assert.equal((await call('recepta_service_access', [tenant])).revision, pending.revision)
    route.inbound_agents = [{ agent_id: 'agent_one' }]

    const active = await save({ action: 'activate' })
    assert.equal(active.status, 'active')
    assert.equal(active.agent_status, 'live')
    assert.equal(active.expires_at, null)
    assert.equal(active.source, 'manual_admin')
    assert.equal(active.billing_current, false)
    assert.equal(active.remaining_seconds, 6000)
    assert.deepEqual(route.outbound_agents, [{ agent_id: 'agent_one' }])
    assert.equal(route.inbound_webhook_url, 'https://recepta.ca/.netlify/functions/retell-inbound')
    assert.equal(route.inbound_agents, null)
    assert.deepEqual(versions.get(publishedVersion).llm.knowledge_base_ids, ['kb_existing'])
    assert.deepEqual(versions.get(publishedVersion).llm.general_tools[0], transfer)
    assert.match(versions.get(publishedVersion).llm.general_prompt, /Existing business script/)
    assert.equal(versions.get(publishedVersion).agent.webhook_url, 'https://recepta.ca/.netlify/functions/retell-webhook')

    const callId = 'standing-grant-call'
    assert.equal((await admit(callId)).override_agent_id, 'agent_one')
    assert.equal((await appointment(callId)).status, 200)
    await db.query("update call_minute_reservations set status='completed', used_seconds=60 where retell_call_id=$1", [callId])
    await db.query(`insert into call_minute_reservations(client_id, retell_call_id, period_start, reserved_seconds, used_seconds, status, service_grant_id)
      values($1,'prior-month-standing-usage',$2::timestamptz - interval '1 month', 600, 600, 'completed', $3)`,
    [tenant, active.period_start, active.grant_id])

    const paused = await save({ action: 'deactivate' })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.plan, 'Recepta Pro')
    assert.deepEqual(await admit('standing-grant-paused'), { reject: true })
    assert.equal((await appointment('standing-grant-paused')).status, 403)
    const resumed = await save({ action: 'reactivate' })
    assert.equal(resumed.grant_id, active.grant_id)
    assert.equal(resumed.remaining_seconds, 5940)

    const standard = await save({ servicePlan: 'Recepta Standard' })
    assert.equal(standard.status, 'active')
    assert.equal(standard.appointments, false)
    assert.deepEqual(versions.get(publishedVersion).llm.general_tools, [transfer])
    for (const mode of ['suspended', 'cancelled']) {
      const held = await save({ mode, servicePlan: 'Recepta Standard' })
      assert.equal(held.status, mode)
      assert.deepEqual(await admit('standing-grant-' + mode), { reject: true })
    }
    for (const agentStatus of ['setup', 'paused', 'testing']) {
      const held = await save({ agentStatus })
      assert.equal(held.agent_status, agentStatus)
      assert.equal(held.can_reserve, false)
      assert.equal(held.appointments, false)
    }
    const testing = await save({ action: 'activate_test', mode: 'internal_test', agentStatus: 'testing',
      expiresAt: new Date(Date.now() + 3600000).toISOString(), maxMinutes: 3 })
    assert.equal(testing.agent_status, 'testing')
    assert.equal(testing.remaining_seconds, 180)
    assert.equal((await admit('managed-agent-testing')).override_agent_id, 'agent_one')
    assert.deepEqual((await db.query('select * from subscriptions where client_id=$1', [tenant])).rows[0], initialBilling)
    const response = await request(null, 'admin', true)
    assert.equal(response.status, 200)
    const { history } = await response.json()
    assert.ok(history.some(item => item.action === 'reactivate'))
    assert.ok(history.some(item => item.new_state.mode === 'suspended' && item.actor_id === '00000000-0000-0000-0000-000000000103'))
    assert.equal((await request(null, 'tenant', true)).status, 403)
  } finally {
    globalThis.fetch = originalFetch
    await db.query("update subscriptions set status='active', plan_name='Recepta Pro', stripe_subscription_id='sub_test_one' where client_id=$1", [tenant])
    await db.query("update agents set status='live', phone_number=null where client_id=$1", [tenant])
    const current = await call('recepta_service_access', [tenant])
    await call('recepta_manage_client_service', [tenant, '00000000-0000-0000-0000-000000000103',
      'save', 'automatic', null, null, null, null, null, current.revision, null])
  }
})
