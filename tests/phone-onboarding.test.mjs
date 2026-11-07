import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

let user, rpcCalls, rpcError
globalThis.__onboardingDb = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  rpc: async (name, args) => {
    rpcCalls.push({ name, args })
    return { data: rpcCalls.length === 1, error: rpcError }
  },
}
const bundle = await build({
  entryPoints: ['netlify/functions/onboard-customer.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'synthetic-auth', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'auth', namespace: 'mock' }))
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const createClient=()=>globalThis.__onboardingDb' }))
  } }],
})
const onboard = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default
const compile = async (path, name) => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return (await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')))[name]
}
const searchNumbers = await compile('netlify/lib/twilioNumbers.ts', 'searchTwilioNumbers')
const provisionSelected = await compile('netlify/lib/twilioNumbers.ts', 'provisionSelectedTwilioNumber')
const getRetellApiKey = await compile('netlify/lib/retellEnvironment.ts', 'getRetellApiKey')
const serviceReadiness = await compile('netlify/lib/phoneSetup.ts', 'verifyServiceReadiness')
const originalFetch = globalThis.fetch
const originalEnvironment = { ...process.env }
test.beforeEach(() => {
  rpcCalls = []; rpcError = null
  user = { id: 'verified-customer', email: 'customer@example.test', email_confirmed_at: new Date().toISOString(),
    user_metadata: { recepta_self_service: true, company_name: 'Customer company', requested_plan: 'Recepta Standard' } }
  process.env.SUPABASE_URL = 'https://synthetic.test'
  process.env.SUPABASE_SECRET_KEY = 'synthetic'
  process.env.ADMIN_EMAIL = 'admin@example.test'
  process.env.RECEPTA_PHONE_SETUP_ENABLED = 'true'
})
test.afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]
  Object.assign(process.env, originalEnvironment)
})
const request = () => new Request('https://recepta.test/.netlify/functions/onboard-customer', {
  method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientId: 'another-customer', role: 'admin', monthlyPrice: 0 }),
})

test('self-service onboarding uses the verified identity and validated plan, and is safely retryable', async () => {
  assert.equal((await onboard(request())).status, 200)
  assert.deepEqual(rpcCalls[0], { name: 'initialize_recepta_customer', args: {
    p_client_id: user.id, p_email: user.email, p_company: 'Customer company', p_plan: 'Recepta Standard',
  } })
  assert.deepEqual(await (await onboard(request())).json(), { created: false })
})

test('signup rejects unverified emails, admin accounts, invalid plans and ordinary accounts before writes', async () => {
  delete user.email_confirmed_at
  assert.equal((await onboard(request())).status, 403)
  user.email_confirmed_at = new Date().toISOString()
  user.email = 'admin@example.test'
  assert.equal((await onboard(request())).status, 403)
  user.email = 'customer@example.test'
  user.user_metadata.requested_plan = 'free-admin-plan'
  assert.equal((await onboard(request())).status, 400)
  user.user_metadata = {}
  assert.equal((await onboard(request())).status, 400)
  assert.equal(rpcCalls.length, 0)
})

test('onboarding errors do not reveal database details or credentials', async () => {
  rpcError = { message: 'private database diagnostic' }
  const response = await onboard(request())
  assert.equal(response.status, 503)
  assert.doesNotMatch(await response.text(), /private database diagnostic|SUPABASE_SECRET_KEY/)
})

test('preview routes require an explicit staging Retell key', () => {
  process.env.RETELL_API_KEY = 'synthetic-production'
  process.env.CONTEXT = 'deploy-preview'
  delete process.env.RETELL_STAGING_API_KEY
  assert.equal(getRetellApiKey(), undefined)
  process.env.RETELL_STAGING_API_KEY = 'synthetic-staging'
  assert.equal(getRetellApiKey(), 'synthetic-staging')
  process.env.CONTEXT = 'production'
  delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
  assert.equal(getRetellApiKey(), 'synthetic-production')
})

test('provider readiness reads the configured Verify service without sending a code', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32)
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VA' + 'b'.repeat(32)
  process.env.TWILIO_AUTH_TOKEN = 'synthetic'
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method ?? 'GET' })
    return new Response(JSON.stringify({ sid: process.env.TWILIO_VERIFY_SERVICE_SID, account_sid: process.env.TWILIO_ACCOUNT_SID }))
  }
  assert.equal(await serviceReadiness(), 'verified')
  assert.deepEqual(requests, [{ method: 'GET', url: 'https://verify.twilio.com/v2/Services/' + process.env.TWILIO_VERIFY_SERVICE_SID }])
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  assert.equal(await serviceReadiness(), 'credentials_rejected')
})

const configureNumbers = () => {
  process.env.RECEPTA_TWILIO_NUMBERS_ENABLED = 'true'
  process.env.CONTEXT = 'production'
  delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
  process.env.RETELL_API_KEY = 'synthetic-retell'
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'a'.repeat(32)
  process.env.TWILIO_AUTH_TOKEN = 'synthetic-twilio'
  process.env.TWILIO_TRUNK_SID = 'TK' + 'b'.repeat(32)
  process.env.TWILIO_TERMINATION_URI = 'fixture.pstn.twilio.com'
  process.env.TWILIO_TRUNK_USERNAME = 'synthetic-user'
  process.env.TWILIO_TRUNK_PASSWORD = 'synthetic-password'
  process.env.RECEPTA_APP_URL = 'https://recepta.test'
}

test('number search filters voice inventory and rejects invalid country filters before contacting Twilio', async () => {
  configureNumbers()
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method })
    return new Response(JSON.stringify({ available_phone_numbers: [
      { phone_number: '+14165550101', capabilities: { voice: true }, locality: 'Toronto', region: 'ON' },
      { phone_number: '+14165550102', capabilities: { voice: false } },
    ] }))
  }
  assert.deepEqual(await searchNumbers('CA', '416'), [{ number: '+14165550101', locality: 'Toronto', region: 'ON' }])
  assert.equal(requests[0].method, 'GET')
  assert.match(requests[0].url, /AvailablePhoneNumbers\/CA\/Local.json\?VoiceEnabled=true/)
  await assert.rejects(searchNumbers('GB'), /Canada/)
  assert.equal(requests.length, 1)
})

test('selected Twilio number is journaled, imported to its own agent, and safely resumed without repurchase', async () => {
  configureNumbers()
  const number = '+14165550101'
  let journal = {}, imported = false
  const requests = []
  const db = { from: () => ({ update: values => ({ eq: async () => { Object.assign(journal, values); return { data: null, error: null } } }) }) }
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? 'GET', body: options.body })
    if (url.includes('IncomingPhoneNumbers')) return new Response(JSON.stringify({
      sid: 'PN' + 'c'.repeat(32), phone_number: number,
      account_sid: process.env.TWILIO_ACCOUNT_SID, trunk_sid: process.env.TWILIO_TRUNK_SID,
    }))
    if (url.includes('/get-phone-number/')) return imported ? new Response(JSON.stringify({
      phone_number: number, inbound_webhook_url: 'https://recepta.test/.netlify/functions/retell-inbound',
      outbound_agents: [{ agent_id: 'agent_customer' }], sip_outbound_trunk_config: { termination_uri: process.env.TWILIO_TERMINATION_URI },
    })) : new Response('{}', { status: 404 })
    if (url.endsWith('/import-phone-number')) {
      const body = JSON.parse(options.body)
      assert.equal(body.phone_number, number)
      assert.equal(body.inbound_agents, null)
      assert.equal(body.outbound_agents[0].agent_id, 'agent_customer')
      imported = true
      return new Response(JSON.stringify({ phone_number: number }))
    }
    throw new Error('Unexpected synthetic provider request')
  }
  assert.equal(await provisionSelected(db, 'customer', 'agent_customer', number, null), number)
  assert.equal(journal.number_import_state, 'ready')
  assert.equal(await provisionSelected(db, 'customer', 'agent_customer', number, journal), number)
  assert.equal(requests.filter(row => row.method === 'POST' && row.url.includes('IncomingPhoneNumbers')).length, 1)
  assert.equal(requests.filter(row => row.url.endsWith('/import-phone-number')).length, 1)
  assert.equal(requests.some(row => row.method === 'DELETE'), false)
  await assert.rejects(provisionSelected(db, 'customer', 'agent_other', number, journal), /different Retell agent/)
})

test('staging refuses selected-number purchases before any provider operation', async () => {
  configureNumbers()
  process.env.CONTEXT = 'deploy-preview'
  globalThis.fetch = async () => { throw new Error('Provider should not be contacted') }
  await assert.rejects(provisionSelected({}, 'customer', 'agent_customer', '+14165550101', null), /disabled in staging/)
})
