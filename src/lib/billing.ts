import type { CustomerService } from './serviceAccess'
import { supabase } from './supabase'
import type { calculateMinuteBalance } from './minuteBalance'

export type BillingSubscription = {
  pending_configuration?: {
    plan_name: 'Recepta Standard' | 'Recepta Pro'
    monthly_price: number
    monthly_minutes: number
    ai_model_id: string
    pii_redaction_enabled: boolean
    safety_guardrails_enabled: boolean
    extra_phone_numbers: number
  } | null
  configuration_revision?: number
  plan_name: 'Recepta Standard' | 'Recepta Pro' | null
  monthly_price: number | null
  monthly_minutes: number | null
  ai_model_id: string | null
  pii_redaction_enabled: boolean
  safety_guardrails_enabled: boolean
  extra_phone_numbers: number
  status: 'pending' | 'active' | 'past_due' | 'cancelled'
  next_billing_date: string | null
  current_period_start: string | null
  current_period_end: string | null
  rollover_seconds: number
  stripe_subscription_id: string | null
  cancel_at_period_end: boolean
  provider_cancel_at: string | null
}

export type MinuteBalance = ReturnType<typeof calculateMinuteBalance>
type BillingStatus = {
  subscription: BillingSubscription | null
  usedSeconds: number
  service: CustomerService
  balance: MinuteBalance | null
  simulation: { asOf: string; balance: MinuteBalance } | null
}

export const fetchBillingStatus = async (includeSimulation = false): Promise<BillingStatus> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const response = await fetch(`/.netlify/functions/billing-status${includeSimulation ? '?includeSimulation=1' : ''}`, {
    headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store',
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Could not load billing.')
  return body
}
