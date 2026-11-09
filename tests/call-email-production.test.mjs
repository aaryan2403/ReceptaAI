import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const compile = async path => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const environment = await compile('netlify/lib/emailEnvironment.ts')
const { syncRetellSchedule } = await compile('netlify/lib/retell.ts')
const keys = ['CONTEXT', 'URL', 'RECEPTA_APP_URL', 'RECEPTA_REQUIRE_STRIPE_TEST_MODE', 'RECEPTA_CALL_EMAIL_ENABLED', 'RESEND_API_KEY', 'RESEND_STAGING_API_KEY']
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
const originalFetch = globalThis.fetch
test.beforeEach(() => { for (const key of keys) delete process.env[key] })
test.afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

test('normal admin email controls use the production key without a separate rollout setup', () => {
  process.env.CONTEXT = 'production'
  process.env.RESEND_API_KEY = ' synthetic-production '
  assert.equal(environment.callEmailPreferencesEnabled(), true)
  assert.equal(environment.emailApiKey(), 'synthetic-production')
  process.env.RECEPTA_CALL_EMAIL_ENABLED = 'false'
  assert.equal(environment.callEmailPreferencesEnabled(), false)
  process.env.CONTEXT = 'deploy-preview'
  delete process.env.RECEPTA_CALL_EMAIL_ENABLED
  assert.equal(environment.callEmailPreferencesEnabled(), false)
  assert.throws(() => environment.emailApiKey(), /RESEND_STAGING_API_KEY/)
})

const fixture = (webhook = 'https://normal-admin.example.test/.netlify/functions/retell-webhook') => {
  process.env.URL = 'https://normal-admin.example.test'
  let llm = { general_prompt: 'Keep business instructions. Never transfer after 9pm.',
    general_tools: [{ type: 'custom', name: 'existing_business_tool' }], default_dynamic_variables: { keep: 'existing value' } }
  const writes = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname
    if (path.startsWith('/list-agent-versions/')) return Response.json({ items: [{ version: 1, is_published: true }] })
    if (path.startsWith('/create-agent-version/')) return Response.json({ version: 2,
      response_engine: { type: 'retell-llm', llm_id: 'synthetic_llm', version: 2 }, webhook_url: webhook,
      webhook_events: ['transcript_updated'], post_call_analysis_data: [
        { type: 'string', name: 'business_field', description: 'Existing field' },
        { type: 'string', name: 'recepta_detail_obsolete', description: 'Old managed question' },
      ] })
    if (path.startsWith('/get-retell-llm/')) return Response.json(llm)
    if (path.startsWith('/update-retell-llm/')) llm = JSON.parse(init.body)
    if (path.startsWith('/update-') || path.startsWith('/publish-')) writes.push({ path, body: JSON.parse(init.body) })
    return Response.json({})
  }
  return { writes, llm: () => llm }
}
const schedule = { mode: '24/7', timeZone: 'America/Toronto', hours: [] }
test('per-client email publication preserves business instructions and survives later schedule saves', async () => {
  const state = fixture()
  const settings = { callerEnabled: true, ownerFields: ['custom'], callerFields: ['summary'], customFields: ['Service required'] }
  await syncRetellSchedule({ apiKey: 'synthetic', agentId: 'synthetic_agent', schedule, callEmailSettings: settings })
  const agent = state.writes.find(item => item.path.startsWith('/update-agent/')).body
  assert.ok(agent.webhook_events.includes('call_analyzed'))
  assert.ok(agent.webhook_events.includes('transcript_updated'))
  assert.ok(agent.post_call_analysis_data.some(item => item.name === 'business_field'))
  assert.ok(!agent.post_call_analysis_data.some(item => item.name === 'recepta_detail_obsolete'))
  assert.ok(agent.post_call_analysis_data.some(item => item.name === 'recepta_caller_email_confirmed'))
  await syncRetellSchedule({ apiKey: 'synthetic', agentId: 'synthetic_agent', schedule })
  assert.equal(JSON.parse(state.llm().default_dynamic_variables.recepta_call_email_settings).callerEnabled, true)
  assert.equal(state.llm().default_dynamic_variables.keep, 'existing value')
  assert.match(state.llm().general_prompt, /Never transfer after 9pm/)
  assert.match(state.llm().general_prompt, /one at a time/)
  assert.equal((state.llm().general_prompt.match(/\[RECEPTA MANAGED CALL EMAIL\]/g) ?? []).length, 1)
  assert.ok(state.llm().general_tools.some(tool => tool.name === 'existing_business_tool'))
})
test('email publication refuses to replace another webhook; existing schedule-only agents stay unchanged', async () => {
  const conflict = fixture('https://other-service.example.test/webhook')
  await assert.rejects(syncRetellSchedule({ apiKey: 'synthetic', agentId: 'synthetic_agent', schedule,
    callEmailSettings: { callerEnabled: true } }), /different call-event webhook/)
  assert.equal(conflict.writes.length, 0)
  const legacy = fixture()
  await syncRetellSchedule({ apiKey: 'synthetic', agentId: 'synthetic_agent', schedule })
  assert.equal(legacy.writes.some(item => item.path.startsWith('/update-agent/')), false)
  assert.doesNotMatch(legacy.llm().general_prompt, /\[RECEPTA MANAGED CALL EMAIL\]/)
})

test('a mapped existing extraction is reused by both post-call analysis and appointment questions', async () => {
  const state = fixture()
  const settings = {callerEnabled:true,ownerFields:['custom'],callerFields:['custom'],customFields:['Postcode'],
    customFieldOptions:[{label:'Postcode',analysisKey:'business_field',owner:true,caller:false}]}
  await syncRetellSchedule({apiKey:'synthetic',agentId:'synthetic_agent',schedule,appointmentFields:['Old appointment question'],callEmailSettings:settings})
  const fields=state.writes.find(item=>item.path.startsWith('/update-agent/')).body.post_call_analysis_data
  assert.deepEqual(fields.find(item=>item.name==='business_field'),{type:'string',name:'business_field',description:'Existing field'})
  assert.equal(fields.filter(item=>item.name==='business_field').length,1)
  assert.match(state.llm().default_dynamic_variables.recepta_appointment_fields,/Postcode/)
  assert.doesNotMatch(state.llm().default_dynamic_variables.recepta_appointment_fields,/Old appointment question/)
})
