import { createHash, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasPaidSubscription } from './subscriptionConfiguration'
import { normalizePhone } from './phoneValidation'
import { transferWindowOpen } from './transferSchedule'

export class PhoneError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export const phoneFeatureEnabled = () => process.env.RECEPTA_PHONE_SETUP_ENABLED === 'true'
export const requirePhoneFeature = () => {
  if (!phoneFeatureEnabled()) throw new PhoneError(503, 'Phone setup is awaiting release verification. Your existing service is unchanged.')
}
export const checked = <T>(result: { data: T; error: unknown }, message = 'Phone setup storage is unavailable. Try again shortly.'): T => {
  if (result.error) throw new PhoneError(503, message)
  return result.data
}
export const rateLimit = async (db: SupabaseClient, key: string, max: number, seconds: number) => {
  const hash = createHash('sha256').update(key).digest('hex')
  const allowed = checked(await db.rpc('consume_phone_limit', { p_key: hash, p_max: max, p_seconds: seconds }))
  if (allowed !== true) throw new PhoneError(429, 'Too many attempts. Wait before trying again.')
}
export const withPhoneLock = async <T>(db: SupabaseClient, clientId: string, run: () => Promise<T>): Promise<T> => {
  const token = randomUUID()
  const acquired = checked(await db.rpc('acquire_phone_lock', { p_client_id: clientId, p_token: token }))
  if (acquired !== true) throw new PhoneError(409, 'Another phone update is in progress. Try again shortly.')
  try { return await run() }
  finally { await db.from('phone_operation_locks').delete().eq('client_id', clientId).eq('token', token) }
}
export const loadPhoneAccount = async (db: SupabaseClient, clientId: string) => {
  const [a, s, p, setup, destinations, verified, provisioning] = await Promise.all([
    db.from('agents').select('retell_agent_id,phone_number,status,business_hours').eq('client_id', clientId).maybeSingle(),
    db.from('subscriptions').select('status,stripe_subscription_id,current_period_start,current_period_end').eq('client_id', clientId).maybeSingle(),
    db.from('agent_phone_numbers').select('phone_number').eq('client_id', clientId).order('is_primary', { ascending: false }),
    db.from('phone_setups').select('*').eq('client_id', clientId).maybeSingle(),
    db.from('phone_transfer_destinations').select('phone_number,enabled').eq('client_id', clientId).eq('is_primary', true).maybeSingle(),
    db.from('phone_verified_numbers').select('purpose,phone_number,verified_at').eq('client_id', clientId),
    db.from('phone_provisioning').select('state,number_state').eq('client_id', clientId).maybeSingle(),
  ])
  const agent = checked(a), subscription = checked(s), numbers = checked(p), settings = checked(setup), destination = checked(destinations)
  const verifiedNumbers = checked(verified).filter(row => row.verified_at && Date.parse(row.verified_at) > Date.now() - 90 * 86400000)
  return { agent, paid: hasPaidSubscription(subscription), numbers: [...new Set([...(numbers ?? []).map(row => row.phone_number), agent?.phone_number].filter((v): v is string => Boolean(v)))],
    settings, destination, verifiedNumbers, provisioning: provisioning.error ? null : provisioning.data ? {
      state: provisioning.data.state, number_state: provisioning.data.number_state,
    } : null }
}
export const requireDedicatedAgent = async (db: SupabaseClient, clientId: string, agentId?: string | null) => {
  if (!agentId) throw new PhoneError(409, 'Your Recepta agent has not been assigned yet.')
  const rows = checked(await db.from('agents').select('client_id').eq('retell_agent_id', agentId).limit(2))
  if (rows?.length !== 1 || rows[0].client_id !== clientId) throw new PhoneError(409, 'A dedicated agent is required. Recepta must resolve this assignment before syncing.')
  return agentId
}
export const assertDirectDestination = async (db: SupabaseClient, number: string, business: string | null = null) => {
  if (number === business) throw new PhoneError(400, 'The worker number must be different from the forwarded business number.')
  const results = await Promise.all([
    db.from('agents').select('client_id').eq('phone_number', number).limit(1),
    db.from('agent_phone_numbers').select('client_id').eq('phone_number', number).limit(1),
    db.from('phone_forwarding_sources').select('client_id').eq('phone_number', number).limit(1),
  ])
  const unsafe = checked(await db.rpc('recepta_unsafe_destination', { p_number: number }))
  if (unsafe || results.some(r => (checked(r)?.length ?? 0) > 0)) throw new PhoneError(400, 'Use a direct worker number. Recepta numbers and known forwarding numbers can create a call loop.')
}
export const isVerifiedNumber = (rows: Array<{ purpose: string; phone_number: string }>, purpose: string, phone: string) =>
  rows.some(row => row.purpose === purpose && row.phone_number === phone)

export const assertBusinessVerificationTarget = async (db: SupabaseClient, clientId: string, number: string) => {
  const [agents, numbers, forwarding] = await Promise.all([
    db.from('agents').select('client_id').eq('phone_number', number).limit(1),
    db.from('agent_phone_numbers').select('client_id').eq('phone_number', number).limit(1),
    db.from('phone_forwarding_sources').select('client_id').eq('phone_number', number).limit(1),
  ])
  if (checked(agents).length || checked(numbers).length) {
    throw new PhoneError(400, 'Enter your original business number, not a Recepta AI number.')
  }
  if (checked(forwarding).some(row => row.client_id !== clientId)) {
    throw new PhoneError(400, 'This business number is already linked to another account.')
  }
  // Owners may renew verification of their own forwarding source. It remains
  // forbidden as a worker destination, including after renewal.
}

export const verificationConfigured = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID)
export const verifyRequest = async (resource: 'Verifications' | 'VerificationCheck', fields: Record<string, string>) => {
  if (!verificationConfigured()) throw new PhoneError(503, 'Phone verification is not connected yet. Recepta must configure the verification service before transfers can be enabled.')
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID!
  if (!/^VA[0-9a-fA-F]{32}$/.test(sid)) throw new PhoneError(503, 'Phone verification service is not configured correctly.')
  const response = await fetch(`https://verify.twilio.com/v2/Services/${sid}/${resource}`, {
    method: 'POST', signal: AbortSignal.timeout(12000),
    headers: { Authorization: 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  if (!response.ok) throw new PhoneError(response.status === 429 ? 429 : 400,
    resource === 'VerificationCheck' ? 'The code is invalid or expired. Request a new code if needed.' : 'Could not send a verification code. Check the number and try again later.')
  return await response.json() as { sid?: string; status?: string; valid?: boolean }
}

// A safe default is injected for EVERY admitted call. Stale Retell tools have no
// destination outside this path; inactive accounts never pass existing admission.
export const resolveInboundTransfer = async (db: SupabaseClient, clientId: string, agentId: string, reservedSeconds = 7200, now = new Date()) => {
  const disabled = { recepta_transfer_allowed: 'disabled', recepta_transfer_destination: '' }
  if (!phoneFeatureEnabled()) return disabled
  try {
    const account = await loadPhoneAccount(db, clientId)
    if (!account.paid || account.settings?.sync_state !== 'synced' || account.settings.synced_agent_id !== agentId || !account.destination?.enabled) return disabled
    if (!transferWindowOpen(account.settings.transfer_schedule, account.agent?.business_hours ?? null, reservedSeconds, now)) return disabled
    await requireDedicatedAgent(db, clientId, agentId)
    const number = normalizePhone(account.destination.phone_number)
    if (!number || !isVerifiedNumber(account.verifiedNumbers, 'worker', number)) return disabled
    await assertDirectDestination(db, number, account.settings.business_number)
    return { recepta_transfer_allowed: 'enabled', recepta_transfer_destination: number }
  } catch { return disabled }
}
// Retell presents the AI number to the worker. If that worker accidentally
// forwards back to any Recepta number, reject the new loop leg before reserving minutes.
export const isReceptaLoopCaller = async (db: SupabaseClient, from: string | null) => {
  if (!phoneFeatureEnabled() || !from) return false
  const result = await db.rpc('recepta_inbound_number', { p_number: from })
  // A DB failure also declines this call while loop protection is enabled.
  return Boolean(result.error || result.data !== false)
}
