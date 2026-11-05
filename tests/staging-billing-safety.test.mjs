import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// All keys are synthetic. Any attempted database or Stripe access fails the test.
const compile = async (entry) => {
  const result = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'no-external-services', setup(builder) {
      builder.onResolve({ filter: /^(stripe|@supabase\/supabase-js)$/ }, args => ({ path: args.path, namespace: 'mock' }))
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ loader: 'js', contents: args.path === 'stripe'
        ? 'export default class { constructor() { throw new Error("Stripe must not be contacted"); } }'
        : 'export const createClient = () => { throw new Error("Database must not be contacted"); }',
      }))
    } }],
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { stripeSecretKey, stripeTestModeRequired } = await compile('netlify/lib/stripeEnvironment.ts')
const original = { ...process.env }
test.afterEach(() => {
  for (const key of ['CONTEXT', 'RECEPTA_REQUIRE_STRIPE_TEST_MODE', 'STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_EMAIL', 'RETELL_API_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
})

test('previews and explicit staging reject inherited live Stripe credentials', () => {
  for (const context of ['deploy-preview', 'branch-deploy', 'dev']) {
    process.env.CONTEXT = context
    delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
    for (const key of ['sk_live_synthetic', 'rk_live_synthetic', 'invalid', '']) {
      process.env.STRIPE_SECRET_KEY = key
      assert.equal(stripeTestModeRequired(), true)
      assert.equal(stripeSecretKey(), undefined)
    }
    for (const key of ['sk_test_synthetic', 'rk_test_synthetic']) {
      process.env.STRIPE_SECRET_KEY = key
      assert.equal(stripeSecretKey(), key)
    }
  }
  delete process.env.CONTEXT
  process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE = 'true'
  process.env.STRIPE_SECRET_KEY = 'sk_live_synthetic'
  assert.equal(stripeSecretKey(), undefined)
})

test('the production deployment keeps its existing billing key', () => {
  process.env.CONTEXT = 'production'
  delete process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE
  process.env.STRIPE_SECRET_KEY = 'sk_live_synthetic'
  assert.equal(stripeSecretKey(), 'sk_live_synthetic')
  process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE = 'true'
  assert.equal(stripeSecretKey(), undefined)
})

test('staging billing handlers stop before database access, customer creation or payment calls', async () => {
  process.env.CONTEXT = 'production' // Explicit staging also works if the host omits its context.
  process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE = 'true'
  process.env.STRIPE_SECRET_KEY = 'sk_live_synthetic'
  process.env.SUPABASE_URL = 'https://staging.example.test'
  process.env.SUPABASE_SECRET_KEY = 'synthetic'
  process.env.ADMIN_EMAIL = 'admin@example.test'
  process.env.RETELL_API_KEY = 'synthetic'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic'
  for (const name of ['create-client', 'create-checkout-session', 'create-billing-portal-session', 'stripe-webhook']) {
    const { default: handler } = await compile(`netlify/functions/${name}.ts`)
    const response = await handler(new Request(`https://staging.example.test/${name}`, { method: 'POST', body: '{}' }))
    assert.equal(response.status, 500, name)
    assert.match((await response.json()).error, /configuration|configured/i, name)
  }
  const { default: reminders } = await compile('netlify/functions/billing-reminders.ts')
  await assert.rejects(reminders(), /configuration is missing/)
})
