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
    current_period_start timestamptz, current_period_end timestamptz);
  create table agents(client_id uuid primary key, retell_agent_id text, business_hours text);
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
]

const pgUrl = process.env.RECEPTA_TEST_PG_URL
let native
const statements = await Promise.all(migrationFiles.map(file => readFile('supabase/migrations/' + file, 'utf8')))
const base = async (database) => {
  await database.exec(fixture)
  for (const migration of statements) await database.exec(migration)
  await database.query("insert into clients(id,company_name,contact_email) values($1,'First business','owner@example.test'),($2,'Second business','other@example.test')", [tenant, other])
  await database.query("insert into subscriptions(client_id,plan_name,status) values($1,'Recepta Pro','active'),($2,'Recepta Pro','active')", [tenant, other])
  await database.query("insert into agents values($1,'agent_one',null),($2,'agent_two',null)", [tenant, other])
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

let signedHandler, dashboardHandler, emailBuilder, jobRunner
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
    recepta_appointment_conflicts:['p_client','p_ids'],
    recepta_save_scheduling_settings:['p_client','p_rules'],
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
      const fields = columnsFor[name].filter(field=>field in args)
      const references=fields.map((field,index)=>field+' => $'+(index+1)).join(',')
      const parameters=fields.map(field=>args[field])
      try {
        if (name === 'recepta_appointment_conflicts' || name === 'claim_recepta_service_jobs') {
          return { data:(await db.query('select * from public.'+name+'('+references+')',parameters)).rows,error:null }
        }
        const result=(await db.query('select to_jsonb(public.'+name+'('+references+')) as result',parameters)).rows[0].result
        return { data:name==='recepta_save_scheduling_settings' ? [result] : result,error:null }
      } catch(error) { return { data:null,error } }
    },
  }
  signedHandler = (await bundle('netlify/functions/retell-appointment.ts')).default
  dashboardHandler = (await bundle('netlify/functions/appointment-scheduling.ts')).default
  emailBuilder = (await bundle('netlify/lib/appointmentNotification.ts')).loadAppointmentEmail
  jobRunner = (await bundle('netlify/lib/serviceJobs.ts')).processServiceJobs
}

const invoke = async (name, args, callId='test-call', changes={}, key=secret) => {
  const body = JSON.stringify({ name, args, call:{ agent_id:'agent_one', call_id:callId, from_number:'+14165550123',...changes } })
  const now = Date.now()
  const digest = createHmac('sha256',key).update(body+now).digest('hex')
  return signedHandler(new Request('https://synthetic.test',{ method:'POST',headers:{'x-retell-signature':`v=${now},d=${digest}`},body }))
}

const dashboard = (params='',token='tenant',method='GET',body) => dashboardHandler(new Request('https://synthetic.test/?'+params,{
  method,headers:{Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined,
}))

test('signed Retell requests persist in PostgreSQL and surface in the authorized dashboard with intake and email jobs', async () => {
  await initializeHandlers()
  const date = futureDate(51)
  await save(tenant,rules({ email_owner:true,email_customer:true }))
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

test('disabled automatic booking keeps pending intake available and enforces Pro and explicit email consent', async () => {
  const date=futureDate(55)
  await save(tenant,rules({ enabled:false,email_customer:true }))
  const disabled=await (await invoke('recepta_check_availability',{ requested_date:date,requested_time:'09:00' })).json()
  assert.equal(disabled.reason,'automatic_booking_disabled')
  const pending=await (await invoke('recepta_save_appointment_details',detail,'no-consent')).json()
  assert.equal(pending.status,'pending')
  assert.equal((await db.query("select count(*)::int n from service_jobs where payload->>'appointment_id'=$1",[pending.appointment_id])).rows[0].n,0)
  await db.query("update subscriptions set plan_name='Recepta Standard' where client_id=$1",[tenant])
  assert.equal((await dashboard()).status,403)
  assert.equal((await invoke('recepta_save_appointment_details',detail,'standard')).status,403)
  assert.equal((await call('recepta_change_appointment',[tenant,'book',await localStart(date,'09:00'),null,null,'direct-standard',detail])).reason,'pro_required')
  await db.query("update subscriptions set plan_name='Recepta Pro',status='pending' where client_id=$1",[tenant])
  const pendingPlan=await invoke('recepta_save_appointment_details',detail,'unpaid-plan')
  assert.equal(pendingPlan.status,403)
  assert.equal((await pendingPlan.json()).code,'inactive_pro_subscription')
  assert.equal((await db.query("select count(*)::int n from appointments where retell_call_id='unpaid-plan'")).rows[0].n,0)
  await db.query("update subscriptions set status='active' where client_id=$1",[tenant])
})

test('settings save registers signed Retell tools, preserves other functions and uses live database rules after later edits', async () => {
  const originalFetch=globalThis.fetch
  const originalUrl=process.env.URL
  process.env.URL='https://example.test'
  const existing = [
    { type:'transfer_call',name:'transfer_call',transfer_destination:{type:'predefined',number:'+14165550125'} },
    { type:'end_call',name:'end_call' },{ type:'custom',name:'business_email' },
  ]
  let written, versions=0
  globalThis.fetch=async (url,request)=>{
    const path = new URL(url).pathname
    if (path.startsWith('/list-agent-versions')) { versions++; return Response.json({ items:[{version:1,is_published:true}] }) }
    if (path.startsWith('/create-agent-version')) return Response.json({ version:2,response_engine:{type:'retell-llm',llm_id:'llm_test',version:2} })
    if (path.startsWith('/get-retell-llm')) return Response.json({
      general_prompt:'Business script.\n\n[RECEPTA MANAGED APPOINTMENT BOOKING]\nLegacy calendar.\n\nManual transfer instructions.',
      general_tools:existing,default_dynamic_variables:{ business:'sample' },
    })
    if (path.startsWith('/update-retell-llm')) written=JSON.parse(request.body)
    assert.ok(path.startsWith('/update-retell-llm')||path.startsWith('/publish-agent-version'))
    return Response.json({})
  }
  try {
    const date=futureDate(62)
    const response=await (await dashboard('','tenant','PUT',{settings:rules()})).json()
    assert.equal(response.synced,true)
    assert.deepEqual(written.general_tools.slice(0,existing.length),existing)
    assert.equal(written.default_dynamic_variables.business,'sample')
    assert.deepEqual(written.general_tools.slice(existing.length).map(tool=>tool.name),[
      'recepta_save_appointment_details','recepta_check_availability','recepta_book_appointment',
    ])
    assert.ok(written.general_tools.slice(existing.length).every(tool=>tool.args_at_root===false && tool.url==='https://example.test/.netlify/functions/retell-appointment'))
    assert.match(written.general_prompt,/Manual transfer instructions/)
    assert.match(written.general_prompt,/only when that tool returns success with status booked/)
    assert.doesNotMatch(written.general_prompt,/Legacy calendar/)
    const changed=await (await dashboard('','tenant','PUT',{settings:rules({hourly_limit:0})})).json()
    assert.equal(changed.synced,true)
    assert.equal(versions,1)
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
