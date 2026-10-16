import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { CALL_MAX_SECONDS, CALL_MIN_SECONDS, DEMO_CALL_MAX_SECONDS } from '../netlify/lib/callMinutes.ts'

// Signed production handlers and real PostgreSQL accounting; synthetic provider
// boundaries. These tests never place calls, buy numbers or send owner emails.
const client = '00000000-0000-0000-0000-000000000001'
const otherClient = '00000000-0000-0000-0000-000000000002'
let db, rpcFailure, rpcResult
const originalFetch = globalThis.fetch
const quote = (name) => '"' + name.replaceAll('"', '""') + '"'
const query = (table) => {
  let values, single = false, conflict = 'retell_call_id', ignore = false
  const filters = []
  const execute = async () => {
    try {
      if (values) {
        const records = Array.isArray(values) ? values : [values]
        const keys = Object.keys(records[0])
        const params = []
        const tuples = records.map((record) => '(' + keys.map((key) => {
          params.push(record[key]); return '$' + params.length
        }).join(',') + ')')
        const result = await db.query(`insert into ${quote(table)} (${keys.map(quote).join(',')}) values ${tuples.join(',')}
          on conflict(${quote(conflict)}) ${ignore ? 'do nothing' : 'do update set ' + keys.map((key) => `${quote(key)}=excluded.${quote(key)}`).join(',')}
          returning *`, params)
        return { data: single ? result.rows[0] ?? null : result.rows, error: null }
      }
      let rows = (await db.query(`select * from ${quote(table)}`)).rows
      for (const [op, col, value] of filters) rows = rows.filter((row) => op === 'in' ? value.includes(row[col]) : row[col] === value)
      return { data: single ? rows[0] ?? null : rows, error: null }
    } catch (error) { return { data: null, error: { message: error.message } } }
  }
  const api = { select: () => api, order: () => api, limit: () => api,
    eq: (col, value) => { filters.push(['eq', col, value]); return api },
    in: (col, value) => { filters.push(['in', col, value]); return api },
    upsert: (value, options) => { values = value; conflict = options.onConflict; ignore = options.ignoreDuplicates; return api },
    update: () => { throw new Error('Admission must not mutate client, agent or subscription state') },
    maybeSingle: () => { single = true; return execute() },
    then: (resolve, reject) => execute().then(resolve, reject) }
  return api
}
globalThis.__minuteDb = {
  from: query,
  auth: { getUser: async () => ({ data: { user: { id: client } }, error: null }),
    admin: { getUserById: async () => ({ data: { user: { user_metadata: {} } }, error: null }) } },
  rpc: async (name, args) => {
    if (name === 'reserve_recepta_agent_call') {
      assert.deepEqual(Object.keys(args).sort(), ['p_agent_id', 'p_call_id', 'p_client_id'])
      if (rpcFailure) return { data: null, error: { message: 'Synthetic reservation database failure' } }
      if (rpcResult !== undefined) return { data: rpcResult, error: null }
      try {
        return { data: (await db.query('select * from reserve_recepta_agent_call($1,$2,$3)', [args.p_client_id, args.p_call_id, args.p_agent_id])).rows, error: null }
      } catch (error) { return { data: null, error: { message: error.message } } }
    }
    assert.equal(name, 'recepta_period_usage')
    return { data: (await db.query('select recepta_period_usage($1,$2,$3) as used', [args.p_client_id, args.p_period_start, args.p_period_end])).rows[0].used, error: null }
  },
}
const compile = async (path, exportName = 'default') => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'synthetic-db', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.__minuteDb', loader: 'js' }))
    } }] })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`))[exportName]
}
process.env.ADMIN_EMAIL = 'admin@example.test'
const inbound = await compile('netlify/functions/retell-inbound.ts')
const webhook = await compile('netlify/functions/retell-webhook.ts')
const refresh = await compile('netlify/functions/client-calls.ts')
const syncSubscription = await compile('netlify/lib/retell.ts', 'syncRetellSubscription')
const adminCreate = await compile('netlify/functions/create-client.ts')
const adminUpdate = await compile('netlify/functions/update-clients.ts')
const adminAgent = await compile('netlify/functions/update-client-agent.ts')
const syncPhone = await compile('netlify/lib/retell.ts', 'syncRetellPhoneBinding')
const purchasePhone = await compile('netlify/lib/retell.ts', 'purchaseRetellPhoneNumber')
process.env.SUPABASE_URL = 'https://synthetic.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
process.env.RETELL_API_KEY = 'synthetic-only'
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_only'
delete process.env.RESEND_API_KEY
const migration = await readFile('supabase/migrations/20261014192813_align_minute_enforcement.sql', 'utf8')
const setup = async (minutes = 5, rollover = 0, demoMode = true) => {
  db = new PGlite(); rpcFailure = false; rpcResult = undefined
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create table clients(id uuid primary key,status text);
    create table subscriptions(client_id uuid primary key,plan_name text,status text,monthly_minutes integer,
      stripe_subscription_id text,stripe_customer_id text,monthly_price numeric,ai_model_id text,
      pii_redaction_enabled boolean default false,safety_guardrails_enabled boolean,extra_phone_numbers integer,
      current_period_start timestamptz,current_period_end timestamptz,next_billing_date timestamptz);
    create table agents(client_id uuid,retell_agent_id text,phone_number text,business_hours text,status text);
    create table agent_phone_numbers(client_id uuid,phone_number text);
    create table employees(id uuid,client_id uuid,name text,role text,is_active boolean);
    create table employee_schedules(employee_id uuid,day_of_week integer,is_working boolean,start_time text,end_time text);
    create table appointments(client_id uuid,retell_call_id text,status text,appointment_time timestamptz);
    create table calls(id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id),retell_call_id text unique,
      caller_name text,caller_number text,started_at timestamptz not null default now(),duration_seconds integer not null default 0,
      call_status text,outcome text,disconnection_reason text,transcript text,recording_url text,summary text,
      user_sentiment text,call_successful boolean,appointment_booked boolean not null default false,
      retell_agent_id text,ended_at timestamptz,updated_at timestamptz not null default now());
    insert into clients values('${client}','active'),('${otherClient}','active');
    insert into subscriptions(client_id,plan_name,status,monthly_minutes,stripe_subscription_id,current_period_start,current_period_end)
      values('${client}','Synthetic Plan','active',${minutes},'sub_synthetic',now()-interval '1 day',now()+interval '29 days');
    insert into agents values('${client}','agent_test','+14165550100',null,'active');
    insert into agent_phone_numbers values('${client}','+14165550100');`)
  await db.exec(await readFile('supabase_add_minute_enforcement.sql', 'utf8'))
  await db.exec(await readFile('supabase_add_billing_notifications.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261014064906_call_notification_outbox.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261014174126_protect_call_lifecycle.sql', 'utf8'))
  // Reproduce the live drift, rather than testing only the already-correct local bootstrap.
  await db.exec(`alter table call_minute_reservations drop constraint call_minute_reservations_reserved_seconds_check;
    alter table call_minute_reservations add constraint call_minute_reservations_reserved_seconds_check check(reserved_seconds>=180);`)
  await db.exec(migration)
  await db.exec(await readFile('supabase/migrations/20261014201359_demo_only_call_limit.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261016145008_payment_controlled_activation.sql', 'utf8'))
  await db.query('update agents set demo_mode=$1', [demoMode])
  await db.query('update subscriptions set rollover_seconds=$1', [rollover])
}
const close = async () => { await db.close(); globalThis.fetch = originalFetch }
const signed = (payload) => {
  const body = JSON.stringify(payload), timestamp = Date.now()
  const digest = createHmac('sha256', process.env.RETELL_API_KEY).update(`${body}${timestamp}`).digest('hex')
  return new Request('https://synthetic.test', { method: 'POST', headers: { 'x-retell-signature': `v=${timestamp},d=${digest}` }, body })
}
const request = (id) => signed({ event: 'call_inbound', call_inbound: { call_id: id, agent_id: 'agent_test', to_number: '+14165550100', from_number: '+14165550200' } })
const admit = async (id) => { const response = await inbound(request(id)); assert.equal(response.status, 200); return (await response.json()).call_inbound }
const reservation = async (id) => (await db.query('select * from call_minute_reservations where retell_call_id=$1', [id])).rows[0]
const used = async (committed = false, start, end) => {
  const sub = (await db.query('select * from subscriptions')).rows[0]
  return (await db.query(`select ${committed ? 'recepta_committed_usage' : 'recepta_period_usage'}($1,$2,$3) as used`, [client, start ?? sub.current_period_start, end ?? sub.current_period_end])).rows[0].used
}
const complete = (id, seconds = 60, more = {}) => webhook(signed({ event: 'call_ended', call: {
  call_id: id, agent_id: 'agent_test', call_status: 'ended', start_timestamp: Date.now(), duration_ms: seconds * 1000, ...more,
} }))
const assertNoPause = async () => {
  assert.equal((await db.query('select status from clients where id=$1', [client])).rows[0].status, 'active')
  assert.ok(['active','live'].includes((await db.query('select status from agents')).rows[0].status))
}

test('database reservation and Retell duration agree at every remaining-balance boundary', async () => {
  await setup()
  try {
    for (const remaining of [0, 59, 60, 61, 119, 179, 180, 181, 300]) {
      await db.exec('delete from calls; delete from call_minute_reservations')
      await db.query("insert into calls(client_id,retell_call_id,duration_seconds,call_status) values($1,'prior', $2,'ended')", [client, 300 - remaining])
      const response = await admit('boundary_' + remaining)
      if (remaining < CALL_MIN_SECONDS) { assert.equal(response.reject, true); assert.equal(await reservation('boundary_' + remaining), undefined) }
      else {
        const row = await reservation('boundary_' + remaining)
        assert.equal(row.reserved_seconds, Math.min(remaining, DEMO_CALL_MAX_SECONDS))
        assert.equal(response.agent_override.agent.max_call_duration_ms, row.reserved_seconds * 1000)
        assert.equal(response.metadata.recepta_reservation_id, row.id)
        assert.equal(await used(true), 300 - remaining + row.reserved_seconds)
      }
      await assertNoPause()
    }
  } finally { await close() }
})

test('concurrent callers share one budget; HTTP retries reuse one hold without pausing service', async () => {
  await setup(6)
  try {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => admit('concurrent_' + i)))
    assert.equal(replies.filter((reply) => !reply.reject).length, 2)
    assert.equal(await used(true), 360)
    const rows = (await db.query('select * from call_minute_reservations')).rows
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => admit(rows[0].retell_call_id)))
    assert.ok(duplicates.every((reply) => reply.metadata.recepta_reservation_id === rows[0].id))
    assert.equal((await db.query('select count(*)::int as n from call_minute_reservations')).rows[0].n, 2)
    await assertNoPause()
    assert.equal((await complete(rows[0].retell_call_id, 60)).status, 204)
    assert.equal(await used(true), 240)
    assert.equal((await admit('after_completion')).agent_override.agent.max_call_duration_ms, 120000)
    assert.equal((await admit(rows[0].retell_call_id)).reject, true)
    await assertNoPause()
  } finally { await close() }
})

test('terminal call storage settles holds atomically without reservation metadata and replays cannot refund usage', async () => {
  await setup()
  try {
    await admit('settlement')
    await db.exec('alter table call_minute_reservations add constraint synthetic_fail check(used_seconds is null)')
    assert.equal((await complete('settlement')).status, 500)
    assert.equal((await db.query('select count(*)::int as n from calls')).rows[0].n, 0)
    assert.equal((await reservation('settlement')).status, 'active'); assert.equal(await used(true), 180)
    await db.exec('alter table call_minute_reservations drop constraint synthetic_fail')
    assert.equal((await complete('settlement')).status, 204)
    assert.equal((await reservation('settlement')).status, 'completed')
    assert.equal((await reservation('settlement')).used_seconds, 60); assert.equal(await used(true), 60)
    assert.equal((await complete('settlement', 0)).status, 204)
    await webhook(signed({ event: 'call_started', call: { call_id: 'settlement', agent_id: 'agent_test', call_status: 'ongoing' } }))
    assert.equal((await reservation('settlement')).used_seconds, 60); assert.equal(await used(true), 60)
    await assertNoPause()
  } finally { await close() }
})

test('missing webhooks retain a conservative commitment until dashboard repair proves completion', async () => {
  await setup(3)
  try {
    await admit('missing_webhook')
    await db.exec("update call_minute_reservations set created_at=now()-interval '4 hours',status='expired'")
    assert.equal(await used(true), 180); assert.equal((await admit('blocked')).reject, true)
    const call = { call_id: 'missing_webhook', agent_id: 'agent_test', call_status: 'ended', start_timestamp: Date.now(), duration_ms: 60000 }
    globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/v3/list-calls') ? { items: [call] } : call), { status: 200 })
    const response = await refresh(new Request('https://synthetic.test', { headers: { authorization: 'Bearer synthetic' } }))
    assert.equal(response.status, 200)
    assert.equal((await reservation('missing_webhook')).status, 'completed'); assert.equal(await used(true), 60)
    assert.equal((await admit('recovered')).agent_override.agent.max_call_duration_ms, 120000)
    await assertNoPause()
  } finally { await close() }
})

test('paid subscription, capped rollover and paid-period end are authoritative; caller-supplied limits are retired', async () => {
  await setup(1, 999999)
  try {
    assert.equal((await admit('rollover')).agent_override.agent.max_call_duration_ms, 120000)
    await db.exec('delete from call_minute_reservations')
    assert.equal((await db.query('select * from reserve_recepta_call($1,999999,now())', [client])).rows.length, 0)
    for (const status of ['past_due', 'cancelled', 'inactive']) {
      await db.query('update subscriptions set status=$1', [status])
      assert.equal((await admit(status)).reject, true)
    }
    await db.exec("update subscriptions set status='active',current_period_start=now()+interval '1 day',current_period_end=now()+interval '2 days'")
    assert.equal((await admit('future')).reject, true)
    await db.exec("update subscriptions set current_period_start=now()-interval '1 day',current_period_end=now()-interval '1 second'")
    assert.equal((await admit('expired')).reject, true)
    await db.exec("update subscriptions set current_period_end=now()+interval '45 seconds'")
    assert.equal((await admit('short_period')).reject, true)
    await db.exec("update subscriptions set current_period_end=now()+interval '100 seconds'")
    const short = await admit('period_limit')
    assert.ok(short.agent_override.agent.max_call_duration_ms >= 60000 && short.agent_override.agent.max_call_duration_ms <= 100000)
    await assertNoPause()
  } finally { await close() }
})

test('renewal accounts for unfinished calls and late completion stays in its funded billing cycle', async () => {
  await setup(5)
  try {
    const old = (await db.query('select * from subscriptions')).rows[0]
    await admit('spanning_renewal')
    const nextEnd = new Date(old.current_period_end.getTime() + 30 * 86400000)
    const renewed = (await db.query("select * from renew_recepta_subscription('sub_synthetic',$1,$2)", [old.current_period_end, nextEnd])).rows[0]
    assert.equal(renewed.rollover_seconds, 120, 'reserved old-cycle time cannot be granted again as rollover')
    await complete('spanning_renewal', 60, { start_timestamp: old.current_period_end.getTime() + 1000 })
    assert.equal(await used(false, old.current_period_start, old.current_period_end), 60)
    assert.equal(await used(false), 0, 'late starts/events do not debit the new cycle for a previously funded call')
    assert.equal((await admit('spanning_renewal')).reject, true)
    const replay = (await db.query("select * from renew_recepta_subscription('sub_synthetic',$1,$2)", [old.current_period_end, nextEnd])).rows[0]
    assert.equal(replay.rollover_seconds, 120)
  } finally { await close() }
})

test('replacement Checkout also deducts outstanding commitments from rollover', async () => {
  await setup(5)
  try {
    await admit('spanning_checkout')
    const newStart = new Date(), newEnd = new Date(Date.now() + 30 * 86400000)
    const replaced = (await db.query(`select * from activate_recepta_checkout($1,'sub_replacement','cus_synthetic',$2,$3,
      '{"monthly_minutes":5}','sub_synthetic')`, [client, newStart, newEnd])).rows[0]
    assert.equal(replaced.rollover_seconds, 120)
    assert.equal((await admit('spanning_checkout')).reject, true)
    assert.equal((await db.query('select demo_mode from agents')).rows[0].demo_mode, false)
    assert.equal((await admit('new_cycle')).agent_override.agent.max_call_duration_ms, 420000)
    await complete('spanning_checkout', 60)
    assert.equal(await used(), 0)
    await db.exec('update agents set demo_mode=true')
    await db.query(`select * from activate_recepta_checkout($1,'sub_replacement','cus_synthetic',$2,$3,
      '{"monthly_minutes":5}','sub_synthetic')`, [client, newStart, newEnd])
    assert.equal((await db.query('select demo_mode from agents')).rows[0].demo_mode, true, 'payment replay does not overwrite a later admin demo choice')
  } finally { await close() }
})

test('missing identity, paused agents, database failures and invalid RPC caps reject without a service pause', async () => {
  await setup()
  try {
    assert.equal((await inbound(new Request('https://synthetic.test', { method: 'POST', body: '{}' }))).status, 401)
    assert.equal((await admit(undefined)).reject, true)
    await db.exec("update agents set status='paused'")
    assert.equal((await admit('paused')).reject, true)
    await db.exec("update agents set status='active'")
    rpcFailure = true; assert.equal((await admit('db_failure')).reject, true); rpcFailure = false
    for (const seconds of [0,59,180.5,7200]) {
      rpcResult = [{ reservation_id: 'synthetic-id', reserved_seconds: seconds, demo_mode: true }]
      assert.equal((await admit('invalid_' + seconds)).reject, true)
    }
    rpcResult = undefined
    assert.equal((await db.query('select count(*)::int as n from call_minute_reservations')).rows[0].n, 0)
    await assertNoPause()
  } finally { await close() }
})

test('private accounting denies customer access, prevents cross-client replay and supports the service role', async () => {
  await setup()
  try {
    await admit('private_call')
    await db.exec(`insert into subscriptions(client_id,status,monthly_minutes,stripe_subscription_id,current_period_start,current_period_end)
      values('${otherClient}','active',5,'sub_other',now()-interval '1 day',now()+interval '29 days')`)
    await db.exec(`insert into agents(client_id,retell_agent_id,status,demo_mode) values('${otherClient}','other_agent','live',false)`)
    await assert.rejects(db.query('select * from reserve_recepta_agent_call($1,$2,$3)', [otherClient,'private_call','other_agent']), /belongs to another client/)
    for (const role of ['anon','authenticated']) {
      await db.exec('set role ' + role)
      for (const sql of ["select * from reserve_recepta_agent_call($1,'denied','agent_test')", "select recepta_committed_usage($1,now()-interval '1 day',now()+interval '1 day')", 'select * from call_minute_reservations where client_id=$1']) {
        await assert.rejects(db.query(sql, [client]), /permission denied/)
      }
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'service_call','agent_test')", [client])).rows[0].reserved_seconds, 120)
  } finally { await close() }
})

test('phone provisioning and sync require the admission webhook and remove the provider fallback agent', async () => {
  const savedOrigin = process.env.RECEPTA_APP_URL
  try {
    process.env.RECEPTA_APP_URL = 'https://synthetic.test'
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : null })
      return new Response(JSON.stringify({ phone_number: '+14165550100' }), { status: 200 })
    }
    await syncPhone({ apiKey: 'synthetic-only', agentId: 'agent_test', phoneNumber: '+14165550100', active: true })
    await purchasePhone({ apiKey: 'synthetic-only', agentId: 'agent_test', countryCode: 'CA', nickname: 'Synthetic only' })
    const bodies = requests.filter((request) => request.body).map((request) => request.body)
    assert.equal(bodies.length, 2)
    for (const body of bodies) {
      assert.equal(body.inbound_agents, null)
      assert.equal(body.inbound_webhook_url, 'https://synthetic.test/.netlify/functions/retell-inbound')
      assert.equal(body.outbound_agents[0].agent_id, 'agent_test')
    }
  } finally {
    globalThis.fetch = originalFetch
    if (savedOrigin === undefined) delete process.env.RECEPTA_APP_URL; else process.env.RECEPTA_APP_URL = savedOrigin
  }
})

test('regular live customer calls go beyond three minutes and remain bounded by paid time and the provider maximum', async () => {
  await setup(200, 0, false)
  try {
    await db.exec("update agents set status='live'")
    const response = await admit('long_customer')
    assert.equal(response.agent_override.agent.max_call_duration_ms, CALL_MAX_SECONDS * 1000)
    const row = await reservation('long_customer')
    assert.equal(row.demo_mode, false); assert.equal(row.retell_agent_id, 'agent_test')
    assert.equal(row.reserved_seconds, 7200)
    assert.equal((await complete('long_customer', 600)).status, 204)
    assert.equal(await used(true), 600)
    assert.equal((await reservation('long_customer')).used_seconds, 600)
    await assertNoPause()
    await db.exec('delete from calls; delete from call_minute_reservations; update subscriptions set monthly_minutes=15')
    assert.equal((await admit('fifteen_minutes')).agent_override.agent.max_call_duration_ms, 900000)
    assert.equal((await admit('no_more_paid_time')).reject, true)
  } finally { await close() }
})

test('demo mode is authoritative per agent and cannot be selected through caller metadata', async () => {
  await setup(20, 0, true)
  try {
    const demo = await admit('actual_demo')
    assert.equal(demo.agent_override.agent.max_call_duration_ms, DEMO_CALL_MAX_SECONDS * 1000)
    assert.equal((await reservation('actual_demo')).demo_mode, true)
    const escapeAttempt = await inbound(signed({ event: 'call_inbound', call_inbound: {
      call_id: 'actual_demo', to_number: '+14165550100', agent_id: 'agent_test', demo_mode: false,
    } }))
    assert.equal((await escapeAttempt.json()).call_inbound.agent_override.agent.max_call_duration_ms, 180000)

    await db.exec('update agents set demo_mode=false')
    // An already approved demo retry keeps its original policy and identity.
    assert.equal((await admit('actual_demo')).metadata.recepta_reservation_id, demo.metadata.recepta_reservation_id)
    assert.equal((await admit('actual_demo')).agent_override.agent.max_call_duration_ms, 180000)
    const spoofed = await inbound(signed({ event: 'call_inbound', call_inbound: {
      call_id: 'spoofed_demo_flag', to_number: '+14165550100', agent_id: 'agent_test', demo_mode: true,
    } }))
    assert.equal((await spoofed.json()).call_inbound.agent_override.agent.max_call_duration_ms, 1020000)
    assert.equal((await reservation('spoofed_demo_flag')).demo_mode, false)
    assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'wrong_agent','not_assigned')", [client])).rows.length, 0)
    assert.equal((await db.query("select * from reserve_recepta_inbound_call($1,'old_api')", [client])).rows.length, 0)
  } finally { await close() }
})

test('Retell publishes a three-minute limit only for demo agents and clears it for normal customer agents', async () => {
  try {
    const updates = []
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname
      if (path.includes('/list-agent-versions/')) return new Response(JSON.stringify({ items: [{ version: 1 }] }))
      if (path.includes('/create-agent-version/')) return new Response(JSON.stringify({ version: 2 }))
      if (path.includes('/update-agent/')) {
        updates.push(JSON.parse(options.body)); return new Response(JSON.stringify({ version: 2 }))
      }
      assert.ok(path.includes('/publish-agent-version/'))
      return new Response('{}')
    }
    for (const demoMode of [true, false, undefined]) {
      await syncSubscription({ apiKey: 'synthetic-only', agentId: 'agent_test', active: true,
        piiRedactionEnabled: false, safetyGuardrailsEnabled: false, demoMode })
    }
    assert.deepEqual(updates.map((update) => update.max_call_duration_ms), [180000,7200000,7200000])
  } finally { globalThis.fetch = originalFetch }
})

test('customer requests cannot change demo mode through the admin create, edit or agent endpoints', async () => {
  await setup()
  try {
    for (const handler of [adminCreate,adminUpdate,adminAgent]) {
      const response = await handler(new Request('https://synthetic.test', { method: 'POST',
        headers: { authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: client, demoMode: false, retellAgentId: 'agent_test' }) }))
      assert.equal(response.status, 403, await response.text())
    }
    assert.equal((await db.query('select demo_mode from agents')).rows[0].demo_mode, true)
  } finally { await close() }
})
