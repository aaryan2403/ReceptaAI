import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

// Actual signed handlers and PostgreSQL triggers; no production calls or emails.
const client = '00000000-0000-0000-0000-000000000001'
const otherClient = '00000000-0000-0000-0000-000000000002'
const start = Date.parse('2026-10-14T12:00:00Z')
let db, failCallWrite
const originalFetch = globalThis.fetch
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"'
const query = (table) => {
  let values, single = false, update = false
  const filters = []
  const execute = async () => {
    try {
      if (values && !update) {
        if (table === 'calls' && failCallWrite) {
          failCallWrite = false
          throw new Error('Synthetic call storage failure')
        }
        const records = Array.isArray(values) ? values : [values]
        const keys = Object.keys(records[0])
        const params = []
        const tuples = records.map((record) => '(' + keys.map((key) => {
          params.push(record[key]); return '$' + params.length
        }).join(',') + ')')
        const result = await db.query(`insert into ${identifier(table)} (${keys.map(identifier).join(',')})
          values ${tuples.join(',')} on conflict(retell_call_id) do update set
          ${keys.map((key) => `${identifier(key)}=excluded.${identifier(key)}`).join(',')} returning *`, params)
        return { data: single ? result.rows[0] ?? null : result.rows, error: null }
      }
      if (update) {
        const keys = Object.keys(values)
        const params = keys.map((key) => values[key])
        const where = filters.map(([, col, value]) => {
          params.push(value); return `${identifier(col)}=$${params.length}`
        }).join(' and ')
        await db.query(`update ${identifier(table)} set ${keys.map((key, i) => `${identifier(key)}=$${i + 1}`).join(',')} where ${where}`, params)
        return { data: null, error: null }
      }
      let rows = (await db.query(`select * from ${identifier(table)}`)).rows
      for (const [op, col, value] of filters) rows = rows.filter((row) => op === 'in' ? value.includes(row[col]) : row[col] === value)
      return { data: single ? rows[0] ?? null : rows, error: null }
    } catch (error) { return { data: null, error: { message: error.message } } }
  }
  const api = { select: () => api, order: () => api, limit: () => api,
    eq: (col, value) => { filters.push(['eq', col, value]); return api },
    in: (col, value) => { filters.push(['in', col, value]); return api },
    upsert: (value) => { values = value; return api },
    update: (value) => { values = value; update = true; return api },
    maybeSingle: () => { single = true; return execute() },
    then: (resolve, reject) => execute().then(resolve, reject) }
  return api
}
globalThis.__callLifecycleDb = {
  from: query,
  auth: { getUser: async () => ({ data: { user: { id: client } }, error: null }) },
}
const compile = async (path) => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'synthetic-db', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.__callLifecycleDb', loader: 'js' }))
    } }] })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}
const webhook = await compile('netlify/functions/retell-webhook.ts')
const refresh = await compile('netlify/functions/client-calls.ts')
process.env.SUPABASE_URL = 'https://synthetic.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
process.env.RETELL_API_KEY = 'synthetic-only'
const migration = await readFile('supabase/migrations/20261014174126_protect_call_lifecycle.sql', 'utf8')
const setup = async (legacy = false) => {
  db = new PGlite(); failCallWrite = false
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table clients(id uuid primary key);
    create table subscriptions(client_id uuid,plan_name text,status text,current_period_start timestamptz,
      monthly_minutes integer,pii_redaction_enabled boolean default false);
    create table agents(client_id uuid,retell_agent_id text,phone_number text,business_hours text);
    create table appointments(client_id uuid,retell_call_id text,status text,appointment_time timestamptz);
    create table call_minute_reservations(id uuid,client_id uuid,status text,used_seconds integer,completed_at timestamptz);
    create table calls(id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id),
      retell_call_id text unique,caller_name text,caller_number text,started_at timestamptz not null default now(),
      duration_seconds integer not null default 0,call_status text,outcome text,disconnection_reason text,
      transcript text,recording_url text,summary text,user_sentiment text,call_successful boolean,
      appointment_booked boolean not null default false,retell_agent_id text,ended_at timestamptz,
      updated_at timestamptz not null default now());
    insert into clients values('${client}'),('${otherClient}');
    insert into subscriptions(client_id,plan_name,status) values('${client}','Recepta Pro','cancelled');
    insert into agents values('${client}','agent_test',null,null);`)
  if (legacy) await db.exec(`insert into calls(client_id,retell_call_id,call_status,summary,duration_seconds)
    values('${client}','legacy','ongoing','Historical analysis',60)`)
  await db.exec(await readFile('supabase/migrations/20261014064906_call_notification_outbox.sql', 'utf8'))
  await db.exec(migration)
}
const close = async () => { await db.close(); globalThis.fetch = originalFetch }
const signed = (event, call) => {
  const body = JSON.stringify({ event, call })
  const timestamp = Date.now()
  const digest = createHmac('sha256', process.env.RETELL_API_KEY).update(`${body}${timestamp}`).digest('hex')
  return new Request('https://synthetic.test', { method: 'POST', headers: { 'x-retell-signature': `v=${timestamp},d=${digest}` }, body })
}
const base = (id = 'call_test') => ({ call_id: id, agent_id: 'agent_test', start_timestamp: start })
const ended = (id) => ({ ...base(id), call_status: 'ended', end_timestamp: start + 60000, duration_ms: 60000,
  from_number: '+14165550100', retell_llm_dynamic_variables: { customer_name: 'Synthetic caller' },
  disconnection_reason: 'user_hangup', transcript: 'Final transcript', recording_url: 'https://synthetic.test/recording' })
const analyzed = (id) => ({ ...ended(id), call_analysis: { call_summary: 'Final analysis', call_successful: false, user_sentiment: 'Neutral' } })
const callRow = async (id = 'call_test') => (await db.query('select * from calls where retell_call_id=$1', [id])).rows[0]
const dashboardRequest = () => new Request('https://synthetic.test', { headers: { authorization: 'Bearer synthetic' } })
const assertFinished = (row) => {
  assert.equal(row.call_status, 'ended'); assert.equal(row.lifecycle_rank, 3)
  assert.equal(row.duration_seconds, 60); assert.equal(row.summary, 'Final analysis')
  assert.equal(row.call_successful, false); assert.equal(row.outcome, 'Unsuccessful')
  assert.equal(row.user_sentiment, 'Neutral'); assert.equal(row.transcript, 'Final transcript')
  assert.equal(row.caller_name, 'Synthetic caller')
  assert.equal(new Date(row.started_at).getTime(), start)
  assert.equal(new Date(row.ended_at).getTime(), start + 60000)
}

test('all six event orders and sparse replays preserve terminal state and final data', async () => {
  await setup()
  try {
    const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]
    for (const [index, order] of orders.entries()) {
      const id = 'permutation_' + index
      if (index === 0) await db.query("insert into appointments values($1,$2,'booked','2026-10-15T12:00:00Z')", [client, id])
      const events = [['call_started', { ...base(id), call_status: 'ongoing' }], ['call_ended', ended(id)], ['call_analyzed', analyzed(id)]]
      for (const i of order) assert.equal((await webhook(signed(...events[i]))).status, 204)
      assertFinished(await callRow(id))
      assert.equal((await callRow(id)).appointment_booked, index === 0)
      assert.equal((await webhook(signed('call_analyzed', { call_id: id, agent_id: 'agent_test' }))).status, 204)
      assert.equal((await webhook(signed('call_ended', { ...base(id), transcript: 'Earlier terminal snapshot' }))).status, 204)
      assert.equal((await webhook(signed('call_started', { call_id: id, agent_id: 'agent_test', call_status: 'registered' }))).status, 204)
      assertFinished(await callRow(id))
      assert.equal((await callRow(id)).appointment_booked, index === 0)
    }
    assert.equal((await db.query('select count(*)::int as n from calls')).rows[0].n, 6)
  } finally { await close() }
})

test('overlapping signed webhook requests converge; reservation replays keep saved duration', async () => {
  await setup()
  try {
    const reservation = '00000000-0000-0000-0000-000000000003'
    await db.exec(`insert into call_minute_reservations values('${reservation}','${client}','reserved',0,null)`)
    assert.deepEqual((await Promise.all([
      webhook(signed('call_analyzed', analyzed())),
      webhook(signed('call_started', { ...base(), call_status: 'ongoing' })),
      webhook(signed('call_ended', ended())),
    ])).map((response) => response.status), [204,204,204])
    assertFinished(await callRow())
    await webhook(signed('call_ended', { ...base(), metadata: { recepta_reservation_id: reservation } }))
    assert.equal((await db.query('select used_seconds from call_minute_reservations')).rows[0].used_seconds, 60)
  } finally { await close() }
})

test('dashboard refresh returns the merged row when a webhook completes after its initial read', async () => {
  await setup()
  try {
    await webhook(signed('call_started', { ...base(), call_status: 'ongoing' }))
    let release, announce
    const ready = new Promise((resolve) => { announce = resolve })
    const blocked = new Promise((resolve) => { release = resolve })
    globalThis.fetch = async (url) => {
      assert.ok(String(url).includes('/v3/list-calls'))
      announce(); await blocked
      return new Response(JSON.stringify({ items: [{ ...base(), call_status: 'ongoing' }] }), { status: 200 })
    }
    const pending = refresh(dashboardRequest())
    await ready
    await webhook(signed('call_analyzed', analyzed()))
    release()
    const response = await pending; assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.activeCalls, 0); assert.equal(body.calls[0].call_status, 'ended')
    assert.equal(body.calls[0].duration_seconds, 60); assert.equal(body.calls[0].outcome, 'Unsuccessful')
    assert.equal(body.calls[0].summary, 'Final analysis'); assert.equal(body.calls[0].transcript, 'Final transcript')
    assertFinished(await callRow())
    failCallWrite = true
    const failedRepair = await (await refresh(dashboardRequest())).json()
    assert.equal(failedRepair.activeCalls, 0); assert.equal(failedRepair.calls[0].call_status, 'ended')
    assert.match(failedRepair.storageWarning, /Showing saved call records/)
  } finally { await close() }
})

test('error and not-connected calls cannot reopen; registered calls cannot replace connected calls', async () => {
  await setup()
  try {
    for (const status of ['error', 'not_connected']) {
      await webhook(signed('call_ended', { ...base(status), call_status: status, disconnection_reason: 'dial_failed' }))
      await webhook(signed('call_started', { ...base(status), call_status: 'ongoing' }))
      await webhook(signed('call_analyzed', { ...base(status), call_status: status }))
      assert.equal((await callRow(status)).call_status, status)
    }
    await webhook(signed('call_started', { ...base('connected'), call_status: 'ongoing' }))
    await webhook(signed('call_started', { ...base('connected'), call_status: 'registered' }))
    assert.equal((await callRow('connected')).call_status, 'ongoing')
  } finally { await close() }
})

test('redaction drops raw media, keeps scrubbed media on sparse events and rejects later raw snapshots', async () => {
  await setup()
  try {
    await webhook(signed('call_analyzed', analyzed()))
    await db.exec('update subscriptions set pii_redaction_enabled=true')
    failCallWrite = true
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ ...base(), call_status: 'ongoing' }] }), { status: 200 })
    const failedRepair = await (await refresh(dashboardRequest())).json()
    assert.equal(failedRepair.calls[0].transcript, null); assert.equal(failedRepair.calls[0].recording_url, null)
    await webhook(signed('call_started', { ...base(), call_status: 'ongoing' }))
    let row = await callRow()
    assert.equal(row.transcript, null); assert.equal(row.recording_url, null); assert.equal(row.media_redacted, true)
    assert.equal(row.summary, 'Final analysis'); assert.equal(row.duration_seconds, 60)
    await webhook(signed('call_analyzed', { ...analyzed(), scrubbed_transcript: 'Scrubbed transcript', scrubbed_recording_url: 'https://synthetic.test/scrubbed' }))
    await webhook(signed('call_analyzed', base()))
    await db.exec('update subscriptions set pii_redaction_enabled=false')
    await webhook(signed('call_analyzed', analyzed()))
    row = await callRow()
    assert.equal(row.transcript, 'Scrubbed transcript'); assert.equal(row.recording_url, 'https://synthetic.test/scrubbed')
    assert.equal(row.media_redacted, true)
  } finally { await close() }
})

test('migration protects historical calls, older writers and tenant identity while retaining one notification', async () => {
  await setup(true)
  try {
    assert.equal((await callRow('legacy')).lifecycle_rank, 3)
    assert.equal((await callRow('legacy')).call_status, 'ended')
    // Omitting the new columns cannot bypass the guard during deployment overlap.
    await db.exec("update calls set call_status='ongoing',outcome='In progress',duration_seconds=0 where retell_call_id='legacy'")
    assert.equal((await callRow('legacy')).call_status, 'ended')
    assert.equal((await callRow('legacy')).duration_seconds, 60)
    await assert.rejects(db.exec(`update calls set client_id='${otherClient}' where retell_call_id='legacy'`), /cannot be reassigned/)
    await assert.rejects(db.exec("update calls set retell_call_id=null where retell_call_id='legacy'"), /cannot be reassigned/)
    await db.exec("update subscriptions set status='active'")
    await db.exec(`insert into calls(client_id,retell_call_id,call_status,lifecycle_rank,owner_notification_requested)
      values('${client}','notice','ended',2,true)`)
    await db.exec("update calls set call_status='ongoing',lifecycle_rank=1,owner_notification_requested=false where retell_call_id='notice'")
    assert.equal((await callRow('notice')).owner_notification_requested, true)
    assert.equal((await db.query("select count(*)::int as n from call_notifications where retell_call_id='notice'")).rows[0].n, 1)
    const privileges = (await db.query(`select has_function_privilege('anon','public.protect_recepta_call_lifecycle()','execute') as anon,
      has_function_privilege('authenticated','public.protect_recepta_call_lifecycle()','execute') as customer,
      has_function_privilege('service_role','public.protect_recepta_call_lifecycle()','execute') as server`)).rows[0]
    assert.deepEqual(privileges, { anon: false, customer: false, server: true })
  } finally { await close() }
})
