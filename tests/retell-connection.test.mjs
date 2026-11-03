import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Real admin authorization and provider adapter, with synthetic identity and
// HTTP boundaries. No real credentials, client writes, calls or purchases.
const originalFetch = globalThis.fetch
const saved = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_EMAIL', 'RETELL_API_KEY'].map(key => [key, process.env[key]]))
process.env.SUPABASE_URL = 'https://example.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-db-key'
process.env.ADMIN_EMAIL = 'admin@example.test'
let email, requests, provider
globalThis.__retellTestAuth = { auth: { getUser: async () => ({ data: { user: email ? { id: 'synthetic', email } : null }, error: null }) } }
const compile = async entry => {
  const bundled = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'synthetic-db', setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.__retellTestAuth', loader: 'js' }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}
const handler = (await compile('netlify/functions/admin-retell-agents.ts')).default
const { assertRetellAgentAvailable } = await compile('netlify/lib/retell.ts')
const reset = () => {
  email = 'admin@example.test'; requests = []
  process.env.RETELL_API_KEY = 'synthetic-retell-key'
  provider = async () => Response.json({ items: [], has_more: false })
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return provider(url, options) }
}
const request = (query = '', method = 'GET', token = 'synthetic') => new Request(`https://recepta.example/.netlify/functions/admin-retell-agents${query}`, {
  method, headers: token ? { Authorization: `Bearer ${token}` } : {},
})
after(() => {
  globalThis.fetch = originalFetch
  delete globalThis.__retellTestAuth
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
})

test('only an authenticated admin can inspect server-visible agents', async () => {
  reset()
  assert.equal((await handler(request('', 'GET', ''))).status, 401)
  email = null; assert.equal((await handler(request())).status, 401)
  email = 'customer@example.test'; assert.equal((await handler(request())).status, 403)
  email = 'admin@example.test'; assert.equal((await handler(request('', 'POST'))).status, 405)
  assert.equal(requests.length, 0)
})

test('missing deployment key is actionable without making provider requests', async () => {
  reset(); delete process.env.RETELL_API_KEY
  const response = await handler(request())
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /RETELL_API_KEY.*Netlify.*redeploy/)
  assert.equal(requests.length, 0)
})

test('uses documented paginated voice-only listing, returns only safe metadata and never changes agents', async () => {
  reset()
  provider = async (url, options) => {
    assert.equal(url, 'https://api.retellai.com/v2/list-agents?limit=100')
    assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer synthetic-retell-key')
    assert.deepEqual(JSON.parse(options.body), { filter_criteria: { channel: { op: 'eq', value: 'voice' } } })
    assert.ok(options.signal)
    return Response.json({ items: [{ agent_id: 'agent_real', agent_name: 'Receptionist', general_prompt: 'private', api_key: 'private', is_suspended: false, is_transfer_agent: true }], has_more: true, pagination_key: 'page/+2' })
  }
  const response = await handler(request())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const data = await response.json()
  assert.deepEqual(data.agents, [{ id: 'agent_real', name: 'Receptionist', suspended: false, transferOnly: true }])
  assert.equal(data.nextCursor, 'page/+2')
  assert.ok(Date.parse(data.checkedAt))
  assert.doesNotMatch(JSON.stringify(data), /private|synthetic-retell-key|general_prompt/)
  assert.equal(requests.length, 1)
})

test('pagination preserves cursor safely and empty workspace is a valid result', async () => {
  reset()
  const response = await handler(request('?cursor=page%2F%2B2'))
  assert.equal(requests[0].url, 'https://api.retellai.com/v2/list-agents?limit=100&pagination_key=page%2F%2B2')
  assert.deepEqual((await response.json()).agents, [])
  assert.equal((await handler(request('?cursor=' + 'x'.repeat(2049)))).status, 400)
  assert.equal(requests.length, 1)
})

test('invalid key, permissions and rate limits have separate safe messages', async () => {
  for (const [status, expected] of [[401, /rejected.*server API key/], [403, /denied agent access.*Edit access/], [429, /rate limiting/], [500, /could not complete/]]) {
    reset(); provider = async () => Response.json({ message: 'private-provider-detail synthetic-retell-key' }, { status })
    const response = await handler(request())
    assert.equal(response.status, 502)
    const { error } = await response.json()
    assert.match(error, expected)
    assert.doesNotMatch(error, /private-provider-detail|synthetic-retell-key/)
  }
})

test('malformed provider pages cannot claim a successful connection', async () => {
  for (const body of [{ items: [] }, { items: [{}], has_more: false }, { items: [], has_more: true }, { items: [], has_more: true, pagination_key: 'same' }]) {
    reset(); provider = async () => Response.json(body)
    assert.equal((await handler(request('?cursor=same'))).status, 502)
  }
  reset(); provider = async () => { throw new TypeError('private network detail') }
  const result = await (await handler(request())).json()
  assert.doesNotMatch(result.error, /private network detail/)
})

test('agent verification still requires the exact agent before any creation or sync', async () => {
  reset()
  provider = async (url, options) => {
    assert.equal(url, 'https://api.retellai.com/get-agent/agent_requested')
    assert.ok(options.signal)
    return Response.json({ agent_id: 'agent_requested' })
  }
  await assertRetellAgentAvailable({ apiKey: 'synthetic-retell-key', agentId: 'agent_requested' })
  for (const body of [{}, null, { agent_id: 'agent_other' }]) {
    provider = async () => Response.json(body)
    await assert.rejects(assertRetellAgentAvailable({ apiKey: 'synthetic-retell-key', agentId: 'agent_requested' }))
  }
})

test('provider asset error points to connection check without guessing whether agent was deleted', async () => {
  reset(); provider = async () => Response.json({ message: 'Cannot find requested asset under given api key.' }, { status: 422 })
  await assert.rejects(assertRetellAgentAvailable({ apiKey: 'synthetic-retell-key', agentId: 'agent_requested' }), /not accessible.*Check Retell connection.*same workspace/)
  provider = async () => Response.json({}, { status: 401 })
  await assert.rejects(assertRetellAgentAvailable({ apiKey: 'synthetic-retell-key', agentId: 'agent_requested' }), /server API key.*redeploy/)
})
