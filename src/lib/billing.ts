import { supabase } from './supabase'

export type BillingSubscription = {
  pending_configuration?: {
    plan_name: 'Recepta Standard' | 'Recepta Pro'
    monthly_price: number
    monthly_minutes: number
    ai_model_id: string
    pii_redaction_enabled: boolean
    safety_guardrails_enabled: boolean
    extra_phone_numbers: number
    phone_number_country?: 'CA' | 'US'
    phone_number_area_code?: string | null
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
}

export const fetchBillingStatus = async (): Promise<{ subscription: BillingSubscription | null; usedSeconds: number; phoneManagementAvailable?: boolean; selectedNumbersAvailable?: boolean }> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const response = await fetch('/.netlify/functions/billing-status', {
    headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store',
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Could not load billing.')
  return body
}
