import Stripe from 'stripe'
import { json, requestAuth } from '../lib/requestAuth'
import { serviceDeployment } from '../lib/serviceAccess'
import { configuredStripeKey } from '../lib/subscriptionConfiguration'

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return json(503, { error: 'This preview must use Recepta Staging.' })
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    const body = await request.json().catch(() => null)
    if (body?.timing !== 'immediate' && body?.timing !== 'period_end') {
      return json(400, { error: 'Choose when to cancel your subscription.' })
    }
    const key = configuredStripeKey(deployment.preview)
    if (!key) return json(503, { error: 'Stripe billing is unavailable.' })
    const { db, user } = auth
    const { data: billing, error } = await db.from('subscriptions')
      .select('stripe_subscription_id,stripe_customer_id').eq('client_id', user.id).maybeSingle()
    if (error) throw error
    if (!billing?.stripe_subscription_id || !billing.stripe_customer_id) {
      return json(409, { error: 'There is no Stripe subscription to cancel.' })
    }
    const stripe = new Stripe(key)
    const id: string = billing.stripe_subscription_id
    const current = await stripe.subscriptions.retrieve(id)
    const customerId = typeof current.customer === 'string' ? current.customer : current.customer.id
    if (customerId !== billing.stripe_customer_id || (deployment.preview && current.livemode)) {
      return json(409, { error: 'Could not confirm your Stripe subscription.' })
    }
    const cancelled = current.status === 'canceled' ? current : body.timing === 'immediate'
      ? await stripe.subscriptions.cancel(id)
      : await stripe.subscriptions.update(id, { cancel_at_period_end: true })
    if (body.timing === 'immediate' && cancelled.status !== 'canceled') {
      return json(503, { error: 'Stripe has not confirmed the cancellation. Check Billing before trying again.' })
    }
    const recorded = await db.from('subscriptions').update({
      ...(cancelled.status === 'canceled' ? { status: 'cancelled', rollover_seconds: 0 } : {}),
      cancel_at_period_end: Boolean(cancelled.cancel_at_period_end || cancelled.cancel_at),
      provider_cancel_at: cancelled.cancel_at ? new Date(cancelled.cancel_at * 1000).toISOString() : null,
    }).eq('client_id', user.id).eq('stripe_subscription_id', id)
    if (recorded.error) throw recorded.error
    return json(200, { cancelled: cancelled.status === 'canceled' })
  } catch (error) {
    console.error('Recepta subscription cancellation could not be confirmed:', error)
    return json(503, { error: 'Could not confirm cancellation. Check Billing before trying again.' })
  }
}
