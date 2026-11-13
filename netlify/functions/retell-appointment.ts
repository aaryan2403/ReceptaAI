import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { activeCallEmailSettings, normalizeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { normalizeAppointmentFields, verifyRetellSignature } from '../lib/retell'
import { configuredCallEmailRetellKey } from '../lib/emailEnvironment'
import { appointmentIntake, isActivePro, objectValue, textValue, validDate, validStart, validTime } from '../lib/appointmentScheduling'
import { json } from '../lib/requestAuth'

const CHECK = 'recepta_check_availability'
const BOOK = 'recepta_book_appointment'
const SAVE = 'recepta_save_appointment_details'

export default async (request: Request) => {
  const startedAt = Date.now()
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  const key = configuredCallEmailRetellKey()
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !key) {
    const preview = process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE === 'true'
      || Boolean(process.env.CONTEXT && process.env.CONTEXT !== 'production')
    console.error('Recepta appointment configuration missing', {
      missing: [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_SECRET_KEY && 'SUPABASE_SECRET_KEY',
        !key && (preview ? 'RETELL_STAGING_API_KEY' : 'RETELL_API_KEY'),
      ].filter(Boolean),
    })
    return json(503, { success: false, code: 'configuration_missing',
      error: 'Appointment service is temporarily unavailable.' })
  }

  const raw = await request.text()
  if (!verifyRetellSignature(raw, request.headers.get('x-retell-signature'), key)) {
    console.warn('Recepta appointment signature rejected', { code: 'invalid_signature' })
    return json(401, { success: false, code: 'invalid_signature', error: 'Invalid Retell signature.' })
  }
  let payload: Record<string, unknown>
  try { payload = objectValue(JSON.parse(raw)) } catch { return json(400, { error: 'Invalid JSON payload.' }) }
  const { name } = payload
  if (name !== CHECK && name !== BOOK && name !== SAVE) return json(400, { error: 'Unknown Recepta appointment function.' })
  const call = objectValue(payload.call)
  const args = objectValue(payload.args)
  const agentId = textValue(call.agent_id, 200)
  const callId = textValue(call.call_id, 200)
  if (!agentId || !callId) {
    console.warn('Recepta appointment identity missing', { tool: name, code: 'missing_call_identity' })
    return json(400, { success: false, code: 'missing_call_identity',
      error: 'A Retell agent and call ID are required.' })
  }
  // Opaque call fingerprint for tracing without exposing caller details or secrets.
  const callTrace = createHash('sha256').update(callId).digest('hex').slice(0, 12)

  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  try {
    const agent = await db.from('agents').select('client_id').eq('retell_agent_id', agentId).limit(2)
    if (agent.error) throw agent.error
    if (agent.data.length !== 1) {
      console.warn('Recepta appointment rejected', { tool: name, call_trace: callTrace,
        code: 'agent_mapping_invalid', assignments: agent.data.length })
      return json(403, { success: false, code: 'agent_mapping_invalid',
        error: 'This Retell agent does not have a unique Recepta assignment.' })
    }
    const clientId = agent.data[0].client_id
    const metadataClient = objectValue(call.metadata).recepta_client_id
    if (metadataClient !== undefined && metadataClient !== clientId) {
      console.warn('Recepta appointment rejected', { tool: name, call_trace: callTrace,
        code: 'tenant_mismatch' })
      return json(403, { success: false, code: 'tenant_mismatch',
        error: 'This call does not match the assigned business.' })
    }
    if (!await isActivePro(db, clientId)) {
      console.warn('Recepta appointment rejected', { tool: name, call_trace: callTrace,
        code: 'inactive_pro_subscription' })
      return json(403, { success: false, code: 'inactive_pro_subscription',
        error: 'Appointment capture requires an active Recepta Pro plan.',
        instruction: 'Do not claim the appointment request was recorded.' })
    }

    if (name === CHECK) {
      if (!validDate(args.requested_date) || (args.requested_time !== undefined && !validTime(args.requested_time))) {
        return json(200, { available: false, reason: 'invalid_local_date_or_time', alternatives: [] })
      }
      const { data, error } = await db.rpc('recepta_scheduling_availability', {
        p_client: clientId, p_date: args.requested_date, p_time: args.requested_time ?? null,
      })
      if (error) throw error
      return json(200, data)
    }

    const account = await db.auth.admin.getUserById(clientId)
    if (account.error) throw account.error
    const activeFields = activeCallEmailSettings(account.data.user?.app_metadata)
    const configuredFields = activeFields
      ? normalizeCallEmailSettings(activeFields).customFields
      : normalizeAppointmentFields(account.data.user?.user_metadata?.appointment_custom_fields)
    const { capturedFields, ...details } = appointmentIntake(args, configuredFields, call.from_number)
    if (!details.customer_name) return json(400, { error: 'Customer name is required.' })

    if (name === BOOK) {
      if (!validStart(args.start)) return json(200, { success: false, reason: 'invalid_start', instruction: 'Use the exact timestamp returned by the availability tool.' })
      const { data, error } = await db.rpc('recepta_change_appointment', {
        p_client: clientId, p_action: 'book', p_call_id: callId, p_start: args.start, p_details: details,
      })
      if (error) throw error
      if (data.success) return json(200, { ...data, booking_reference: data.appointment_id })
      if (data.reason === 'call_already_booked') return json(200, {
        ...data, booking_reference: data.appointment_id,
        instruction: 'This call already has a booking at the returned start. Tell the caller the existing booked time. A different time requires a reschedule by the business.',
      })
      const { data: availability } = await db.rpc('recepta_scheduling_availability', {
        p_client: clientId, p_date: null, p_start: args.start,
      })
      return json(200, { ...data, alternatives: availability?.alternatives ?? [] })
    }

    const { data, error } = await db.rpc('capture_recepta_appointment_request', {
      p_client_id: clientId, p_call_id: callId, p_details: details,
    })
    if (error || !data) throw error ?? new Error('The intake RPC returned no record.')
    console.info('Recepta appointment intake completed', {
      tool: name, call_trace: callTrace, status: data.status, elapsed_ms: Date.now() - startedAt,
    })
    return json(200, {
      success: data.status === 'pending' || data.status === 'booked',
      appointment_id: data.id, status: data.status, captured_fields: capturedFields,
      instruction: data.status === 'pending'
        ? 'The request is awaiting confirmation. Do not claim a calendar time was reserved.'
        : 'An appointment record already exists for this call. Use its returned status.',
    })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    console.error('Recepta appointment tool failed', { tool: name, code, call_trace: callTrace,
      elapsed_ms: Date.now() - startedAt })
    if (code === '42501') return json(403, { error: 'Appointment capture requires an active Recepta Pro plan.' })
    return json(503, { success: false, error: name === SAVE ? 'The request could not be recorded. Tell the caller it was not saved.' : 'Scheduling could not be verified. Offer to record a pending request.' })
  }
}
