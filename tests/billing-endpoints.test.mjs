import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Real handlers with mock service boundaries: no Stripe charges, live database
// writes, Retell changes, or emails are made by these tests.
const now = Math.floor(Date.now() / 1000)
const period = { start: now - 86400, end: now + 29 * 86400 }
const base = {
  client_id: 'customer_a', stripe_subscription_id: 'sub_test', stripe_customer_id: 'cus_a',
  plan_name: 'Recepta Pro', monthly_price: 300, monthly_minutes: 1000,
  rollover_seconds: 24000, status: 'active',
  current_period_start: new Date(period.start * 1000).toISOString(),
  current_period_end: new Date(period.end * 1000).toISOString(),
}
let state
const reset = () => {
  state = { subscription: { ...base }, updates: [], notices: [], rpcs: [], filters: [], remoteStatus: 'active', invoiceStatus: 'paid', portal: null }
}
const query = (table) => {
  let action = 'read'
  let values
  const execute = async () => {
    if (action === 'update') {
      state.updates.push({ table, values })
      if (table === 'subscriptions') Object.assign(state.subscription, values)
    }
    if (action === 'upsert') state.notices.push(values)
    return { data: table === 'subscriptions' ? { ...state.subscription }
      : table === 'agent_phone_numbers' ? [] : null, error: null }
  }
  const api = {
    select: () => api,
    update: (value) => { action = 'update'; values = value; return api },
    upsert: (value) => { action = 'upsert'; values = value; return api },
    eq: (column, value) => { state.filters.push({ table, column, value }); return api },
    order: () => api,
    maybeSingle: execute,
    then: (resolve, reject) => execute().then(resolve, reject),
  }
  return api
}
globalThis.__billingTestDb = {
  auth: { getUser: async () => ({ data: { user: { id: 'customer_a' } }, error: null }) },
  from: query,
  rpc: async (name, args) => {
    state.rpcs.push({ name, args })
    return { data: name === 'recepta_period_usage' ? 600 : name === 'claim_recepta_billing_notifications' ? [] : [{ ...state.subscription }], error: null }
  },
}
globalThis.__billingTestStripe = class {
  webhooks = { constructEvent: () => state.event }
  subscriptions = { retrieve: async () => ({ id: 'sub_test', status: state.remoteStatus, cancel_at_period_end: state.cancelAtPeriodEnd ?? false }) }
  invoices = {
    retrieve: async (id) => ({ id, status: state.invoiceStatus, hosted_invoice_url: 'https://invoice.stripe.test/in_test' }),
    listLineItems: async () => ({ data: [{ period, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_test', proration: false } } }] }),
  }
  billingPortal = { sessions: { create: async (payload) => {
    state.portal = payload
    return { url: 'https://billing.stripe.test/session' }
  } } }
}
const compile = async (file) => {
  const output = await build({
    entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'mock-services', setup(builder) {
      builder.onResolve({ filter: /^(stripe|@supabase\/supabase-js)$/ }, (args) => ({ path: args.path, namespace: 'mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
        contents: args.path === 'stripe' ? 'export default globalThis.__billingTestStripe'
          : 'export const createClient = () => globalThis.__billingTestDb', loader: 'js',
      }))
    } }],
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)).default
}
const webhook = await compile('netlify/functions/stripe-webhook.ts')
const portal = await compile('netlify/functions/create-billing-portal-session.ts')
const status = await compile('netlify/functions/billing-status.ts')
process.env.SUPABASE_URL = 'https://database.example.test'
process.env.SUPABASE_SECRET_KEY = 'synthetic-test-only'
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic'
process.env.RECEPTA_APP_URL = 'https://recepta.test'
delete process.env.RESEND_API_KEY

const signedRequest = () => new Request('https://recepta.test/.netlify/functions/stripe-webhook', {
  method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}',
})
const invoiceEvent = (type) => ({ type, data: { object: {
  id: 'in_test', status: type === 'invoice.paid' ? 'paid' : 'open', billing_reason: 'subscription_cycle',
  parent: { subscription_details: { subscription: 'sub_test' } },
  hosted_invoice_url: 'https://invoice.stripe.test/in_test',
} } })

test('unsigned Stripe webhooks are rejected before provisioning', async () => {
  reset()
  assert.equal((await webhook(new Request('https://recepta.test', { method: 'POST', body: '{}' }))).status, 400)
  assert.equal(state.rpcs.length, 0)
})

test('an unpaid Checkout session cannot activate a subscription', async () => {
  reset()
  state.event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'unpaid' } } }
  assert.equal((await webhook(signedRequest())).status, 200)
  assert.equal(state.rpcs.length, 0)
  assert.equal(state.updates.length, 0)
})

for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
  test(`${type} activates only the confirmed paid invoice period`, async () => {
    reset()
    state.event = { type, data: { object: {
      mode: 'subscription', payment_status: 'paid', subscription: 'sub_test',
      customer: 'cus_a', invoice: 'in_test', metadata: {
        client_id: 'customer_a', plan_name: 'Recepta Pro', ai_model_id: 'model_test',
        monthly_minutes: '1000', base_price_cad: '300', monthly_total_cad: '300',
      },
    } } }
    assert.equal((await webhook(signedRequest())).status, 200)
    const activation = state.rpcs.find((call) => call.name === 'activate_recepta_checkout')
    assert.equal(activation.args.p_client_id, 'customer_a')
    assert.equal(activation.args.p_period_start, base.current_period_start)
    assert.equal(activation.args.p_period_end, base.current_period_end)
    assert.equal(state.notices[0].notification_key, 'paid:in_test')
  })
}

test('paid renewals use the invoice period, atomic RPC and one invoice notification key', async () => {
  reset()
  state.event = invoiceEvent('invoice.paid')
  assert.equal((await webhook(signedRequest())).status, 200)
  const renewal = state.rpcs.find((call) => call.name === 'renew_recepta_subscription')
  assert.equal(renewal.args.p_period_start, base.current_period_start)
  assert.equal(renewal.args.p_period_end, base.current_period_end)
  assert.equal(state.notices[0].notification_key, 'paid:in_test')
  assert.equal(state.notices[0].kind, 'payment_success')
})

test('current-format failed invoices freeze access, retain rollover for retry, and queue action-required email', async () => {
  reset()
  state.event = invoiceEvent('invoice.payment_failed')
  state.invoiceStatus = 'open'
  state.remoteStatus = 'past_due'
  assert.equal((await webhook(signedRequest())).status, 200)
  assert.equal(state.subscription.status, 'past_due')
  assert.equal(state.subscription.rollover_seconds, 24000)
  assert.equal(state.notices[0].kind, 'payment_failed')
})

test('a late failure for an already paid invoice cannot disable service', async () => {
  reset()
  state.event = invoiceEvent('invoice.payment_failed')
  assert.equal((await webhook(signedRequest())).status, 200)
  assert.equal(state.updates.length, 0)
  assert.equal(state.subscription.status, 'active')
})

test('subscription termination clears rollover and pauses service', async () => {
  reset()
  state.event = { type: 'customer.subscription.deleted', data: { object: { id: 'sub_test' } } }
  assert.equal((await webhook(signedRequest())).status, 200)
  assert.equal(state.subscription.status, 'cancelled')
  assert.equal(state.subscription.rollover_seconds, 0)
  assert.ok(state.updates.some((update) => update.table === 'agents' && update.values.status === 'paused'))
})

test('scheduled cancellation is reflected without granting minutes or ending the paid cycle early', async () => {
  reset()
  state.cancelAtPeriodEnd = true
  state.event = { type: 'customer.subscription.updated', data: { object: { id: 'sub_test' } } }
  assert.equal((await webhook(signedRequest())).status, 200)
  assert.equal(state.subscription.cancel_at_period_end, true)
  assert.equal(state.subscription.status, 'active')
  assert.equal(state.subscription.rollover_seconds, 24000)
  assert.ok(!state.rpcs.some((rpc) => rpc.name === 'renew_recepta_subscription'))
})

test('the billing portal always uses the authenticated customer, ignoring a supplied customer ID', async () => {
  reset()
  assert.equal((await portal(new Request('https://recepta.test', { method: 'POST' }))).status, 401)
  const response = await portal(new Request('https://recepta.test', {
    method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: '{"customer_id":"cus_other"}',
  }))
  assert.equal(response.status, 200)
  assert.equal(state.portal.customer, 'cus_a')
  assert.equal(state.portal.return_url, 'https://recepta.test/dashboard/billing')
  assert.ok(state.filters.some((filter) => filter.column === 'client_id' && filter.value === 'customer_a'))
})

test('billing usage is aggregated only for the authenticated client and its paid period', async () => {
  reset()
  const response = await status(new Request('https://recepta.test?client_id=customer_b', { headers: { authorization: 'Bearer synthetic' } }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).usedSeconds, 600)
  const usage = state.rpcs.find((call) => call.name === 'recepta_period_usage')
  assert.equal(usage.args.p_client_id, 'customer_a')
  assert.equal(usage.args.p_period_end, base.current_period_end)
})
