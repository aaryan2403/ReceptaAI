import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { deliverBillingNotices, getBillingUsage, queueBillingNotice, queueUsageNotice } from '../lib/billingNotifications'

// Netlify invokes scheduled functions only on the production deployment.
export const config = { schedule: '0 * * * *' }

export default async () => {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) throw new Error('Billing reminder configuration is missing.')
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  const stripe = new Stripe(STRIPE_SECRET_KEY, { timeout: 3000, maxNetworkRetries: 0 })
  const deadline = Date.now() + 24_000
  const now = new Date()
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  // Pending emails get a retry even if a later subscription query fails.
  await deliverBillingNotices(db)
  let offset = 0
  while (Date.now() < deadline) {
    const { data: subscriptions, error } = await db.from('subscriptions').select('*')
      .eq('status', 'active').not('stripe_subscription_id', 'is', null)
      .gt('current_period_end', now.toISOString()).lte('current_period_end', horizon.toISOString())
      .order('current_period_end').order('client_id').range(offset, offset + 49)
    if (error) throw error
    for (const subscription of subscriptions ?? []) {
      if (Date.now() >= deadline) break
      const key = `renewal:${subscription.stripe_subscription_id}:${subscription.current_period_end}`
      const { data: existing, error: noticeError } = await db.from('billing_notifications')
        .select('notification_key').eq('notification_key', key).maybeSingle()
      if (noticeError) throw noticeError
      if (existing) continue
      const remote = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id)
      if (remote.status !== 'active' || remote.cancel_at_period_end || remote.cancel_at || remote.pause_collection) continue
      const used = await getBillingUsage(db, subscription)
      await queueBillingNotice(db, key, 'renewal_reminder', subscription, used)
      await queueUsageNotice(db, subscription, used)
    }
    if ((subscriptions?.length ?? 0) < 50) break
    offset += 50
  }
  return new Response(null, { status: 204 })
}
