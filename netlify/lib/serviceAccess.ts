import type { SupabaseClient } from '@supabase/supabase-js'
import { isReceptaPreview } from './emailEnvironment'

export type ServiceAccess = {
  business_name: string
  mode: 'automatic' | 'manual' | 'internal_test' | 'paused' | 'pending'
  status: 'active' | 'pending' | 'paused' | 'expired' | 'inactive' | 'unavailable' | 'appointment_test'
  source: 'stripe' | 'manual_admin' | 'internal_test'
  reason: string
  plan: 'Recepta Pro' | 'Recepta Standard' | null
  billing_status: string | null
  has_stripe_subscription: boolean
  agent_id: string | null
  assignment_valid: boolean
  phone_number: string | null
  can_reserve: boolean
  appointments: boolean
  remaining_seconds: number
  expires_at: string | null
  max_minutes: number | null
  admin_reason: string | null
  updated_at: string | null
  updated_by: string | null
  revision: number
  grant_id: string | null
  legacy_founder: boolean
  legacy_appointment_test: boolean
  legacy_test_usable: boolean
}

export const loadServiceAccess = async (db: SupabaseClient, clientId: string): Promise<ServiceAccess> => {
  const { data, error } = await db.rpc('recepta_service_access', { p_client: clientId })
  if (error) throw error
  if (!data || typeof data.status !== 'string') throw new Error('Could not verify service access.')
  return data
}

export const appointmentServiceIssue = (access: ServiceAccess): string | null => {
  if (access.legacy_appointment_test && !access.legacy_test_usable) return 'The appointment-only test allowance is exhausted.'
  if (access.appointments) return null
  if (access.status === 'paused') return 'Service is paused by a Recepta administrator.'
  if (access.status === 'expired') return 'The service authorization has expired.'
  if (access.plan !== 'Recepta Pro') return 'Recepta Pro is required for appointment booking and request capture.'
  return 'The business needs active Recepta Pro billing or a current Pro service authorization.'
}

// A Netlify deploy preview can omit the deploy context variables at runtime.
export const serviceDeployment = (request: Request) => {
  const origin = new URL(request.url).origin
  const previewHost = /^https:\/\/deploy-preview-\d+--receptaai\.netlify\.app$/i.test(origin)
  const preview = previewHost || isReceptaPreview()
  const isolated = !preview || /^https:\/\/mvufjeqxqvpcfqwmihpy\.supabase\.co\/?$/.test(process.env.SUPABASE_URL ?? '')
  const key = (preview ? process.env.RETELL_STAGING_API_KEY : process.env.RETELL_API_KEY)?.trim()
  return { isolated, key, preview, previewOrigin: previewHost ? origin : undefined }
}
