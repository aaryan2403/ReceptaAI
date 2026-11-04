export type PhoneAccount = {
  paid: boolean
  agent: { retell_agent_id: string | null; status: string | null } | null
  numbers: string[]
  settings: { mode: 'new' | 'existing'; business_number: string | null; carrier: string; line_type: 'mobile' | 'landline' | 'voip'; revision: number;
    sync_state: string; reception_tested_at: string | null; transfer_tested_at: string | null } | null
  destination: { phone_number: string; enabled: boolean } | null
  verifiedNumbers: Array<{ purpose: string; phone_number: string; verified_at: string }>
  verificationAvailable: boolean
}
export const phoneSetupRequest = async <T>(body?: Record<string, unknown>, endpoint = 'phone-setup'): Promise<T> => {
  const { supabase } = await import('./supabase')
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const response = await fetch('/.netlify/functions/' + endpoint, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(90000),
    headers: { Authorization: 'Bearer ' + session.access_token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Could not load phone setup.')
  return result as T
}
