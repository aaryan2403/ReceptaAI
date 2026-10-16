import type { SupabaseClient } from '@supabase/supabase-js'

export type SubscriptionConfiguration = {
  plan_name: 'Recepta Standard' | 'Recepta Pro'
  monthly_price: number
  monthly_minutes: number
  ai_model_id: string
  pii_redaction_enabled: boolean
  safety_guardrails_enabled: boolean
  extra_phone_numbers: number
  phone_number_country?: 'CA' | 'US'
  phone_number_area_code?: string | null
}

export const hasPaidSubscription = (subscription: {
  status?: string | null
  stripe_subscription_id?: string | null
  current_period_start?: string | null
  current_period_end?: string | null
} | null | undefined) => Boolean(subscription?.status === 'active' && subscription.stripe_subscription_id?.trim() &&
  subscription.current_period_start && subscription.current_period_end &&
  Date.parse(subscription.current_period_start) <= Date.now() && Date.parse(subscription.current_period_end) > Date.now())

export const saveSubscriptionConfiguration = async (db: SupabaseClient, clientId: string, configuration: SubscriptionConfiguration) => {
  const { data, error } = await db.rpc('configure_recepta_subscription', {
    p_client_id: clientId, p_configuration: configuration,
  })
  if (error || !data?.[0]) throw new Error(error?.message || 'Could not save the payment configuration.')
  return data[0] as SubscriptionConfiguration & {
    status: string; stripe_subscription_id: string | null
    current_period_start: string | null; current_period_end: string | null
    pending_configuration: SubscriptionConfiguration | null; configuration_revision: number
  }
}
