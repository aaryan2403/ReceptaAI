import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { calculateMonthlyPriceCad } from '../netlify/lib/pricing.ts'

// Real handlers and PostgreSQL limits, with synthetic provider and auth boundaries.
// No live voice calls, client changes, payments or emails are made here.
const token = 'a'.repeat(64)
const hash = value => createHash('sha256').update(value).digest('hex')
let db, userEmail, assigned, tools, published, providerFailure, providerCalls, selections
const reset = () => {
  userEmail = 'admin@example.test'; assigned = false; tools = []; published = true
  providerFailure = false; providerCalls = []; selections = []
}
const query = table => {
  let action = 'read', values, single = false, columns = '*'
  const filters = []
  const execute = async () => {
    selections.push({ table, columns })
    if (table === 'agents') return { data: assigned ? [{ client_id: 'customer' }] : [], error: null }
    if (table === 'ai_models') return { data: [{ id: 'model', display_name: 'Demo Model', tier_name: 'Essential', customer_price_per_minute_cad: '0.117' }], error: null }
    assert.equal(table, 'recepta_demo_links')
    try {
      let rows
      if (action === 'insert') {
        const keys = Object.keys(values)
        rows = (await db.query(`insert into recepta_demo_links (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, Object.values(values))).rows
      } else if (action === 'update') {
        rows = (await db.query('update recepta_demo_links set revoked = true where id = $1 returning *', [filters.find(([column]) => column === 'id')[1]])).rows
      } else {
        rows = (await db.query('select * from recepta_demo_links')).rows
        for (const [column, value] of filters) rows = rows.filter(row => row[column] === value)
      }
      const selected = columns === '*' ? rows : rows.map(row => Object.fromEntries(columns.split(',').map(key => [key.trim(), row[key.trim()]])))
      return { data: single ? selected[0] ?? null : selected, error: null }
    } catch (error) { return { data: null, error: { message: error.message } } }
  }
  const api = {
    select: value => { columns = value; return api }, order: () => api, limit: () => api,
    eq: (key, value) => { filters.push([key, value]); return api },
    insert: value => { action = 'insert'; values = value; return api },
    update: value => { action = 'update'; values = value; return api },
    single: () => { single = true; return execute() }, maybeSingle: () => { single = true; return execute() },
    then: (resolve, reject) => execute().then(resolve, reject),
  }
  return api
}
globalThis.__demoDb = {
  auth: { getUser: async () => ({ data: { user: { id: 'test-user', email: userEmail } }, error: null }) },
  from: query,
  rpc: async (name, args) => {
    assert.equal(name, 'claim_recepta_demo')
    return { data: (await db.query('select * from claim_recepta_demo($1)', [args.p_token_hash])).rows, error: null }
  },
}
const compile = async file => {
  const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'synthetic-db', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const createClient = () => globalThis.__demoDb', loader: 'js' }))
    } }],
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}
process.env.SUPABASE_URL = 'https://synthetic.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
process.env.RETELL_API_KEY = 'synthetic-only'
process.env.ADMIN_EMAIL = 'admin@example.test'
const admin = await compile('netlify/functions/admin-demo-links.ts')
const demo = await compile('netlify/functions/demo-call.ts')
const webhook = await compile('netlify/functions/retell-webhook.ts')
const pricing = await compile('netlify/functions/public-pricing.ts')
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname
  if (path.includes('list-agent-versions')) return Response.json({ items: [{ version: 2, is_published: published }] })
  if (path.includes('get-agent')) return Response.json({ agent_id: 'agent_demo', version: 2, is_published: published, response_engine: { type: 'retell-llm', llm_id: 'llm_demo', version: 2 } })
  if (path.includes('get-retell-llm')) return Response.json({ general_tools: tools, states: [] })
  assert.equal(path, '/v3/create-web-call')
  providerCalls.push(JSON.parse(options.body))
  return providerFailure ? Response.json({ error: 'synthetic failure' }, { status: 500 }) : Response.json({ call_id: 'call_synthetic', access_token: 'synthetic-one-call-token', transport: 'gateway', ice_servers: [], expires_at: Date.now() + 300000 }, { status: 201 })
}
const request = (action, extra = {}) => new Request('https://recepta.test/.netlify/functions/demo-call', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Recepta-Demo': token }, body: JSON.stringify({ action, consent: true, ...extra }),
})
const adminRequest = (method, body) => new Request('https://recepta.test/.netlify/functions/admin-demo-links', {
  method, headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
const fixture = async () => {
  reset()
  await db.exec('truncate recepta_demo_links, agents')
  await db.query("insert into recepta_demo_links (token_hash, label, retell_agent_id, agent_version) values ($1, 'Synthetic demo', 'agent_demo', 2)", [hash(token)])
}
test.before(async () => {
  db = new PGlite()
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table agents (client_id uuid, retell_agent_id text); grant select on agents to service_role;')
  await db.exec(await readFile('supabase/migrations/20261014205655_shareable_demo_links.sql', 'utf8'))
})
test.after(async () => { globalThis.fetch = originalFetch; await db.close() })

test('only admins can create, list or revoke links; the secret token is stored as a hash', async () => {
  await fixture()
  assert.equal((await admin(new Request('https://recepta.test'))).status, 401)
  userEmail = 'customer@example.test'
  for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await admin(adminRequest(method, method === 'GET' ? null : {}))).status, 403)
  userEmail = 'admin@example.test'
  const response = await admin(adminRequest('POST', { label: 'Synthetic demo', agentId: 'agent_demo' }))
  assert.equal(response.status, 201)
  const result = await response.json()
  const secret = new URL(result.url).hash.slice(1)
  assert.match(secret, /^[a-f0-9]{64}$/)
  const row = (await db.query('select * from recepta_demo_links where id = $1', [result.id])).rows[0]
  assert.equal(row.token_hash, hash(secret))
  assert.equal(row.max_attempts, 3)
  assert.equal(Object.values(row).includes(secret), false)
  const list = await (await admin(adminRequest('GET'))).json()
  assert.equal('token_hash' in list.links[0], false)
  assert.equal((await admin(adminRequest('PATCH', { id: result.id }))).status, 200)
  assert.equal((await db.query('select revoked from recepta_demo_links where id=$1', [result.id])).rows[0].revoked, true)
})

test('paid client agents, unpublished demos and agents with external tools cannot be shared', async () => {
  await fixture()
  assigned = true
  assert.equal((await admin(adminRequest('POST', { label: 'Test', agentId: 'agent_demo' }))).status, 409)
  assigned = false; published = false
  assert.equal((await admin(adminRequest('POST', { label: 'Test', agentId: 'agent_demo' }))).status, 400)
  published = true; tools = [{ type: 'custom', name: 'book_real_appointment' }]
  assert.equal((await admin(adminRequest('POST', { label: 'Test', agentId: 'agent_demo' }))).status, 400)
  assert.equal((await demo(request('start'))).status, 502)
  assert.equal(providerCalls.length, 0)
})

test('demo admission is atomic, limited to three attempts, and rechecks later client assignment', async () => {
  await fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => db.query('select * from claim_recepta_demo($1)', [hash(token)])))
  assert.equal(results.filter(result => result.rows.length).length, 3)
  assert.equal((await db.query('select attempts from recepta_demo_links')).rows[0].attempts, 3)
  await fixture()
  await db.exec("insert into agents values ('00000000-0000-0000-0000-000000000001', 'agent_demo')")
  assert.equal((await db.query('select * from claim_recepta_demo($1)', [hash(token)])).rows.length, 0)
})

test('an inspection or missing consent never consumes an attempt; browser fields cannot select a paid agent or remove the cap', async () => {
  await fixture()
  const inspect = await (await demo(request('inspect'))).json()
  assert.equal(inspect.attemptsRemaining, 3)
  assert.equal('retell_agent_id' in inspect, false)
  assert.equal((await demo(request('start', { consent: false }))).status, 400)
  assert.equal((await db.query('select attempts from recepta_demo_links')).rows[0].attempts, 0)
  const response = await demo(request('start', { agent_id: 'paid_client_agent', max_call_duration_ms: 7200000, metadata: { client_id: 'victim' } }))
  assert.equal(response.status, 201)
  const created = providerCalls[0]
  assert.equal(created.agent_id, 'agent_demo')
  assert.equal(created.agent_version, 2)
  assert.equal(created.agent_override.agent.max_call_duration_ms, 180000)
  assert.equal(created.agent_override.agent.data_storage_setting, 'basic_attributes_only')
  assert.deepEqual(created.agent_override.agent.webhook_events, [])
  assert.equal(created.metadata.recepta_demo, true)
  assert.equal('client_id' in created.metadata, false)
  const result = await response.json()
  assert.equal('agent_id' in result, false)
  assert.equal('metadata' in result, false)
})

test('expired, revoked and exhausted links cannot start; provider failures remain budgeted', async () => {
  for (const update of ["expires_at = now() - interval '1 minute'", 'revoked = true', 'attempts = max_attempts']) {
    await fixture()
    await db.exec(`update recepta_demo_links set ${update}`)
    assert.equal((await demo(request('start'))).status, 404)
    assert.equal(providerCalls.length, 0)
  }
  await fixture(); providerFailure = true
  for (let i = 0; i < 3; i++) assert.equal((await demo(request('start'))).status, 502)
  assert.equal((await demo(request('start'))).status, 404)
  assert.equal(providerCalls.length, 3)
})

test('public roles cannot read links, redeem tokens, or change limits', async () => {
  await fixture()
  for (const role of ['anon', 'authenticated']) {
    const result = await db.query("select has_table_privilege($1,'public.recepta_demo_links','select') as read, has_table_privilege($1,'public.recepta_demo_links','update') as update, has_function_privilege($1,'public.claim_recepta_demo(text)','execute') as redeem", [role])
    assert.deepEqual(result.rows[0], { read: false, update: false, redeem: false })
  }
  await db.exec('set role service_role')
  assert.equal((await db.query('select * from claim_recepta_demo($1)', [hash(token)])).rows.length, 1)
  await db.exec('reset role')
})

test('signed demo events never become paid client calls or owner notifications', async () => {
  await fixture()
  const raw = JSON.stringify({ event: 'call_ended', call: { call_id: 'call_synthetic', agent_id: 'agent_demo', call_type: 'web_call', metadata: { recepta_demo: true } } })
  const timestamp = Date.now()
  const signature = `v=${timestamp},d=${createHmac('sha256', 'synthetic-only').update(raw + timestamp).digest('hex')}`
  const response = await webhook(new Request('https://recepta.test', { method: 'POST', headers: { 'x-retell-signature': signature }, body: raw }))
  assert.equal(response.status, 204)
  assert.equal(selections.length, 0)
})

test('public pricing uses the active catalogue and the same complete monthly calculation', async () => {
  await fixture()
  const response = await pricing(new Request('https://recepta.test'))
  assert.equal(response.status, 200)
  assert.match(selections[0].columns, /customer_price_per_minute_cad/)
  assert.equal(selections[0].columns.includes('cost'), false)
  const catalogue = await response.json()
  assert.equal(catalogue.models[0].customer_price_per_minute_cad, '0.117')
  assert.equal(calculateMonthlyPriceCad({ planName: 'Recepta Standard', monthlyMinutes: 300, modelPricePerMinuteCad: 0.117, piiRedactionEnabled: false, safetyGuardrailsEnabled: false }), 235.1)
  assert.equal(calculateMonthlyPriceCad({ planName: 'Recepta Pro', monthlyMinutes: 300, modelPricePerMinuteCad: 0.217, piiRedactionEnabled: true, safetyGuardrailsEnabled: true, extraPhoneNumbers: 2 }), 411.4)
})
