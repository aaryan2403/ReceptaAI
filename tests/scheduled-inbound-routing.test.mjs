import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

const client = '00000000-0000-0000-0000-000000000001'
const secondClient = '00000000-0000-0000-0000-000000000002'
const primary = '+14165550100'
const extra = '+14165550101'
const human = '+14165550102'
const source = '+14165550103'
const origin = 'https://deploy-preview-45--receptaai.netlify.app'
const webhook = origin + '/.netlify/functions/retell-inbound'
const key = 'synthetic-staging-key'
const deployment = { isolated: true, preview: true, previewOrigin: origin, key }
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hours = (day = 'Sunday', start = '01:00', end = '02:00', answeringMode = 'business_hours') => JSON.stringify({
  mode: 'custom', answeringMode, timeZone: 'America/Toronto',
  hours: weekdays.map(name => ({ day: name, open: name === day, start, end })),
})
const managed = (number, type = 'retell-twilio', url = webhook) => ({
  phone_number: number, phone_number_type: type, inbound_webhook_url: url,
  inbound_agents: null, inbound_fallback_enabled: false, fallback_number: null,
})

let sql, phones, writes, failPatch, loseResponse, queries
const execute = async (statement, values) => {
  try {
    const result = await sql.query(statement, values)
    return { data: result.rows[0]?.value ?? null, error: null }
  } catch (error) {
    return { data: null, error }
  }
}
const db = {
  rpc(name, args) {
    queries.push(name)
    const query = () => execute(`select ${name}(${Object.keys(args).map((param, i) => `${param} => $${i + 1}`).join(',')}) as value`, Object.values(args))
    return { abortSignal: query, then: (resolve, reject) => query().then(resolve, reject) }
  },
  from(table) {
    if (table === 'phone_transfer_destinations') {
      let clientId
      const check = {
        select: () => check,
        eq(column, value) {
          if (column === 'client_id') clientId = value
          return check
        },
        maybeSingle: () => execute(
          'select to_jsonb(d) as value from phone_transfer_destinations d where client_id = $1 and is_primary and enabled', [clientId]
        ),
      }
      return check
    }
    assert.equal(table, 'retell_forwarding_lock')
    return { delete: () => ({ eq: (column, token) => ({
      abortSignal: () => execute('delete from retell_forwarding_lock where token = $1', [token]),
    }) }) }
  },
}
globalThis.__forwardingDb = db

const compile = async(path, exportName = 'default') => {
  const bundled = await build({
    entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'test-db', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.__forwardingDb' }))
    } }],
  })
  return (await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')))[exportName]
}
const reconcile = await compile('netlify/lib/retellForwarding.ts', 'reconcileRetellForwarding')
const refresh = await compile('netlify/lib/retellForwarding.ts', 'refreshClientRetellForwarding')
const scheduled = await compile('netlify/functions/retell-forwarding-schedule.ts')
const webhookHandler = await compile('netlify/functions/retell-webhook.ts')

test.before(async () => {
  sql = new PGlite()
  await sql.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table clients(id uuid primary key, deletion_pending boolean default false);
    create table agents(client_id uuid primary key, phone_number text, retell_agent_id text, business_hours text);
    create table agent_phone_numbers(client_id uuid, phone_number text);
    create table access_test(client_id uuid primary key, value jsonb);
    create function recepta_service_access(p_client uuid) returns jsonb language sql as
    $$ select value from access_test where client_id = p_client $$;
  `)
  await sql.exec(await readFile('supabase/migrations/20261126044141_retell_native_forwarding.sql', 'utf8'))
})
test.after(async () => { await sql.close() })

test.beforeEach(async context => {
  await sql.exec('truncate clients, agents, agent_phone_numbers, access_test, retell_forwarding_lock cascade')
  await sql.query('insert into clients(id) values ($1),($2)', [client, secondClient])
  await sql.query('insert into agents values ($1,$2,$3,$4)', [client, primary, 'agent_test', hours()])
  await sql.query('insert into phone_transfer_destinations(client_id, phone_number, enabled) values ($1,$2,true)', [client, human])
  await sql.query('insert into access_test values ($1,$2)', [client, { status: 'active', can_reserve: true, remaining_seconds: 0 }])
  phones = new Map([[primary, managed(primary)]])
  writes = []
  queries = []
  failPatch = false
  loseResponse = false
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T07:00:00Z') })
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + key)
    const request = new URL(url)
    assert.equal(request.origin, 'https://api.retellai.com')
    if (request.pathname === '/v2/list-phone-numbers') {
      assert.equal(options.method, 'POST')
      const rows = [...phones.values()]
      return Response.json(request.searchParams.has('pagination_key')
        ? { items: rows.slice(1), has_more: false }
        : { items: rows.slice(0, 1), has_more: rows.length > 1, pagination_key: 'second' })
    }
    const number = decodeURIComponent(request.pathname.split('/').at(-1))
    assert.ok(phones.has(number))
    if (options.method === 'PATCH') {
      const patch = JSON.parse(options.body)
      writes.push({ number, patch })
      if (failPatch) return Response.json({}, { status: 503 })
      Object.assign(phones.get(number), patch)
      if (loseResponse) throw new Error('Connection closed after update')
    } else {
      assert.ok(request.pathname.startsWith('/get-phone-number/'))
    }
    return Response.json(phones.get(number))
  })
})

test('the scheduled handler switches existing and newly assigned Retell numbers without reserving AI time', async context => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://mvufjeqxqvpcfqwmihpy.supabase.co', SUPABASE_SECRET_KEY: 'test-only', RETELL_STAGING_API_KEY: key,
  })
  const run = () => scheduled(new Request(origin + '/.netlify/functions/retell-forwarding-schedule'))
  assert.equal((await run()).status, 204)
  assert.deepEqual(writes, [{ number: primary, patch: { fallback_number: human, inbound_fallback_enabled: true } }])
  assert.ok(!queries.includes('reserve_recepta_agent_call'))

  await sql.query('insert into agent_phone_numbers values ($1,$2)', [client, extra])
  phones.set(extra, managed(extra, 'retell-bandwidth'))
  phones.set(source, managed(source, 'custom'))
  phones.set('+14165550104', managed('+14165550104', 'retell-telnyx', 'https://another.test/retell-inbound'))
  await run()
  assert.deepEqual(writes.map(write => write.number), [primary, extra])
  await run()
  assert.equal(writes.length, 2)

  // Both 1 a.m. occurrences on fall-back day count as AI hours.
  for (const time of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    context.mock.timers.setTime(Date.parse(time))
    await run()
    assert.equal(phones.get(primary).fallback_number, null)
    assert.equal(phones.get(extra).inbound_fallback_enabled, false)
  }
  await sql.query('update agents set business_hours = $1', [hours('Sunday', '01:00', '02:00', '24/7')])
  context.mock.timers.setTime(Date.parse('2026-11-01T07:00:00Z'))
  await run()
  assert.deepEqual(writes.slice(-2).map(write => write.patch), [
    { fallback_number: null, inbound_fallback_enabled: false },
    { fallback_number: null, inbound_fallback_enabled: false },
  ])
})

test('overnight hours span the spring-forward change and switch at the saved close', async context => {
  await sql.query('update agents set business_hours = $1', [hours('Saturday', '22:00', '03:30')])
  context.mock.timers.setTime(Date.parse('2026-03-08T07:29:00Z'))
  await reconcile(db, deployment)
  assert.equal(writes.length, 0)
  context.mock.timers.setTime(Date.parse('2026-03-08T07:30:00Z'))
  await reconcile(db, deployment)
  assert.equal(phones.get(primary).inbound_fallback_enabled, true)
})

test('payment holds and registered forwarding loops clear any stale provider forwarding', async () => {
  await reconcile(db, deployment)
  await sql.query('update access_test set value = $1', [{ status: 'paused', can_reserve: false }])
  await refresh(db, deployment, client)
  assert.equal(phones.get(primary).fallback_number, null)

  await sql.query('update access_test set value = $1', [{ status: 'active', can_reserve: true }])
  await reconcile(db, deployment)
  assert.equal(phones.get(primary).fallback_number, human)
  await sql.query('insert into phone_forwarding_sources values ($1,$2)', [human, secondClient])
  const result = await reconcile(db, deployment)
  assert.equal(result.unsafe, 1)
  assert.equal(phones.get(primary).fallback_number, null)
})

test('retries a rejected update and verifies a lost successful response without a duplicate PATCH', async () => {
  failPatch = true
  assert.equal((await reconcile(db, deployment)).pending, 1)
  assert.equal(phones.get(primary).inbound_fallback_enabled, false)
  failPatch = false
  loseResponse = true
  const result = await reconcile(db, deployment)
  assert.equal(result.pending, 0)
  assert.equal(result.updated, 1)
  await reconcile(db, deployment)
  assert.equal(writes.length, 2)
})

test('serializes reconciliation and refuses to edit an agent with a static inbound binding', async () => {
  const first = await sql.query("select recepta_claim_retell_forwarding('00000000-0000-0000-0000-000000000003') as claimed")
  assert.equal(first.rows[0].claimed, true)
  assert.equal((await reconcile(db, deployment)).pending, 1)
  assert.equal(writes.length, 0)
  await sql.exec('truncate retell_forwarding_lock')
  phones.get(primary).inbound_agents = [{agent_id: 'agent_test'}]
  assert.equal((await reconcile(db, deployment)).unsafe, 1)
  assert.equal(writes.length, 0)
})

test('a failed loop check leaves the saved hours and human number intact', async () => {
  await assert.rejects(sql.query('select recepta_save_retell_forwarding_schedule($1,$2,$3,true,$4,$4)',
    [client, hours(), '24/7', source]), /direct human number/)
  assert.equal((await sql.query('select business_hours from agents')).rows[0].business_hours, hours())
  assert.equal((await sql.query('select phone_number from phone_transfer_destinations')).rows[0].phone_number, human)
  const old = await sql.query('select recepta_save_retell_forwarding_schedule($1,$2,$3,false,null,null) as saved', [client, 'old hours', '24/7'])
  assert.equal(old.rows[0].saved, false)
})

test('a signed Retell fallback-only event does not enter Recepta accounting', async () => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://synthetic.test', SUPABASE_SECRET_KEY: 'test-only', RETELL_API_KEY: 'fallback-event-key',
  })
  const body = JSON.stringify({
    event: 'call_ended',
    call: { call_id: 'call_fallback', agent_id: 'agent_test', call_status: 'ended', duration_ms: 90000, disconnection_reason: 'no_concurrency_fallback' },
  })
  const timestamp = Date.now().toString()
  const signature = createHmac('sha256', process.env.RETELL_API_KEY).update(body + timestamp).digest('hex')
  const response = await webhookHandler(new Request('https://recepta.ca/.netlify/functions/retell-webhook', {
    method: 'POST', headers: { 'x-retell-signature': `v=${timestamp},d=${signature}` }, body,
  }))
  assert.equal(response.status, 204)
  assert.deepEqual(queries, [])
})
