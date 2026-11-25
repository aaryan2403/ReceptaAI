import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { PGlite } from '@electric-sql/pglite'
import twilio from 'twilio'

const account = 'AC' + '1'.repeat(32)
const token = 'test-auth-token'
const ingress = '+14165550100'
const ai = '+14165550101'
const human = '+14165550102'
const caller = '+16475550103'
const business = '+14165550104'
const callSid = 'CA' + '1'.repeat(32)
const recording = 'RE' + '1'.repeat(32)
const clientId = '00000000-0000-0000-0000-000000000001'
const callbackId = '00000000-0000-0000-0000-000000000002'
const origin = 'https://deploy-preview-999--receptaai.netlify.app'
const url = origin + '/.netlify/functions/voice-inbound'
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const schedule = (day, start, end, answeringMode = 'business_hours') => JSON.stringify({
  mode: 'custom', timeZone: 'America/Toronto', answeringMode,
  hours: days.map(name => ({ day: name, open: name === day, start, end })),
})

Object.assign(process.env, {
  SUPABASE_URL: 'https://mvufjeqxqvpcfqwmihpy.supabase.co',
  SUPABASE_SECRET_KEY: 'test-only',
  RETELL_STAGING_API_KEY: 'retell-test-key',
  RECEPTA_STAGING_VOICE_NUMBERS: ingress,
  TWILIO_VOICE_STAGING_ACCOUNT_SID: account,
  TWILIO_VOICE_STAGING_AUTH_TOKEN: token,
})

let sql
const commands = []
const readOne = (query) => Promise.resolve(query).then(result => ({
  data: result.rows[0] ?? null, error: null,
})).catch(error => ({ data: null, error }))

globalThis.__voiceTestDb = {
  rpc(name, args) {
    commands.push(name)
    switch (name) {
      case 'recepta_voice_number_kind':
        return readOne(sql.query('select recepta_voice_number_kind($1) as kind', [args.p_number]))
          .then(result => ({ ...result, data: result.data?.kind ?? null }))
      case 'recepta_voice_route':
        return { maybeSingle: () => readOne(sql.query('select * from recepta_voice_route($1)', [args.p_ingress])) }
      case 'record_recepta_callback':
        return readOne(sql.query(`insert into callback_requests(id, client_id, retell_call_id)
          values ($1, $2, $3) on conflict (retell_call_id) do nothing`, [callbackId, args.p_client_id, args.p_call_id]))
      case 'recepta_store_inbound_voicemail':
        return readOne(sql.query('select recepta_store_inbound_voicemail($1, $2, $3, $4)', [
          args.p_account, args.p_recording, args.p_call, args.p_callback,
        ]))
      default: throw new Error('Unexpected RPC ' + name)
    }
  },
  from(table) {
    assert.equal(table, 'callback_requests')
    let call, client
    const query = {
      select: () => query,
      eq(column, value) {
        if (column === 'retell_call_id') call = value
        if (column === 'client_id') client = value
        return query
      },
      maybeSingle: () => readOne(sql.query(
        'select id from callback_requests where retell_call_id = $1 and client_id = $2', [call, client]
      )),
    }
    return query
  },
}

const buildDir = await mkdtemp('node_modules/.voice-routing-test-')
test.after(async () => {
  await sql?.close()
  await rm(buildDir, { recursive: true, force: true })
})
await build({
  entryPoints: ['netlify/functions/voice-inbound.ts', 'netlify/functions/retell-inbound.ts',
    'netlify/functions/admin-inbound-route.ts', 'netlify/lib/inboundVoice.ts'],
  bundle: true, platform: 'node', format: 'esm', packages: 'external', outdir: buildDir,
  plugins: [{ name: 'local-database', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
      contents: 'export const createClient = () => globalThis.__voiceTestDb',
    }))
  } }],
})
const { default: inbound } = await import(pathToFileURL(buildDir + '/functions/voice-inbound.js'))
const { default: retellInbound } = await import(pathToFileURL(buildDir + '/functions/retell-inbound.js'))
const { default: adminRoute } = await import(pathToFileURL(buildDir + '/functions/admin-inbound-route.js'))
const { usesAiReception } = await import(pathToFileURL(buildDir + '/lib/inboundVoice.js'))

function twilioRequest(query = '', overrides = {}, sign = true) {
  const address = url + query
  const params = { AccountSid: account, CallSid: callSid, From: caller, To: ingress, ...overrides }
  return new Request(address, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign ? twilio.getExpectedTwilioSignature(token, address, params) : 'bad',
    },
    body: new URLSearchParams(params),
  })
}

test.before(async () => {
  sql = new PGlite()
  await sql.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table clients(id uuid primary key, deletion_pending boolean default false, call_retention_days integer default 7);
    create table agents(client_id uuid primary key, phone_number text, retell_agent_id text, business_hours text);
    create table agent_phone_numbers(client_id uuid, phone_number text);
    create table callback_requests(id uuid primary key, client_id uuid, retell_call_id text unique, created_at timestamptz default now());
  `)
  const migration = await readFile(new URL('../supabase/migrations/20261125231500_scheduled_inbound_routing.sql', import.meta.url), 'utf8')
  await sql.exec(migration)
  await sql.query('insert into clients(id) values ($1)', [clientId])
  await sql.query('insert into agents values ($1,$2,$3,$4)', [clientId, ai, 'agent_test', '24/7'])
  await sql.query('insert into inbound_phone_routes values ($1,$2,$3,$4,$5)', [ingress, clientId, ai, human, business])
})

test('Toronto wall-clock hours handle overnight and both daylight saving transitions', () => {
  const at = (hours, utc) => usesAiReception(hours, new Date(utc))
  const overnight = schedule('Saturday', '22:00', '03:30')
  assert.equal(at(overnight, '2026-03-08T07:00:00Z'), true)
  assert.equal(at(overnight, '2026-03-08T07:30:00Z'), false)
  const repeated = schedule('Sunday', '01:00', '02:00')
  assert.equal(at(repeated, '2026-11-01T05:30:00Z'), true)
  assert.equal(at(repeated, '2026-11-01T06:30:00Z'), true)
  assert.equal(at(repeated, '2026-11-01T07:00:00Z'), false)
  assert.equal(at(schedule('Sunday', '01:00', '02:00', '24/7'), '2026-11-01T07:00:00Z'), true)
})

test('signed ingress rings Retell in 24/7 mode and at opening, then uses only the human phone outside hours', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T05:00:00Z') })
  for (const hours of ['24/7', schedule('Sunday', '01:00', '02:00')]) {
    await sql.query('update agents set business_hours = $1', [hours])
    const response = await inbound(twilioRequest())
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<Dial answerOnBridge="true">\+14165550101<\/Dial>/)
  }

  context.mock.timers.setTime(Date.parse('2026-11-01T07:00:00Z'))
  commands.length = 0
  const response = await inbound(twilioRequest('', { ForwardedFrom: business }))
  const xml = await response.text()
  assert.match(xml, /<Dial callerId="\+14165550100".*>\+14165550102<\/Dial>/)
  assert.doesNotMatch(xml, /\+14165550101|<Say|<Record/)
  assert.deepEqual(commands, ['recepta_voice_number_kind', 'recepta_voice_number_kind', 'recepta_voice_route', 'recepta_voice_number_kind'])
})

test('human outcome offers voicemail for missed calls and hangs up on completed calls', async () => {
  const completed = await inbound(twilioRequest('?stage=human', { DialCallStatus: 'completed' }))
  assert.match(await completed.text(), /<Hangup\/>/)
  const response = await inbound(twilioRequest('?stage=human', { DialCallStatus: 'no-answer' }))
  const xml = await response.text()
  assert.match(xml, /<Record .*recordingStatusCallback=/)
  assert.match(xml, /Please leave a message after the tone/)
  assert.doesNotMatch(xml, /<Dial/)
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await inbound(twilioRequest('?stage=recording&callback=' + callbackId, {
      RecordingSid: recording, RecordingStatus: 'completed',
    }))
    assert.equal(status.status, 204)
  }
  assert.deepEqual((await sql.query('select recording_sid, callback_id from inbound_voicemails')).rows, [
    { recording_sid: recording, callback_id: callbackId },
  ])
})

test('rejects invalid signatures, mismatched accounts, short circuits returned legs and fails closed for reassigned numbers', async () => {
  assert.equal((await inbound(twilioRequest('', {}, false))).status, 403)
  assert.equal((await inbound(twilioRequest('', { AccountSid: 'AC' + '0'.repeat(32) }))).status, 403)
  assert.match(await (await inbound(twilioRequest('', { From: ingress }))).text(), /<Reject reason="busy"\/>/)
  assert.match(await (await inbound(twilioRequest('', { ForwardedFrom: ingress }))).text(), /<Reject reason="busy"\/>/)
  const { createHmac } = await import('node:crypto')
  const body = JSON.stringify({ event: 'call_inbound', call_inbound: { call_id: 'call_loop', from_number: ingress, to_number: ai } })
  const timestamp = Date.now().toString()
  const signature = createHmac('sha256', process.env.RETELL_STAGING_API_KEY).update(body + timestamp).digest('hex')
  const bounced = await retellInbound(new Request(origin + '/.netlify/functions/retell-inbound', {
    method: 'POST', headers: { 'x-retell-signature': `v=${timestamp},d=${signature}` }, body,
  }))
  assert.deepEqual(await bounced.json(), { call_inbound: { reject: true } })

  await sql.query("update agents set phone_number = null, business_hours = '24/7'")
  assert.match(await (await inbound(twilioRequest())).text(), /<Reject reason="busy"\/>/)
})

test('anonymous and authenticated database roles cannot access the routing or voicemail tables', async () => {
  for (const role of ['anon', 'authenticated']) {
    await sql.exec('set role ' + role)
    try {
      await assert.rejects(sql.query('select * from inbound_phone_routes'), /permission denied/)
      await assert.rejects(sql.query('select * from inbound_voicemails'), /permission denied/)
      await assert.rejects(sql.query('select * from recepta_voice_route($1)', [ingress]), /permission denied/)
    } finally {
      await sql.exec('reset role')
    }
  }
})

test('admin connects an existing line by setting its webhook and safely retries a provider timeout', async context => {
  const db = globalThis.__voiceTestDb
  const previousAdmin = process.env.ADMIN_EMAIL
  process.env.ADMIN_EMAIL = 'admin@example.test'
  context.after(() => {
    globalThis.__voiceTestDb = db
    if (previousAdmin === undefined) delete process.env.ADMIN_EMAIL
    else process.env.ADMIN_EMAIL = previousAdmin
  })

  let saved = null
  let voiceUrl = 'https://demo.twilio.com/welcome/voice/'
  let voiceMethod = 'GET'
  let updates = 0
  let writes = 0
  const sid = 'PN' + '1'.repeat(32)
  const owned = () => ({ sid, account_sid: account, phone_number: ingress, voice_url: voiceUrl,
    voice_method: voiceMethod, capabilities: { voice: true } })
  const proposed = { ingress_number: ingress, ai_number: ai, human_number: human, business_number: business }

  globalThis.__voiceTestDb = {
    auth: { getUser: async () => ({ data: { user: { email: 'admin@example.test' } }, error: null }) },
    async rpc(name, { p_number }) {
      assert.equal(name, 'recepta_voice_number_kind')
      return { data: saved && p_number === ingress ? 'ingress' : null, error: null }
    },
    from(table) {
      let operation, values
      const selectData = () => ({
        clients: { deletion_pending: false },
        agents: { phone_number: ai, retell_agent_id: 'agent_test' },
        agent_phone_numbers: null,
        inbound_phone_routes: saved,
      })[table]
      const selectOne = () => {
        if (operation) { writes++; saved = { ...saved, ...values } }
        return { data: selectData(), error: null }
      }
      const query = {
        select: () => query, eq: () => query,
        insert: row => { operation = 'insert'; values = row; return query },
        update: row => { operation = 'update'; values = row; return query },
        maybeSingle: selectOne, single: selectOne,
      }
      return query
    },
  }
  context.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    const provider = new URL(endpoint)
    if (provider.hostname === 'api.retellai.com') {
      assert.equal(options.headers.Authorization, 'Bearer ' + process.env.RETELL_STAGING_API_KEY)
      assert.equal(options.method, undefined)
      return Response.json({ phone_number: ai, inbound_webhook_url: origin + '/.netlify/functions/retell-inbound' })
    }
    assert.equal(provider.hostname, 'api.twilio.com')
    if (provider.pathname.endsWith('/IncomingPhoneNumbers.json')) {
      assert.equal(provider.searchParams.get('PhoneNumber'), ingress)
      assert.equal(options.method, undefined)
      return Response.json({ incoming_phone_numbers: [owned()] })
    }
    assert.equal(provider.pathname, '/2010-04-01/Accounts/' + account + '/IncomingPhoneNumbers/' + sid + '.json')
    assert.equal(options.method, 'POST')
    assert.deepEqual(Object.fromEntries(options.body), { VoiceUrl: url, VoiceMethod: 'POST' })
    updates++
    voiceUrl = url
    voiceMethod = 'POST'
    throw new Error('Timeout after provider applied the change')
  })

  const request = (route) => new Request(origin + '/.netlify/functions/admin-inbound-route?clientId=' + clientId, {
    method: 'POST', headers: { Authorization: 'Bearer admin-test-token' }, body: JSON.stringify(route),
  })

  const rejected = await adminRoute(request({ ...proposed, business_number: human }))
  assert.equal(rejected.status, 400)
  assert.equal(writes, 0)
  assert.equal(updates, 0)

  const uncertain = await adminRoute(request(proposed))
  assert.equal(uncertain.status, 502)
  assert.deepEqual(saved, { ...proposed, client_id: clientId })
  assert.equal(updates, 1)

  const retried = await adminRoute(request(proposed))
  assert.equal(retried.status, 200)
  assert.equal(updates, 1)
})
