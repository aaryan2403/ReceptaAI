import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateMinuteBalance, formatMinuteSeconds } from '../../src/lib/minuteBalance'

type BillingSubscription = {
  client_id: string
  stripe_subscription_id: string | null
  plan_name: string | null
  monthly_price: number | null
  monthly_minutes: number | null
  rollover_seconds: number
  status: string | null
  current_period_start: string | null
  current_period_end: string | null
}
type NotificationKind = 'renewal_reminder' | 'payment_success' | 'payment_failed' | 'usage_80' | 'usage_100'
type NotificationPayload = { subject: string; text: string }

export const billingOrigin = () => {
  const configured = process.env.RECEPTA_APP_URL || process.env.URL || 'https://recepta.ca'
  const url = new URL(configured)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid Recepta app URL.')
  return url.origin
}

export const getBillingUsage = async (db: SupabaseClient, subscription: BillingSubscription) => {
  if (!subscription.current_period_start || !subscription.current_period_end) return 0
  const { data, error } = await db.rpc('recepta_period_usage', {
    p_client_id: subscription.client_id,
    p_period_start: subscription.current_period_start,
    p_period_end: subscription.current_period_end,
  })
  if (error) throw error
  return Math.max(0, Number(data) || 0)
}

const dateLabel = (date: string | null) => date
  ? new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric' })
  : 'not scheduled'

export const buildBillingNotice = (
  kind: NotificationKind,
  subscription: BillingSubscription,
  usedSeconds: number,
  invoiceUrl?: string | null,
): NotificationPayload => {
  const balance = calculateMinuteBalance(subscription, usedSeconds)
  const renewal = dateLabel(subscription.current_period_end)
  const titles: Record<NotificationKind, string> = {
    renewal_reminder: `Your Recepta subscription renews on ${renewal}`,
    payment_success: 'Recepta payment confirmed — your minute balance',
    payment_failed: 'Recepta payment failed — update your payment method',
    usage_80: 'You have used 80% of your Recepta minutes',
    usage_100: 'Your Recepta minute allowance has been used',
  }
  const introductions: Record<NotificationKind, string> = {
    renewal_reminder: `Your subscription is due to renew automatically on ${renewal}. Stripe will attempt to charge your saved payment method.`,
    payment_success: 'Stripe has confirmed your payment. Your paid monthly allowance and eligible rollover minutes are available for the billing cycle below.',
    payment_failed: 'Stripe could not collect your subscription payment. Open billing to update your card or complete payment. Rollover does not replace the monthly subscription fee, and minutes cannot be used until payment is confirmed.',
    usage_80: 'You are approaching your paid call allowance. Open billing to request or pay for a higher allowance before it runs out.',
    usage_100: 'Your paid call allowance has been used. Recepta pauses new AI calls at the limit; calls already in progress can finish. Open billing to arrange more minutes or contact Recepta.',
  }
  return {
    subject: titles[kind],
    text: [
      introductions[kind], '',
      `Plan: ${subscription.plan_name || 'Recepta'}`,
      `Monthly subscription: C$${Number(subscription.monthly_price ?? 0).toFixed(2)} (before any applicable tax)`,
      `Monthly allowance: ${formatMinuteSeconds(balance.monthlySeconds)} minutes`,
      `Rollover granted this cycle: ${formatMinuteSeconds(balance.rolloverSeconds)} minutes`,
      `Rollover still unused: ${formatMinuteSeconds(balance.rolloverRemainingSeconds)} minutes; expires ${renewal}`,
      `Total allowance this cycle: ${formatMinuteSeconds(balance.totalSeconds)} minutes`,
      `Minutes used this cycle: ${formatMinuteSeconds(balance.usedSeconds)}`,
      `Minutes available now: ${formatMinuteSeconds(balance.remainingSeconds)}`,
      `Billing cycle ends/renews: ${renewal}`,
      ...(kind === 'renewal_reminder' ? [`Unused monthly minutes eligible for the next paid cycle so far: ${formatMinuteSeconds(balance.nextRolloverSeconds)}. This can change with further calls.`] : []),
      '', 'Rollover is used first, lasts one additional billing cycle, and requires a paid renewal. Old rollover does not roll over again. Unused minutes are forfeited when your subscription ends.',
      '', `Manage billing: ${billingOrigin()}/dashboard/billing`,
      ...(invoiceUrl ? [`Stripe invoice: ${invoiceUrl}`] : []),
    ].join('\n'),
  }
}

export const queueBillingNotice = async (
  db: SupabaseClient,
  key: string,
  kind: NotificationKind,
  subscription: BillingSubscription,
  usedSeconds = 0,
  invoiceUrl?: string | null,
) => {
  const { error } = await db.from('billing_notifications').upsert({
    notification_key: key,
    client_id: subscription.client_id,
    kind,
    payload: buildBillingNotice(kind, subscription, usedSeconds, invoiceUrl),
  }, { onConflict: 'notification_key', ignoreDuplicates: true })
  if (error) throw error
}

export const queueUsageNotice = async (db: SupabaseClient, subscription: BillingSubscription, usedSeconds: number) => {
  const balance = calculateMinuteBalance(subscription, usedSeconds)
  if (!balance.paid || balance.totalSeconds <= 0 || balance.usagePercent < 80) return
  const kind = balance.usagePercent >= 100 ? 'usage_100' : 'usage_80'
  await queueBillingNotice(db,
    `${kind}:${subscription.stripe_subscription_id}:${subscription.current_period_start}`,
    kind, subscription, usedSeconds)
}

// Failed deliveries remain in the outbox for the next scheduled retry. A database
// lease plus Resend's idempotency key protects concurrent webhook/scheduler runs.
export const deliverBillingNotices = async (db: SupabaseClient, limit = 5) => {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) { console.error('Billing notices are queued; RESEND_API_KEY is missing.'); return }
  const { data, error } = await db.rpc('claim_recepta_billing_notifications', { p_limit: limit })
  if (error) throw error
  for (const notice of data ?? []) {
    // Keep below the email provider's default request-rate limit.
    await new Promise((resolve) => setTimeout(resolve, 550))
    try {
      const { data: client, error: clientError } = await db.from('clients')
        .select('contact_email').eq('id', notice.client_id).maybeSingle()
      if (clientError) throw clientError
      let email = client?.contact_email?.trim()
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const { data: user, error: userError } = await db.auth.admin.getUserById(notice.client_id)
        if (userError) throw userError
        email = user.user?.email
      }
      if (!email) throw new Error('Customer billing email is missing.')
      const payload = notice.payload as NotificationPayload
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': notice.notification_key },
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          from: process.env.BILLING_FROM_EMAIL || process.env.APPOINTMENT_FROM_EMAIL || process.env.REQUEST_NOTIFICATION_FROM_EMAIL || 'Recepta Billing <onboarding@resend.dev>',
          to: [email], reply_to: process.env.RECEPTA_SUPPORT_EMAIL || 'receptahelp02@gmail.com',
          subject: payload.subject, text: payload.text,
        }),
      })
      if (!response.ok) throw new Error(`Billing email delivery failed (${response.status}).`)
      const { error: saveError } = await db.from('billing_notifications')
        .update({ sent_at: new Date().toISOString(), last_error: null })
        .eq('notification_key', notice.notification_key)
      if (saveError) throw saveError
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Billing email delivery failed.'
      console.error(message)
      const { error: saveError } = await db.from('billing_notifications')
        .update({ last_error: message }).eq('notification_key', notice.notification_key)
      if (saveError) console.error('Could not record billing email failure:', saveError.message)
    }
  }
}
