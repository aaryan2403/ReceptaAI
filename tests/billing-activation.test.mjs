import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

// Production handlers and real PostgreSQL, synthetic auth/Stripe/Retell only.
// These tests never charge a card, buy a number, send mail or change live data.
const client = '00000000-0000-0000-0000-000000000001'
const newClient = '00000000-0000-0000-0000-000000000002'
let db, checkoutBody, event, stripeCalls
const period = { start: Math.floor(Date.now() / 1000) - 3600, end: Math.floor(Date.now() / 1000) + 29 * 86400 }
const quote = name => '"' + name.replaceAll('"', '""') + '"'
const query = table => {
  let action = 'read', values, single = false, conflict
  const filters = []
  const execute = async () => {
    try {
      let rows
      if (action === 'insert' || action === 'upsert') {
        const entries = Array.isArray(values) ? values : [values]
        rows = []
        for (const row of entries) {
          const keys = Object.keys(row)
          const sql = `insert into ${quote(table)} (${keys.map(quote).join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) ${conflict ? `on conflict (${quote(conflict)}) do nothing` : ''} returning *`
          rows.push(...(await db.query(sql, keys.map(key => row[key]))).rows)
        }
      } else if (action === 'update' || action === 'delete') {
        const keys = Object.keys(values ?? {})
        const params = action === 'update' ? keys.map(key => values[key]) : []
        const clauses = filters.map(([column, value]) => { params.push(value); return `${quote(column)}=$${params.length}` })
        const sql = action === 'update' ? `update ${quote(table)} set ${keys.map((key, i) => `${quote(key)}=$${i + 1}`).join(',')}` : `delete from ${quote(table)}`
        rows = (await db.query(sql + (clauses.length ? ' where ' + clauses.join(' and ') : '') + ' returning *', params)).rows
      } else {
        rows = (await db.query(`select * from ${quote(table)}`)).rows
        for (const [key, value] of filters) rows = rows.filter(row => row[key] === value)
      }
      return { data: single ? rows[0] ?? null : rows, error: null }
    } catch (error) { return { data: null, error: { message: error.message } } }
  }
  const api = {
    select: () => api, order: () => api, limit: () => api,
    eq: (column, value) => { filters.push([column, value]); return api },
    insert: value => { action = 'insert'; values = value; return api },
    upsert: (value, options) => { action = 'upsert'; values = value; conflict = options?.onConflict ?? 'notification_key'; return api },
    update: value => { action = 'update'; values = value; return api }, delete: () => { action = 'delete'; return api },
    maybeSingle: () => { single = true; return execute() }, single: () => { single = true; return execute() },
    then: (a, b) => execute().then(a, b),
  }
  return api
}
globalThis.__paymentDb = {
  auth: {
    getUser: async token => ({ data: { user: { id: token === 'admin' ? 'admin' : client, email: token === 'admin' ? 'admin@example.test' : 'owner@example.test' } }, error: null }),
    admin: {
      createUser: async () => ({ data: { user: { id: newClient } }, error: null }),
      getUserById: async () => ({ data: { user: { email: 'owner@example.test', user_metadata: {} } }, error: null }),
      updateUserById: async () => ({ data: {}, error: null }),
      deleteUser: async () => ({ error: null }),
    },
  }, from: query,
  rpc: async (name, args) => {
    try {
      if (name === 'claim_recepta_service_jobs') return { data: (await db.query("update service_jobs set status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',attempts=attempts+1 where job_key=$1 and status='queued' returning *", [args.p_key])).rows, error:null }
      if (name === 'finish_recepta_service_job') {
        await db.query("update service_jobs set status=case when $2::text is null then 'complete' else 'queued' end,last_error=$2,lease_token=null where job_key=$1", [args.p_key,args.p_error])
        return { data:true,error:null }
      }
      if (name === 'configure_recepta_subscription') return { data: (await db.query('select * from configure_recepta_subscription($1,$2)', [args.p_client_id, args.p_configuration])).rows, error: null }
      if (name === 'activate_recepta_checkout') return { data: (await db.query('select * from activate_recepta_checkout($1,$2,$3,$4,$5,$6,$7)', [args.p_client_id, args.p_stripe_subscription_id, args.p_customer_id, args.p_period_start, args.p_period_end, args.p_configuration, args.p_replaces_subscription_id])).rows, error: null }
      if (name === 'recepta_service_access') return { data: (await db.query('select recepta_service_access($1) access', [args.p_client])).rows[0].access, error: null }
      const provisioning = {
        recepta_pro_begin_checkout: ['p_client','p_until'],
        recepta_queue_provisioning: ['p_client','p_purchase','p_country','p_area'],
        recepta_provisioning_candidate: ['p_client','p_allow_paid'],
        recepta_complete_provisioning: ['p_client','p_lease','p_agent','p_phone_numbers'],
        recepta_resume_provisioning: ['p_client','p_allow_paid'],
      }[name]
      if (provisioning) return { data: (await db.query(
        'select ' + name + '(' + provisioning.map((_,index) => '$' + (index + 1)).join(',') + ') result',
        provisioning.map(field => args[field] ?? (field === 'p_allow_paid' ? false : null)))).rows[0].result, error: null }
      if (name === 'recepta_period_usage') return { data: (await db.query('select recepta_period_usage($1,$2,$3) used', [args.p_client_id, args.p_period_start, args.p_period_end])).rows[0].used, error: null }
      throw new Error('Unexpected RPC: ' + name)
    } catch (error) { return { data: null, error: { message: error.message } } }
  },
}
globalThis.__paymentStripe = class {
  customers = { create: async () => { stripeCalls.push('customer-create'); return { id: 'cus_new' } }, del: async () => {} }
  checkout = { sessions: { create: async body => { checkoutBody = body; return { url: 'https://checkout.stripe.test/synthetic' } } } }
  webhooks = { constructEvent: () => event }
  subscriptions = {
    retrieve: async id => ({ id, status: 'active' }),
    cancel: async () => { stripeCalls.push('subscription-cancel') },
  }
  invoices = {
    retrieve: async id => ({ id, status: 'paid', hosted_invoice_url: 'https://invoice.stripe.test/synthetic' }),
    listLineItems: async () => ({ data: [{ period, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_after_payment', proration: false } } }] }),
  }
}
const compile = async file => {
  const output = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false, plugins: [{ name: 'synthetic-services', setup(b) {
    b.onResolve({ filter: /^(stripe|@supabase\/supabase-js)$/ }, a => ({ path: a.path, namespace: 'mock' }))
    b.onResolve({ filter: /^(?:\.\.\/lib\/retell|\.\/retell)$/ }, () => ({ path: 'retell', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ loader: 'js', contents: a.path === 'stripe' ? 'export default globalThis.__paymentStripe' : a.path === 'retell' ? `
      export const assertRetellAgentAvailable = async () => {};
      export const findProvisionedRetellPhone = async () => globalThis.__paymentRecoveredPhone ?? null;
      export const getPublishedRetellAgent = async () => {};
      export const syncManagedRetellInboundRoute = async () => {};
      export const inspectRetellAppointments = async () => {};
      export const inspectRetellPhoneRoute = async () => {};
      export const normalizeE164 = value => value;
      export const receptaRetellOrigin = () => 'https://recepta.test';
      export class RetellSetupError extends Error {}
      export const retellScheduleSyncMessage = error => error.message;
      export const normalizeEmailNotificationsEnabled = value => value !== false;
      export const normalizeSmsNotificationsEnabled = value => value === true;
      export const normalizeAppointmentFields = value => Array.isArray(value) ? value : [];
      export const syncRetellSchedule = async options => { if(globalThis.__paymentProvisionError) throw new Error(globalThis.__paymentProvisionError); globalThis.__paymentRetell.push({ kind:'schedule', ...options }); return { agentUpdated:true } };
      export const syncRetellSubscription = async options => { globalThis.__paymentRetell.push({ kind:'subscription', ...options }); return { agentUpdated:options.active } };
      export const syncRetellPhoneBindings = async options => { globalThis.__paymentRetell.push({ kind:'binding', ...options }); return [] };
      export const purchaseRetellPhoneNumber = async options => { globalThis.__paymentRetell.push({ kind:'purchase', ...options }); return '+14165550999' };
      export const releaseRetellPhoneNumber = async () => {};
    ` : 'export const createClient = () => globalThis.__paymentDb' }))
  } }] })
  return (await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))).default
}
process.env.ADMIN_EMAIL = 'admin@example.test'
process.env.SUPABASE_URL = 'https://synthetic.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-only'
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic'
process.env.RETELL_API_KEY = 'synthetic-only'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic'
process.env.RECEPTA_APP_URL = 'https://recepta.test'
delete process.env.RESEND_API_KEY
const create = await compile('netlify/functions/create-client.ts')
const edit = await compile('netlify/functions/update-clients.ts')
const worker = await compile('netlify/functions/provision-pro-background.ts')
const checkout = await compile('netlify/functions/create-checkout-session.ts')
const webhook = await compile('netlify/functions/stripe-webhook.ts')
const phones = await compile('netlify/functions/admin-purchase-phone-numbers.ts')
const legacy = await compile('netlify/functions/update-client-plan.ts')
const assignAgent = await compile('netlify/functions/update-client-agent.ts')
const request = (body, admin = true) => new Request('https://recepta.test', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin ? 'admin' : 'customer'}`, Origin: 'https://recepta.test', 'stripe-signature': 'synthetic' }, body: JSON.stringify(body) })
const configuration = { plan_name: 'Recepta Standard', monthly_price: 207.02, monthly_minutes: 60, ai_model_id: 'essential', pii_redaction_enabled: false, safety_guardrails_enabled: false, extra_phone_numbers: 0 }
const editBody = { clientId: client, companyName: 'Synthetic company', email: 'owner@example.test', planName: 'Recepta Pro', monthlyMinutes: 1200, aiModelId: 'premium', retellAgentId: 'agent_test', phoneNumbers: ['+14165550100'], piiRedactionEnabled: true, safetyGuardrailsEnabled: true }
const sub = async id => (await db.query('select * from subscriptions where client_id=$1', [id ?? client])).rows[0]
const configure = async value => (await db.query('select * from configure_recepta_subscription($1,$2)', [client, value])).rows[0]
const fixture = async (paid = true) => {
  stripeCalls = []; checkoutBody = null; globalThis.__paymentRetell = []
  await db.exec('truncate recepta_demo_links, service_jobs, booking_settings, billing_notifications, call_minute_reservations, calls, agent_phone_numbers, agents, subscriptions, clients cascade')
  await db.query("insert into clients(id,company_name,contact_email,status,role) values($1,'Synthetic company','owner@example.test','live','client')", [client])
  await db.query(`insert into subscriptions(client_id,plan_name,monthly_price,monthly_minutes,ai_model_id,pii_redaction_enabled,safety_guardrails_enabled,extra_phone_numbers,status,stripe_subscription_id,stripe_customer_id,current_period_start,current_period_end)
    values($1,'Recepta Standard',207.02,60,'essential',false,false,0,$2,$3,'cus_original',$4,$5)`, [client, paid ? 'active' : 'pending', paid ? 'sub_original' : null, paid ? new Date(Date.now() - 86400000).toISOString() : null, paid ? new Date(Date.now() + 29 * 86400000).toISOString() : null])
  await db.query("insert into agents(client_id,retell_agent_id,phone_number,status,business_hours) values($1,'agent_test','+14165550100',$2,null)", [client, paid ? 'live' : 'setup'])
  await db.query("insert into agent_phone_numbers values($1,'+14165550100',true,'manual',now())", [client])
}
const installSchema = async (database, createRoles = true) => {
  if (createRoles) await database.exec('create role anon; create role authenticated; create role service_role bypassrls;')
  await database.exec(`alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create table clients(id uuid primary key,company_name text,contact_email text,status text,role text,deletion_pending boolean not null default false);
    create table subscriptions(id uuid primary key default gen_random_uuid(),client_id uuid unique references clients,
      plan_name text,monthly_price numeric,monthly_minutes integer default 300,ai_model_id text,
      pii_redaction_enabled boolean default false,safety_guardrails_enabled boolean default false,extra_phone_numbers integer default 0,
      status text default 'pending',stripe_subscription_id text,stripe_customer_id text,current_period_start timestamptz,current_period_end timestamptz,next_billing_date timestamptz);
    create table agents(client_id uuid primary key,retell_agent_id text,agent_name text,phone_number text,business_hours text,status text);
    create table agent_phone_numbers(client_id uuid,phone_number text,is_primary boolean,source text,created_at timestamptz default now());
    create table calls(id uuid primary key default gen_random_uuid(),client_id uuid,retell_call_id text,call_status text,duration_seconds integer,started_at timestamptz,ended_at timestamptz);
    create table employees(id uuid,client_id uuid,name text,role text,is_active boolean,created_at timestamptz);
    create table booking_settings(client_id uuid primary key,enabled boolean,capacity integer,duration_minutes integer,
      buffer_minutes integer,start_interval_minutes integer,time_zone text,hourly_limit integer,weekly jsonb,exceptions jsonb,
      email_owner boolean,email_customer boolean,sync_agent_id text,synced_at timestamptz);
    create table service_jobs(job_key text primary key,client_id uuid,kind text check(kind in ('callback_email','delete_client','retention_call','appointment_email')),
      payload jsonb,status text default 'queued',next_attempt_at timestamptz default now(),attempts integer default 0,
      last_error text,lease_token uuid,lease_expires_at timestamptz,completed_at timestamptz);
    create table employee_schedules(employee_id uuid,day_of_week integer,is_working boolean,start_time text,end_time text);
    create table ai_models(id text,customer_price_per_minute_cad numeric,is_active boolean,display_name text);
    insert into ai_models values('essential',0.117,true,'Essential'),('premium',0.217,true,'Premium');`)
  for (const path of ['supabase_add_minute_enforcement.sql','supabase_add_billing_notifications.sql','supabase/migrations/20261014192813_align_minute_enforcement.sql','supabase/migrations/20261014201359_demo_only_call_limit.sql','supabase/migrations/20261016145008_payment_controlled_activation.sql',
    'supabase/migrations/20261116113500_internal_appointment_test_entitlement.sql',
    'supabase/migrations/20261117071812_owner_appointment_booking_access.sql',
    'supabase/migrations/20261117083000_founder_metered_inbound_calls.sql',
    'supabase/migrations/20261119185856_admin_service_access.sql',
    'supabase/migrations/20261119204250_admin_client_status.sql',
    'supabase/migrations/20261120072445_automatic_pro_onboarding.sql',
    'supabase/migrations/20261014205655_shareable_demo_links.sql']) await database.exec(await readFile(path,'utf8'))
  await database.exec('alter table billing_notifications add column delivery_status text')
  await database.exec(await readFile('supabase/migrations/20261120080302_pro_service_lifecycle.sql','utf8'))
  await database.exec(await readFile('supabase/migrations/20261124062904_protect_paid_renewal_order.sql','utf8'))
}
test.before(async () => {
  db = new PGlite()
  await installSchema(db)
})
test.after(async () => { await db.close() })

test('new clients are pending, without a paid period or phone purchases, even when numbers are requested', async () => {
  await fixture()
  const response = await create(request({ companyName: 'New company', email: 'new@example.test', password: 'synthetic-only-password', planName: 'Recepta Standard', monthlyMinutes: 300, aiModelId: 'essential', retellAgentId: 'agent_new', purchasePhoneNumbers: 2, phoneCountryCode: 'CA' }))
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const created = await sub(newClient)
  assert.equal(created.status, 'pending'); assert.equal(created.current_period_start, null); assert.equal(created.current_period_end, null)
  assert.equal(created.pending_configuration.extra_phone_numbers, 1)
  assert.equal(Number(created.pending_configuration.monthly_price), 254.1)
  assert.equal((await db.query('select status from agents where client_id=$1',[newClient])).rows[0].status, 'setup')
  assert.equal(globalThis.__paymentRetell.some(call => call.kind === 'purchase' || call.active === true), false)
  assert.equal((await response.json()).paymentRequired, true)
})

test('admin upgrades are quotes: paid allowance, period, subscription and live AI settings stay unchanged', async () => {
  await fixture()
  const before = await sub()
  const response = await edit(request(editBody))
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const after = await sub()
  for (const key of ['plan_name','monthly_price','monthly_minutes','ai_model_id','stripe_subscription_id','status','current_period_start','current_period_end']) assert.deepEqual(after[key], before[key], key)
  assert.equal(after.pending_configuration.plan_name, 'Recepta Pro')
  assert.equal(after.pending_configuration.monthly_minutes, 1200)
  assert.equal((await response.json()).paymentRequired, true)
  const sync = globalThis.__paymentRetell.find(call => call.kind === 'subscription')
  assert.equal(sync.aiModelId, 'essential'); assert.equal(sync.piiRedactionEnabled, false)
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'before_upgrade','agent_test')",[client])).rows[0].reserved_seconds, 3600)
})

test('reactivation and legacy plan updates cannot grant unpaid access', async () => {
  await fixture()
  await db.exec("update subscriptions set status='cancelled'")
  const before = await sub()
  assert.equal((await edit(request({ ...editBody, reactivateSubscription: true }))).status, 409)
  assert.deepEqual(await sub(), before)
  assert.equal((await legacy(request(editBody))).status, 410)
  assert.deepEqual(await sub(), before)
  const configured = await configure({ ...configuration, monthly_minutes: 300, monthly_price: 234.1 })
  assert.equal(configured.status, 'cancelled')
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'cancelled','agent_test')",[client])).rows.length, 0)
})

test('additional numbers prepare a complete quote and do not purchase, assign or change paid extras', async () => {
  await fixture()
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  const response = await phones(request({ clientId: client, quantity: 2, countryCode: 'CA' }))
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.paymentRequired, true); assert.deepEqual(result.purchasedPhoneNumbers, [])
  const after = await sub()
  assert.equal(after.extra_phone_numbers, 0); assert.equal(after.pending_configuration.extra_phone_numbers, 2)
  assert.equal(after.pending_configuration.plan_name, 'Recepta Pro')
  assert.equal(Number(after.pending_configuration.monthly_price), 346.02)
  assert.equal(globalThis.__paymentRetell.length, 0); assert.equal(stripeCalls.length, 0)
  assert.equal((await db.query('select count(*) as n from agent_phone_numbers')).rows[0].n, 1)
})

test('Checkout uses the server quote, ignores browser plan/add-ons, and permits a same-minute paid upgrade', async () => {
  await fixture()
  const configured = await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  const response = await checkout(request({ monthlyMinutes: 60, planName: 'Recepta Standard', aiModelId: 'essential', extraPhoneNumbers: 20 }, false))
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal(checkoutBody.metadata.plan_name, 'Recepta Pro')
  assert.equal(checkoutBody.metadata.extra_phone_numbers, '0')
  assert.equal(checkoutBody.metadata.base_price_cad, '299')
  assert.equal(checkoutBody.metadata.monthly_total_cad, '306.02')
  assert.equal(checkoutBody.metadata.quote_revision, String(configured.configuration_revision))
  assert.equal(checkoutBody.line_items[0].price_data.unit_amount, 30602)
  assert.equal((await sub()).plan_name, 'Recepta Standard')
})

test('unpaid Checkout stays pending; verified paid Checkout applies exactly once and clears its quote', async () => {
  await fixture(false)
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  assert.equal((await checkout(request({ monthlyMinutes: 60 }, false))).status, 200)
  event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'unpaid', subscription: 'sub_after_payment', customer: 'cus_original', invoice: 'in_synthetic', metadata: checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status, 200)
  assert.equal((await sub()).status, 'pending')
  event.data.object.payment_status = 'paid'
  assert.equal((await webhook(request({}))).status, 200)
  const paid = await sub()
  assert.equal(paid.status, 'active'); assert.equal(paid.stripe_subscription_id, 'sub_after_payment')
  assert.equal(paid.plan_name, 'Recepta Pro'); assert.equal(paid.pending_configuration, null)
  assert.ok(globalThis.__paymentRetell.some(call => call.kind === 'schedule' && call.appointmentScheduling && call.schedulingOnly))
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'paid','agent_test')",[client])).rows.length, 1)
  assert.equal((await webhook(request({}))).status, 200)
  assert.deepEqual(await sub(), paid)
})

test('a newer quote survives an older paid Checkout and payment replay cannot erase it', async () => {
  await fixture()
  const older = await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  await configure({ ...configuration, monthly_minutes: 300, monthly_price: 234.1 })
  const activate = () => db.query('select * from activate_recepta_checkout($1,$2,$3,$4,$5,$6,$7)', [client,'sub_after_payment','cus_original',new Date(period.start*1000),new Date(period.end*1000),{ ...older.pending_configuration, quote_revision: String(older.configuration_revision) },'sub_original'])
  assert.equal((await activate()).rows[0].plan_name, 'Recepta Pro')
  assert.equal((await sub()).pending_configuration.monthly_minutes, 300)
  await activate()
  assert.equal((await sub()).pending_configuration.monthly_minutes, 300)
})

test('a regular paid renewal preserves the pending quote and renews only the paid configuration', async () => {
  await fixture()
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_minutes: 1200 })
  const before = await sub()
  const end = new Date(Date.parse(before.current_period_end) + 30 * 86400000).toISOString()
  await db.query('select * from renew_recepta_subscription($1,$2,$3)', ['sub_original', before.current_period_end, end])
  const after = await sub()
  assert.equal(after.monthly_minutes, 60)
  assert.equal(after.plan_name, 'Recepta Standard')
  assert.equal(after.monthly_price, before.monthly_price)
  assert.deepEqual(after.pending_configuration, before.pending_configuration)
  assert.equal(after.configuration_revision, before.configuration_revision)
})

test('assigning a Retell agent activates provider settings only for a currently paid account', async () => {
  for (const paid of [false, true]) {
    await fixture(paid)
    const response = await assignAgent(request({ clientId: client, retellAgentId: 'agent_new' }))
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(globalThis.__paymentRetell.find(operation => operation.kind === 'subscription').active, paid)
    assert.equal((await sub()).status, paid ? 'active' : 'pending')
  }
})

test('quotes cannot set payment fields; public roles cannot configure; active accounts require a Stripe subscription', async () => {
  await fixture(false)
  await assert.rejects(() => db.exec("update subscriptions set status='active'"), /active_subscription_requires_payment/)
  await assert.rejects(() => configure({ ...configuration, status: 'active', stripe_subscription_id: 'fake' }), /Only billing configuration/)
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'unpaid','agent_test')",[client])).rows.length, 0)
  for (const role of ['anon','authenticated']) {
    assert.equal((await db.query("select has_function_privilege($1,'public.configure_recepta_subscription(uuid,jsonb)','execute') as can_configure",[role])).rows[0].can_configure, false)
  }
  assert.equal((await edit(request(editBody,false))).status, 403)
  assert.equal((await phones(request({ clientId: client, quantity: 1 },false))).status, 403)
})

test('Stripe records verified payment while preserving manual access and explicit pauses', async () => {
  await fixture(false)
  const admin = '00000000-0000-0000-0000-000000000010'
  const authorize = (action, mode, revision) => db.query(`select recepta_save_service_access(
    $1,$2,$3,$4,'Recepta Standard','agent_test','Test access',now()+interval '1 day',60,$5) as access`, [client, admin, action, mode, revision])
  const effective = async () => (await db.query('select recepta_service_access($1) as access', [client])).rows[0].access

  assert.equal((await authorize('activate_test', null, 0)).rows[0].access.source, 'internal_test')
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  assert.equal((await checkout(request({ monthlyMinutes: 60 }, false))).status, 200)
  event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid',
    subscription: 'sub_after_payment', customer: 'cus_original', invoice: 'in_synthetic', metadata: checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status, 200)
  assert.equal((await sub()).status, 'active')
  assert.equal((await effective()).source, 'internal_test')
  assert.equal((await effective()).plan, 'Recepta Standard')
  assert.equal((await effective()).appointments, false)

  await authorize('pause', null, 1)
  assert.equal((await webhook(request({}))).status, 200)
  assert.equal((await effective()).status, 'paused')
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'paused-call','agent_test')", [client])).rows.length, 0)
  assert.equal((await effective()).appointments, false)
  await authorize('save', 'automatic', 2)
  assert.equal((await effective()).source, 'stripe')
  assert.equal((await effective()).status, 'active')
  assert.equal((await effective()).appointments, true)
})

test('Stripe cancellation keeps an existing Retell number and pauses even a current manual grant', async () => {
  await fixture()
  await db.query("update agent_phone_numbers set source='retell' where client_id=$1", [client])
  const admin = '00000000-0000-0000-0000-000000000010'
  await db.query(`select recepta_save_service_access(
    $1,$2,'save','manual','Recepta Pro','agent_test','Authorized internal customer',
    now()+interval '1 day',null,0) as access`, [client, admin])
  event = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_original' } } }

  const response = await webhook(request({}))
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await sub()).status, 'cancelled')
  assert.equal((await db.query('select phone_number from agent_phone_numbers where client_id=$1', [client])).rows[0].phone_number, '+14165550100')
  assert.equal(globalThis.__paymentRetell.length, 0)
  const after = (await db.query('select recepta_service_access($1) as access', [client])).rows[0].access
  assert.equal(after.reason, 'subscription_cancelled')
  assert.equal(after.status, 'paused')
  assert.equal(after.appointments, false)
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'manual-paid-ended','agent_test')", [client])).rows.length, 0)
})

test('Stripe checkout honors an explicit agent pause and an independently selected service plan', async () => {
  await fixture(false)
  const actor = '00000000-0000-0000-0000-000000000010'
  await db.query(`select recepta_manage_client_service($1,$2,'save','automatic','Recepta Standard',
    'agent_test',null,null,null,0,'paused')`, [client, actor])
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  assert.equal((await checkout(request({ monthlyMinutes: 60 }, false))).status, 200)
  event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid',
    subscription: 'sub_after_payment', customer: 'cus_original', invoice: 'in_synthetic', metadata: checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status, 200)
  const after = (await db.query('select recepta_service_access($1) as access', [client])).rows[0].access
  assert.equal(after.billing_status, 'active')
  assert.equal(after.billing_plan, 'Recepta Pro')
  assert.equal(after.plan, 'Recepta Standard')
  assert.equal(after.agent_status, 'paused')
  assert.equal(after.reason, 'agent_paused')
  assert.equal(after.can_reserve, false)
  assert.equal(after.appointments, false)
  assert.equal(globalThis.__paymentRetell.some(call => call.appointmentScheduling), false)
})

test('Pro Add Client queues verified provisioning with no Stripe payment; retry recovers a provisioned line', async () => {
  await fixture(false)
  const originalFetch = globalThis.fetch
  const start = []
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('provision-pro-background')) {
      start.push(JSON.parse(options.body))
      return new Response(null, { status: 202 })
    }
    throw new Error('Unexpected external request: ' + url)
  }
  globalThis.__paymentRecoveredPhone = '+14165550998'
  try {
    const response = await create(request({
      companyName: 'Automatic Pro', email: 'onboarding@example.test', password: 'example-only',
      planName: 'Recepta Pro', monthlyMinutes: 2, aiModelId: 'essential',
      retellAgentId: 'agent_pro_onboarding', purchasePhoneNumbers: 1, phoneCountryCode: 'CA',
      storeHours: { mode: 'custom', timeZone: 'America/Toronto', answeringMode: '24/7',
        hours: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
          .map(day => ({ day, open: true, start: '09:00', end: '17:00' })) },
    }))
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).aiConfigurationStatus, 'queued')
    assert.deepEqual(start, [{ clientId: newClient }])
    assert.deepEqual(stripeCalls, [])
    const access = async () => (await db.query('select recepta_service_access($1) access', [newClient])).rows[0].access
    assert.equal((await access()).reason, 'provisioning')
    const reserve = id => db.query('select * from reserve_recepta_agent_call($1,$2,$3)', [newClient, id, 'agent_pro_onboarding'])
    assert.equal((await reserve('before-pro-setup')).rows.length, 0)
    assert.equal((await worker(request({ clientId: newClient }, false))).status, 403)
    globalThis.__paymentProvisionError = 'Synthetic Retell publish timeout'
    assert.equal((await worker(request({ clientId: newClient }))).status, 204)
    assert.equal((await access()).reason, 'provisioning')
    assert.equal((await access()).provisioning_error, 'Synthetic Retell publish timeout')
    assert.equal((await reserve('retry-still-pending')).rows.length, 0)
    delete globalThis.__paymentProvisionError
    assert.equal((await worker(request({ clientId: newClient }))).status, 204)
    const live = await access()
    assert.equal(live.reason, 'ready')
    assert.equal(live.source, 'automatic_pro')
    assert.equal(live.service_status, 'ongoing')
    assert.equal(Date.parse(live.payment_grace_ends_at)-Date.parse(live.period_start), 30*86400*1000)
    assert.equal(live.agent_status, 'live')
    assert.equal(live.billing_status, 'pending')
    assert.equal((await sub(newClient)).stripe_subscription_id, null)
    assert.equal((await sub(newClient)).stripe_customer_id, null)
    assert.equal(globalThis.__paymentRetell.some(call => call.kind === 'purchase'), false)
    assert.equal(live.phone_number, '+14165550998')
    assert.equal((await db.query('select enabled from booking_settings where client_id=$1', [newClient])).rows[0].enabled, true)
    const admitted = await reserve('approved-pro-setup')
    assert.equal(admitted.rows[0].reserved_seconds, 120)
    assert.equal((await reserve('exhausted-pro-setup')).rows.length, 0)
    assert.equal((await db.query("select recepta_authorize_appointment_tool($1,$2,$3,'recepta_check_availability') as result",
      [newClient, 'agent_pro_onboarding', 'approved-pro-setup'])).rows[0].result.allowed, true)
    assert.equal((await db.query('select recepta_grant_call_plan($1,$2) plan', [newClient, 'approved-pro-setup'])).rows[0].plan, 'Recepta Pro')
    assert.equal((await worker(request({ clientId: newClient }))).status, 204)
    assert.equal(globalThis.__paymentRetell.filter(call => call.kind === 'schedule').length, 1)
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis.__paymentRecoveredPhone
    delete globalThis.__paymentProvisionError
  }
})

test('existing pending Pro clients can be provisioned; holds and cancellations stay ineligible', async () => {
  await fixture(false)
  await db.query("update subscriptions set plan_name='Recepta Pro' where client_id=$1", [client])
  const enqueue = () => db.query("select recepta_queue_provisioning($1) as job", [client])
  const actor = '00000000-0000-0000-0000-000000000010'
  await db.query("select recepta_manage_client_service($1,$2,'save','suspended',null,null,null,null,null,0,null)", [client, actor])
  assert.equal((await enqueue()).rows[0].job, null)
  await db.query("select recepta_manage_client_service($1,$2,'save','automatic',null,null,null,null,null,1,null)", [client, actor])
  await db.query("update subscriptions set status='cancelled' where client_id=$1", [client])
  assert.equal((await enqueue()).rows[0].job, null)
  await db.query("update subscriptions set status='pending',pro_cancelled_at=null where client_id=$1", [client])
  assert.equal((await enqueue()).rows[0].job, 'provision-pro:' + client)
  assert.equal((await worker(request({ clientId: client }))).status, 204)
  assert.equal((await db.query('select recepta_service_access($1) access',[client])).rows[0].access.source, 'automatic_pro')
  assert.equal(globalThis.__paymentRetell.some(item => item.kind === 'purchase'), false)
})

test('scheduled Pro cancellation gates calls at the cutoff and paid resubscription reuses Retell', async () => {
  await fixture()
  await db.query("update subscriptions set plan_name='Recepta Pro',cancel_at_period_end=true,provider_cancel_at=now()+interval '1 day' where client_id=$1", [client])
  const get = async () => (await db.query('select recepta_service_access($1) access', [client])).rows[0].access
  assert.equal((await get()).can_reserve, true)
  await db.query("update subscriptions set provider_cancel_at=now()-interval '1 second' where client_id=$1", [client])
  assert.equal((await get()).reason, 'subscription_cancelled')
  assert.equal((await get()).appointments, false)
  event = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_original' } } }
  assert.equal((await webhook(request({}))).status, 200)
  const agent = (await db.query('select * from agents where client_id=$1', [client])).rows[0]
  assert.equal(agent.status, 'live')
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  assert.equal((await checkout(request({ monthlyMinutes: 60 }, false))).status, 200)
  event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid',
    subscription: 'sub_after_payment', customer: 'cus_original', invoice: 'in_synthetic', metadata: checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status, 200)
  assert.equal((await get()).reason, 'ready')
  assert.equal((await get()).appointments, true)
  assert.equal((await sub()).provider_cancel_at, null)
  assert.deepEqual((await db.query('select * from agents where client_id=$1', [client])).rows[0], agent)
  assert.deepEqual(globalThis.__paymentRetell, [])
  assert.equal((await webhook(request({}))).status, 200)
  assert.deepEqual(globalThis.__paymentRetell, [])
})

test('successful Stripe Checkout records payment without overriding an explicit service hold', async () => {
  await fixture(false)
  await configure({ ...configuration, plan_name: 'Recepta Pro', monthly_price: 306.02 })
  const actor = '00000000-0000-0000-0000-000000000010'
  await db.query("select recepta_manage_client_service($1,$2,'save','suspended',null,null,null,null,null,0,null)", [client, actor])
  assert.equal((await checkout(request({ monthlyMinutes: 60 }, false))).status, 200)
  event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'paid',
    subscription: 'sub_after_payment', customer: 'cus_original', invoice: 'in_synthetic', metadata: checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status, 200)
  assert.equal((await sub()).status, 'active')
  const access = (await db.query('select recepta_service_access($1) access', [client])).rows[0].access
  assert.equal(access.status, 'suspended')
  assert.equal(access.can_reserve, false)
  assert.equal(access.appointments, false)
  assert.deepEqual(globalThis.__paymentRetell, [])
})

const proAccess = async () => (await db.query('select recepta_service_access($1) as access',[client])).rows[0].access
const selectPro = () => db.query("update subscriptions set plan_name='Recepta Pro' where client_id=$1", [client])
const claimLifecycle = async (agentId, operation) => (await db.query(
  'select recepta_pro_claim_lifecycle($1,$2,$3) result',[client,agentId,operation])).rows[0].result
const finishLifecycle = async (lease,result) => (await db.query(
  'select recepta_pro_finish_lifecycle($1,$2,$3,null) result',[client,lease,result])).rows[0].result
const retainNotice = () => db.query(`insert into billing_notifications(notification_key,client_id,kind,payload,sent_at)
  select recepta_pro_notice_key($1,recepta_pro_timeline($1)),$1,'agent_retention','{}',now()-interval '2 days'`,[client])
const adminPro = async (status,revision,deadline=null,reason=null) =>
  (await db.query("select recepta_manage_pro_service($1,$2,$3,$4,$5,$6,'agent_test') result",
    [client,'00000000-0000-0000-0000-000000000010',status,revision,deadline,reason])).rows[0].result

test('admin pause and resume keep the original capped grant and its deadline', async () => {
  await fixture(false)
  await selectPro()
  await db.query("update agents set status='live' where client_id=$1",[client])
  await db.query("insert into recepta_pro_authorizations(client_id,retell_agent_id,authorized_at) values($1,'agent_test',now()-interval '5 days')",[client])
  const ongoing = await proAccess()
  assert.equal(ongoing.service_status,'ongoing')
  assert.equal(ongoing.billing_status,'pending')
  assert.equal((await adminPro('paused',0)).service_status,'paused')
  assert.equal((await proAccess()).appointments,false)
  assert.equal((await db.query("select * from reserve_recepta_agent_call($1,'paused-pro','agent_test')",[client])).rows.length,0)
  const resumed = await adminPro('ongoing',1)
  assert.equal(resumed.service_status,'ongoing')
  assert.equal(resumed.grant_id,ongoing.grant_id)
  assert.equal(resumed.payment_grace_ends_at,ongoing.payment_grace_ends_at)
  assert.equal(resumed.agent_id,'agent_test')
  assert.equal(resumed.phone_number,'+14165550100')
  assert.equal((await db.query('select count(*)::int n from recepta_service_access_audit where client_id=$1',[client])).rows[0].n,2)
})

test('initial nonpayment expires the entitlement and deletion requires a confirmed, timely warning', async () => {
  await fixture(false)
  await selectPro()
  await db.query("update agents set status='live' where client_id=$1",[client])
  await db.query("insert into recepta_pro_authorizations(client_id,retell_agent_id,authorized_at) values($1,'agent_test',now()-interval '32 days')",[client])
  const expired = await proAccess()
  assert.equal(expired.service_status,'paused')
  assert.equal(expired.reason,'payment_grace_expired')
  assert.equal(expired.appointments,false)
  assert.equal(await claimLifecycle('agent_test','deleting'),null)
  await retainNotice()
  await db.query("update billing_notifications set delivery_status='bounced'")
  assert.equal(await claimLifecycle('agent_test','deleting'),null)
  await db.query("update billing_notifications set delivery_status='delivered'")
  const deletion = await claimLifecycle('agent_test','deleting')
  assert.notEqual(deletion,null)
  assert.equal(await claimLifecycle('agent_test','deleting'),null)
  assert.equal((await db.query('select recepta_pro_confirm_delete($1,$2) allowed',[client,deletion.lease])).rows[0].allowed,false)
  await db.query("update recepta_pro_lifecycle set backup='{ \"verified\": true }' where client_id=$1",[client])
  assert.equal((await db.query('select recepta_pro_confirm_delete($1,$2) allowed',[client,deletion.lease])).rows[0].allowed,true)
  assert.equal(await finishLifecycle(deletion.lease,'deleted'),true)
  assert.equal((await proAccess()).retention_operation,'deleted')
  assert.equal((await sub()).stripe_subscription_id,null)
  assert.equal((await db.query('select phone_number from agents where client_id=$1',[client])).rows[0].phone_number,'+14165550100')
  assert.equal((await db.query('select result from recepta_pro_lifecycle_audit where client_id=$1',[client])).rows[0].result.status,'deleted')
})

test('renewal grace uses the Stripe invoice due date and payment fences a queued deletion', async () => {
  await fixture()
  await selectPro()
  await db.query("update subscriptions set status='past_due',pro_invoice_id='in_due',pro_invoice_due_at=now()-interval '8 days' where client_id=$1",[client])
  const grace = await proAccess()
  assert.equal(grace.service_status,'ongoing')
  assert.equal(grace.billing_status,'past_due')
  assert.equal(Date.parse(grace.payment_grace_ends_at)-Date.parse(grace.retention_started_at),30*86400*1000)
  await db.query("update subscriptions set pro_invoice_due_at=now()-interval '32 days' where client_id=$1",[client])
  await retainNotice()
  const deletion = await claimLifecycle('agent_test','deleting')
  assert.notEqual(deletion,null)
  await db.query("update recepta_pro_lifecycle set backup='{}' where client_id=$1",[client])
  await db.query("update subscriptions set status='active' where client_id=$1",[client])
  assert.equal((await db.query('select recepta_pro_confirm_delete($1,$2) allowed',[client,deletion.lease])).rows[0].allowed,false)
  assert.equal(await finishLifecycle(deletion.lease,'cancelled'),true)
  const restored = await proAccess()
  assert.equal(restored.service_status,'ongoing')
  assert.equal(restored.payment_grace_ends_at,null)
  assert.equal(restored.agent_id,'agent_test')
})

test('cancelled customers keep their agent through retention and can restore a replacement after deletion', async () => {
  await fixture()
  await selectPro()
  await db.query("update subscriptions set status='cancelled',pro_cancelled_at=now()-interval '5 days' where client_id=$1",[client])
  const paused = await proAccess()
  assert.equal(paused.service_status,'paused')
  assert.equal(paused.retention_reason,'cancellation')
  assert.equal(paused.appointments,false)
  assert.equal(await claimLifecycle('agent_test','deleting'),null)
  const adjusted = await adminPro('deadline',0,new Date(Date.now()+20*86400*1000).toISOString(),'Retain through the customer’s review')
  assert.notEqual(adjusted.retention_deadline,paused.retention_deadline)
  await db.query("update subscriptions set pro_cancelled_at=now()-interval '31 days' where client_id=$1",[client])
  await retainNotice()
  await db.query("insert into recepta_demo_links(token_hash,label,retell_agent_id,agent_version) values(repeat('a',64),'Shared demo','agent_test',0)")
  assert.equal(await claimLifecycle('agent_test','deleting'),null)
  await db.query("update recepta_demo_links set revoked=true")
  const deletion = await claimLifecycle('agent_test','deleting')
  assert.notEqual(deletion,null)
  await db.query("update recepta_pro_lifecycle set backup='{}' where client_id=$1",[client])
  assert.equal(await finishLifecycle(deletion.lease,'deleted'),true)
  await configure({ ...configuration,plan_name:'Recepta Pro',monthly_price:306.02 })
  assert.equal((await checkout(request({ monthlyMinutes:60 },false))).status,200)
  event = { type:'checkout.session.completed',data:{ object:{ mode:'subscription',payment_status:'paid',
    subscription:'sub_after_payment',customer:'cus_original',invoice:'in_synthetic',metadata:checkoutBody.metadata } } }
  assert.equal((await webhook(request({}))).status,200)
  assert.equal((await sub()).status,'active')
  const recovery = await claimLifecycle(null,'restoring')
  assert.notEqual(recovery,null)
  await db.query("update recepta_pro_lifecycle set replacement_agent_id='agent_replacement' where client_id=$1",[client])
  assert.equal(await finishLifecycle(recovery.lease,'restored'),true)
  const revived = await proAccess()
  assert.equal(revived.service_status,'ongoing')
  assert.equal(revived.agent_id,'agent_replacement')
  assert.equal(revived.phone_number,'+14165550100')
})

test('a failed renewal stays frozen through reordered events and only the current paid invoice restores rollover', async () => {
  await fixture()
  const now = Date.now()
  const previous = new Date(now - 30 * 86400000).toISOString()
  const start = new Date(now - 300000).toISOString()
  const end = new Date(now + 30 * 86400000).toISOString()
  await db.query(`update subscriptions set current_period_start=$2, current_period_end=$3, rollover_seconds=900
    where client_id=$1`, [client, previous, start])
  await db.query(`insert into calls(client_id,retell_call_id,call_status,duration_seconds,started_at)
    values($1,'old-use','ended',1200,$2)`, [client, previous])
  const paid = (from, to) => db.query("select * from renew_recepta_subscription('sub_original',$1,$2)", [from, to])
  const failed = (from) => db.query("select * from freeze_recepta_renewal('sub_original',$1,'in_failed',$1)", [from])
  const reserve = (id) => db.query("select * from reserve_recepta_agent_call($1,$2,'agent_test')", [client, id])

  assert.equal((await reserve('expired')).rows.length, 0, 'unpaid budget cannot be used even with rollover')
  assert.equal((await failed(start)).rows[0].status, 'past_due')
  assert.equal((await sub()).rollover_seconds, 900, 'failure preserves the last paid allocation for recovery')
  assert.equal((await reserve('unpaid')).rows.length, 0)
  assert.equal((await paid(previous, start)).rows.length, 0, 'duplicate old payment cannot reactivate access')
  assert.equal((await paid(start, end)).rows[0].rollover_seconds, 3300)
  assert.equal((await paid(start, end)).rows[0].rollover_seconds, 3300, 'duplicate allocation is idempotent')
  assert.equal((await failed(start)).rows.length, 0, 'late failure cannot freeze the paid cycle')
  const first = (await reserve('after-recovery')).rows[0]
  assert.equal(first.reserved_seconds, 6900)
  await db.query(`insert into calls(client_id,retell_call_id,call_status,duration_seconds,started_at)
    values($1,'after-recovery','ended',4200,now())`, [client])
  assert.equal((await reserve('above-monthly-threshold')).rows[0].reserved_seconds, 2700)
  await db.query("update subscriptions set status='cancelled', rollover_seconds=0 where client_id=$1", [client])
  assert.equal((await paid(start, end)).rows.length, 0, 'a cancelled subscription cannot be reopened by invoice replay')
  assert.equal((await reserve('cancelled')).rows.length, 0)
  assert.equal((await sub()).rollover_seconds, 0)

  await db.exec('set role authenticated')
  try { await assert.rejects(failed(start), /permission denied/) }
  finally { await db.exec('reset role') }
})

const pgUrl = process.env.RECEPTA_TEST_PG_URL
test('independent PostgreSQL sessions cannot both reserve the last paid minute', { skip: !pgUrl }, async () => {
  const url = new URL(pgUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Billing concurrency tests require local PostgreSQL.')
  const { default: pg } = await import('pg')
  const admin = new pg.Client({ connectionString: url.href })
  await admin.connect()
  const databaseName = 'recepta_minutes_test_' + process.pid
  try {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
        await admin.query('create role ' + role + (role === 'service_role' ? ' bypassrls' : ''))
      }
    }
    await admin.query('create database ' + databaseName)
    url.pathname = '/' + databaseName
    const first = new pg.Client({ connectionString: url.href })
    const second = new pg.Client({ connectionString: url.href })
    try {
      await Promise.all([first.connect(), second.connect()])
      await installSchema({ exec: (sql) => first.query(sql) }, false)
      await first.query(`insert into clients(id,company_name,contact_email,status,role)
        values($1,'Synthetic business','local@example.test','live','client')`, [client])
      await first.query(`insert into subscriptions(client_id,plan_name,status,stripe_subscription_id,
        monthly_minutes,current_period_start,current_period_end)
        values($1,'Recepta Standard','active','sub_local',1,now()-interval '1 day',now()+interval '1 month')`, [client])
      await first.query("insert into agents(client_id,retell_agent_id,status) values($1,'agent_local','live')", [client])
      await first.query('begin')
      const reserve = (connection, callId) => connection.query("select * from reserve_recepta_agent_call($1,$2,'agent_local')", [client, callId])
      const winner = (await reserve(first, 'first')).rows[0]
      assert.equal(winner.reserved_seconds, 60)
      const competing = reserve(second, 'second')
      try {
        let blocked = false
        for (let attempt = 0; attempt < 50; attempt++) {
          const result = await admin.query("select wait_event_type from pg_stat_activity where pid=$1", [second.processID])
          if (result.rows[0]?.wait_event_type === 'Lock') { blocked = true; break }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked, true)
      } finally {
        await first.query('commit')
        assert.equal((await competing).rows.length, 0)
      }
      assert.equal((await reserve(second, 'first')).rows[0].reservation_id, winner.reservation_id)
      assert.equal((await first.query('select count(*)::int as total from call_minute_reservations')).rows[0].total, 1)
    } finally {
      await Promise.all([first.end(), second.end()])
      await admin.query('drop database ' + databaseName)
    }
  } finally { await admin.end() }
})
