import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { isConfirmedAppointment, formatAppointmentPreference } from '../src/lib/appointmentRequests.ts'

const client = '00000000-0000-0000-0000-000000000001'
const otherClient = '00000000-0000-0000-0000-000000000002'
process.env.SUPABASE_URL = 'https://synthetic.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
process.env.RETELL_API_KEY = 'synthetic-only'
let db
let fixture
let savedCalls
let rpcCalls
const query = (table) => {
  let values
  let single = false
  const filters = []
  const execute = async () => {
    if (values) { savedCalls.push(values); return { data: values, error: null } }
    let rows = table === 'subscriptions' ? [{ plan_name: fixture.plan, status: 'cancelled' }]
      : table === 'agents' ? [{ client_id: client, retell_agent_id: 'agent_test', phone_number: null, business_hours: null }]
      : table === 'appointments' ? fixture.appointments ?? [] : []
    // Capture tests use an active Pro subscription; lifecycle tests avoid real notifications.
    if (table === 'subscriptions' && fixture.capture) rows[0].status = 'active'
    for (const [op, column, value] of filters) {
      if (op === 'in') rows = rows.filter((row) => value.includes(row[column]))
      if (op === 'eq' && column === 'retell_call_id') rows = rows.filter((row) => row[column] === value)
    }
    return { data: single ? rows[0] ?? null : rows, error: null }
  }
  const api = {
    select: () => api, order: () => api, limit: () => api,
    eq: (column, value) => { filters.push(['eq', column, value]); return api },
    in: (column, value) => { filters.push(['in', column, value]); return api },
    upsert: (value) => { values = value; return api },
    maybeSingle: () => { single = true; return execute() },
    then: (resolve, reject) => execute().then(resolve, reject),
  }
  return api
}
globalThis.__appointmentDb = {
  auth: {
    getUser: async () => ({ data: { user: { id: client } }, error: null }),
    admin: { getUserById: async () => ({ data: { user: { user_metadata: { appointment_custom_fields: ['Service type'] } } }, error: null }) },
  },
  from: query,
  rpc: async (name, args) => {
    rpcCalls++
    assert.equal(name, 'capture_recepta_appointment_request')
    try {
      const result = await db.query('select public.capture_recepta_appointment_request($1,$2,$3) as result', [args.p_client_id, args.p_call_id, JSON.stringify(args.p_details)])
      return { data: result.rows[0].result, error: null }
    } catch (error) { return { data: null, error: { message: error.message } } }
  },
}
const compile = async (path, exportName = 'default') => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'synthetic-database', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.__appointmentDb', loader: 'js' }))
    } }],
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`))[exportName]
}
const buildCallNotification = await compile('netlify/lib/callNotificationEmail.ts', 'buildCallNotification')
const capture = await compile('netlify/functions/retell-appointment.ts')
const lifecycle = await compile('netlify/functions/retell-webhook.ts')
const repair = await compile('netlify/functions/client-calls.ts')
const signed = (payload) => {
  const body = JSON.stringify(payload)
  const timestamp = Date.now()
  const signature = createHmac('sha256', process.env.RETELL_API_KEY).update(`${body}${timestamp}`).digest('hex')
  return new Request('https://synthetic.test', { method: 'POST', headers: { 'x-retell-signature': `v=${timestamp},d=${signature}` }, body })
}
const payload = (args = {}) => ({ name: 'recepta_save_appointment_details',
  call: { call_id: 'call_test', agent_id: 'agent_test', metadata: { recepta_client_id: client } },
  args: { customer_name: 'Test caller', appointment_details: [{ label: 'Service type', value: 'Repair' }], ...args },
})
const reset = () => { fixture = { plan: 'Recepta Pro', capture: true }; savedCalls = []; rpcCalls = 0 }

test('signed intake stores raw preferences as pending, has no slot, and deduplicates without downgrading confirmations', async () => {
  reset()
  db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.appointments (
        id uuid primary key default gen_random_uuid(), client_id uuid not null, retell_call_id text,
        customer_name text, customer_email text, customer_phone text, company_name text, service text, notes text,
        status text not null default 'booked' constraint appointments_status_check check(status in ('booked','cancelled','completed')),
        source text not null, appointment_time timestamptz, appointment_end_time timestamptz,
        duration_minutes integer not null default 30 check(duration_minutes between 5 and 480), employee_id uuid,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      ); create unique index appointments_retell_call_id_key on public.appointments(retell_call_id) where retell_call_id is not null;`)
    await db.exec(await readFile('supabase/migrations/20261014055537_appointment_request_intake.sql', 'utf8'))
    const request = payload({ preferred_date: 'Next Tuesday', preferred_time: 'After 2 pm', preferred_timezone: 'Toronto' })
    const first = await capture(signed(request)); assert.equal(first.status, 200)
    const response = await first.json(); assert.equal(response.status, 'pending')
    assert.match(response.instruction, /Do not claim a calendar time was reserved/)
    assert.equal((await capture(signed(request))).status, 200)
    let rows = (await db.query('select * from public.appointments')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0].requested_date, 'Next Tuesday')
    assert.equal(rows[0].requested_time, 'After 2 pm')
    assert.equal(rows[0].requested_timezone, 'Toronto')
    for (const field of ['appointment_time','appointment_end_time','duration_minutes','employee_id']) assert.equal(rows[0][field], null)
    await assert.rejects(db.exec("update public.appointments set appointment_time=now() where status='pending'"), /appointments_pending_has_no_slot/)
    await db.exec("update public.appointments set status='booked', appointment_time='2027-01-05T19:00:00Z', duration_minutes=60")
    assert.equal((await (await capture(signed(payload({ preferred_date: 'Changed on retry' })))).json()).status, 'booked')
    rows = (await db.query('select * from public.appointments')).rows
    assert.equal(rows[0].status, 'booked'); assert.equal(rows[0].requested_date, 'Next Tuesday')
    await db.exec("update public.appointments set status='cancelled'")
    assert.equal((await (await capture(signed(request))).json()).status, 'cancelled')
    const other = payload(); other.call.metadata.recepta_client_id = otherClient
    assert.equal((await capture(signed(other))).status, 500)
    const noPreference = payload(); noPreference.call.call_id = 'call_no_preference'
    assert.equal((await capture(signed(noPreference))).status, 200)
    const blank = (await db.query("select * from public.appointments where retell_call_id='call_no_preference'")).rows[0]
    assert.equal(blank.requested_date, null); assert.equal(blank.requested_time, null); assert.equal(blank.appointment_time, null)
    const parallel = payload(); parallel.call.call_id = 'call_parallel'
    assert.deepEqual((await Promise.all([capture(signed(parallel)), capture(signed(parallel))])).map((r) => r.status), [200,200])
    assert.equal((await db.query("select count(*)::int as count from public.appointments where retell_call_id='call_parallel'")).rows[0].count, 1)
    assert.equal((await db.query("select has_function_privilege('authenticated', 'public.capture_recepta_appointment_request(uuid,text,jsonb)', 'execute') as allowed")).rows[0].allowed, false)
  } finally { await db.close() }
})

test('intake rejects unsigned calls, missing call IDs, missing names and non-Pro access before writes', async () => {
  reset()
  assert.equal((await capture(new Request('https://synthetic.test', { method: 'POST', body: '{}' }))).status, 401)
  const noCall = payload(); delete noCall.call.call_id
  assert.equal((await capture(signed(noCall))).status, 400)
  assert.equal((await capture(signed(payload({ customer_name: '' })))).status, 400)
  fixture.plan = 'Recepta Standard'
  assert.equal((await capture(signed(payload()))).status, 403)
  assert.equal(rpcCalls, 0)
})

test('an AI booking claim cannot promote pending intake in lifecycle events or provider refresh', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const [status, time, expected] of [['pending', null, false], ['cancelled', '2027-01-05T19:00:00Z', false], ['booked', '2027-01-05T19:00:00Z', true], ['completed', '2027-01-05T19:00:00Z', true], ['booked', null, false]]) {
      reset(); fixture.capture = false
      fixture.appointments = [{ status, appointment_time: time, retell_call_id: 'call_test' }]
      const call = { call_id: 'call_test', agent_id: 'agent_test', call_status: 'ended', start_timestamp: Date.now(), duration_ms: 30000,
        call_analysis: { custom_analysis_data: { appointment_booked: true } } }
      assert.equal((await lifecycle(signed({ event: 'call_analyzed', call }))).status, 204)
      assert.equal(savedCalls[0].appointment_booked, expected)
      globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/v3/list-calls') ? { items: [call] } : call), { status: 200 })
      const result = await repair(new Request('https://synthetic.test', { headers: { authorization: 'Bearer synthetic' } }))
      assert.equal(result.status, 200)
      assert.equal((await result.json()).calls[0].appointment_booked, expected)
      assert.equal(savedCalls.at(-1)[0].appointment_booked, expected)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('owner email content labels a request as pending without fake start/end times', () => {
  const sent = buildCallNotification({ planName: 'Recepta Pro', businessName: 'Test business', ownerEmail: 'owner@example.test', startedAt: '2026-10-14T12:00:00Z', durationSeconds: 30, timeZone: 'America/Toronto', appointment: {
    status: 'pending', requestedDate: 'Friday', requestedTime: 'Afternoon', requestedTimezone: 'Toronto', start: '2026-10-14T12:00:00Z', durationMinutes: 30, timeZone: 'America/Toronto',
  } })
  assert.match(sent.text, /Pending — follow-up required/)
  assert.match(sent.text, /Friday · Afternoon · Toronto/)
  assert.doesNotMatch(sent.text, /Starts:|Ends:|Duration: 30 minutes/)
})

test('booking proof requires confirmed status and a valid slot; unknown preferences stay unknown', () => {
  assert.equal(isConfirmedAppointment({ status: 'pending', appointment_time: '2027-01-01T12:00:00Z' }), false)
  assert.equal(isConfirmedAppointment({ status: 'booked', appointment_time: null }), false)
  assert.equal(formatAppointmentPreference({}), 'Not provided')
})
