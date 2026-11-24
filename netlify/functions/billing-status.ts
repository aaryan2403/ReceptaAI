import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { isDeletingClient } from '../lib/requestAuth'
import { loadServiceAccess, serviceDeployment } from '../lib/serviceAccess'
import { getBillingUsage } from '../lib/billingNotifications'
import { configuredStripeKey } from '../lib/subscriptionConfiguration'
import { calculateMinuteBalance } from '../../src/lib/minuteBalance'

const json = (status: number, body: object) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return json(503, { error: 'This preview must use Recepta Staging.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return json(500, { error: 'Billing is not configured.' })
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json(401, { error: 'Please sign in again.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  const { data: { user }, error: authError } = await db.auth.getUser(token)
  if (authError || !user) return json(401, { error: 'Please sign in again.' })
  try {
    if (await isDeletingClient(db,user.id)) return json(403,{ error:'This account is awaiting deletion.' })
    const { data: billing, error } = await db.from('subscriptions')
      .select('client_id, stripe_subscription_id, stripe_customer_id, plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, status, next_billing_date, current_period_start, current_period_end, rollover_seconds, cancel_at_period_end, provider_cancel_at, pending_configuration, configuration_revision')
      .eq('client_id', user.id).maybeSingle()
    if (error) throw error
    const [usedSeconds, access] = await Promise.all([
      billing ? getBillingUsage(db, billing) : 0,
      loadServiceAccess(db, user.id),
    ])
    const { stripe_customer_id: stripeCustomerId, ...details } = billing ?? {}
    const subscription = billing ? details : null
    const balance = billing ? calculateMinuteBalance(billing, usedSeconds) : null
    let simulation = null
    // Stripe's clock is used for a read-only comparison on the billing page.
    // Admission, call accounting and production never read it.
    if (deployment.preview && billing?.stripe_subscription_id && stripeCustomerId &&
      new URL(request.url).searchParams.get('includeSimulation') === '1') {
      const key = configuredStripeKey(true)
      if (key) {
        try {
          const stripe = new Stripe(key, { timeout: 2000, maxNetworkRetries: 0 })
          const remote = await stripe.subscriptions.retrieve(billing.stripe_subscription_id)
          const customerId = typeof remote.customer === 'string' ? remote.customer : remote.customer.id
          const clockId = typeof remote.test_clock === 'string' ? remote.test_clock : remote.test_clock?.id
          if (!remote.livemode && customerId === stripeCustomerId && clockId) {
            const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
            if (!clock.livemode && clock.status === 'ready' && Number.isFinite(clock.frozen_time)) {
              const timestamp = clock.frozen_time * 1000
              simulation = { asOf: new Date(timestamp).toISOString(), balance: calculateMinuteBalance(billing, usedSeconds, timestamp) }
            }
          }
        } catch (clockError) {
          console.warn('Could not read the Stripe sandbox test clock:', clockError)
        }
      }
    }
    const service = {
      status: access.status, reason: access.reason, plan: access.plan, source: access.source, agent_status: access.agent_status,
      can_reserve: access.can_reserve, appointments: access.appointments, remaining_seconds: access.remaining_seconds,
      service_allowance_seconds: access.service_allowance_seconds, period_start: access.period_start, period_end: access.period_end,
      service_status: access.service_status, retention_reason: access.retention_reason,
      retention_started_at: access.retention_started_at, retention_deadline: access.retention_deadline,
      retention_operation: access.retention_operation, payment_grace_ends_at: access.payment_grace_ends_at,
      provisioning_status: access.provisioning_status, cancellation_effective_at: access.cancellation_effective_at,
    }
    return json(200, { subscription, usedSeconds, service, balance, simulation })
  } catch (error) {
    console.error('Could not load billing balance:', error)
    return json(500, { error: 'Could not load your minute balance. Please contact Recepta.' })
  }
}
