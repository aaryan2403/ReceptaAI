import { createClient } from '@supabase/supabase-js'
import { isDeletingClient } from '../lib/requestAuth'
import { loadServiceAccess } from '../lib/serviceAccess'
import { getBillingUsage } from '../lib/billingNotifications'

const json = (status: number, body: object) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return json(500, { error: 'Billing is not configured.' })
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json(401, { error: 'Please sign in again.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  const { data: { user }, error: authError } = await db.auth.getUser(token)
  if (authError || !user) return json(401, { error: 'Please sign in again.' })
  try {
    if (await isDeletingClient(db,user.id)) return json(403,{ error:'This account is awaiting deletion.' })
    const { data: subscription, error } = await db.from('subscriptions')
      .select('client_id, stripe_subscription_id, plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, status, next_billing_date, current_period_start, current_period_end, rollover_seconds, cancel_at_period_end, pending_configuration, configuration_revision')
      .eq('client_id', user.id).maybeSingle()
    if (error) throw error
    const usedSeconds = subscription ? await getBillingUsage(db, subscription) : 0
    const access = await loadServiceAccess(db, user.id)
    const service = {
      status: access.status, reason: access.reason, plan: access.plan, source: access.source, agent_status: access.agent_status,
      can_reserve: access.can_reserve, appointments: access.appointments, remaining_seconds: access.remaining_seconds,
      service_allowance_seconds: access.service_allowance_seconds, period_start: access.period_start, period_end: access.period_end,
      provisioning_status: access.provisioning_status, cancellation_effective_at: access.cancellation_effective_at,
    }
    return json(200, { subscription, usedSeconds, service })
  } catch (error) {
    console.error('Could not load billing balance:', error)
    return json(500, { error: 'Could not load your minute balance. Please contact Recepta.' })
  }
}
