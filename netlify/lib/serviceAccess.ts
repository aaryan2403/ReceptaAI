import type { SupabaseClient } from '@supabase/supabase-js'
import { isReceptaPreview } from './emailEnvironment'

import type { ServiceAccess } from '../../src/lib/serviceAccess'
export type { AgentStatus, ServiceAccess, ServiceMode, ServicePlan } from '../../src/lib/serviceAccess'

export const loadServiceAccess = async (db: SupabaseClient, clientId: string, signal?: AbortSignal): Promise<ServiceAccess> => {
  const query = db.rpc('recepta_service_access', { p_client: clientId })
  const { data, error } = await (signal ? query.abortSignal(signal) : query)
  if (error) throw error
  if (!data || typeof data.status !== 'string') throw new Error('Could not verify service access.')
  return data
}

export const appointmentServiceIssue = (access: ServiceAccess): string | null => {
  if (access.legacy_appointment_test && !access.legacy_test_usable) return 'The appointment-only test allowance is exhausted.'
  if (access.appointments) return null
  if (access.reason === 'provisioning') return 'Your Pro receptionist is being configured.'
  if (access.reason === 'subscription_cancelled') return 'Your AI receptionist is paused because your subscription was cancelled.'
  if (['paused', 'suspended', 'cancelled'].includes(access.status)) return 'An administrator has placed this client’s service on hold.'
  if (['agent_setup', 'agent_paused', 'agent_testing'].includes(access.reason)) return 'The selected agent status blocks appointment tools.'
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
