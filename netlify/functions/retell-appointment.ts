import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { activeCallEmailSettings, normalizeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { normalizeAppointmentFields, verifyRetellSignature } from '../lib/retell'
import { configuredRetellKey, isReceptaPreview } from '../lib/emailEnvironment'
import { appointmentIntake, objectValue, textValue, validDate, validStart, validTime } from '../lib/appointmentScheduling'
import { json } from '../lib/requestAuth'

const CHECK = 'recepta_check_availability'
const BOOK = 'recepta_book_appointment'
const SAVE = 'recepta_save_appointment_details'

// This public project ref is not a credential. Refuse *all* preview appointment
// writes when Netlify points at any database other than the isolated QA project.
const STAGING_SUPABASE_ORIGIN = 'https://mvufjeqxqvpcfqwmihpy.supabase.co'
// Netlify function runtime does not always expose deploy context variables.
// The served preview hostname is an additional trustworthy fail-closed signal.
const previewDatabaseIsStaging = (request: Request) => {
  let previewHost = false
  try {
    previewHost = /^deploy-preview-\d+--receptaai\.netlify\.app$/i.test(new URL(request.url).hostname)
  } catch { /* An invalid request URL must not grant any appointment access. */ }
  if (!isReceptaPreview() && !previewHost) return null
  try {
    const url = new URL(process.env.SUPABASE_URL ?? '')
    return url.origin === STAGING_SUPABASE_ORIGIN && url.pathname === '/' && !url.search && !url.hash
  } catch { return false }
}

export default async (request: Request) => {
  const startedAt = Date.now()
  const previewBinding = previewDatabaseIsStaging(request)
  if (request.method !== 'POST') {
    const response = json(405, { error: 'Method not allowed.' })
    if (previewBinding !== null) {
      response.headers.set('X-Recepta-Preview-Database', previewBinding ? 'staging' : 'mismatch')
    }
    return response
  }
  if (previewBinding === false) {
    console.error('Recepta appointment preview database rejected', { code: 'preview_database_mismatch' })
    return json(503, { success: false, code: 'preview_database_mismatch',
      error: 'Preview appointment testing is not connected to the staging database.' })
  }
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  // A preview can never accept signatures made with a production Retell key,
  // even if Netlify omits CONTEXT and DEPLOY_PRIME_URL at function runtime.
  const key = previewBinding !== null ? process.env.RETELL_STAGING_API_KEY?.trim() : configuredRetellKey()
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !key) {
    console.error('Recepta appointment configuration missing', {
      missing: [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_SECRET_KEY && 'SUPABASE_SECRET_KEY',
        !key && (previewBinding !== null ? 'RETELL_STAGING_API_KEY' : 'RETELL_API_KEY'),
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
    // Each signed action must have current Pro service access. An administrative
    // grant also requires a reservation for this call, client, and agent.
    const access = await db.rpc('recepta_authorize_appointment_tool', {
      p_client: clientId, p_agent: agentId, p_call_id: callId, p_tool: name,
    })
    if (access.error) throw access.error
    if (access.data?.allowed !== true) {
      const exhausted = access.data?.reason === 'test_limit_exhausted'
      console.warn('Recepta appointment rejected', { tool: name, call_trace: callTrace,
        code: exhausted ? 'test_entitlement_exhausted' : 'inactive_pro_subscription' })
      return json(403, { success: false,
        code: exhausted ? 'test_entitlement_exhausted' : 'inactive_pro_subscription',
        error: exhausted ? 'Internal appointment test limit reached.' :
          'Appointment capture requires active Recepta Pro or explicit internal test authorization.',
        instruction: 'Do not claim the appointment request was recorded.' })
    }

    if (name === CHECK) {
      if ((args.requested_date !== undefined && !validDate(args.requested_date)) ||
          (args.requested_time !== undefined && !validTime(args.requested_time))) {
        return json(200, { available: false, reason: 'invalid_local_date_or_time', alternatives: [] })
      }
      let localContext = {}
      if (args.requested_date === undefined) {
        const settings = await db.from('booking_settings').select('time_zone').eq('client_id', clientId).maybeSingle()
        if (settings.error) throw settings.error
        if (settings.data?.time_zone) {
          const timeZone = settings.data.time_zone
          const businessDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone }).format(new Date())
          localContext = { business_date: businessDate, time_zone: timeZone }
        }
      }
      const { data, error } = await db.rpc('recepta_scheduling_availability', {
        p_client: clientId, p_date: args.requested_date ?? null, p_time: args.requested_time ?? null,
      })
      if (error) throw error
      if (data?.reason === 'pro_required') {
        return json(403, { success: false, code: 'inactive_pro_subscription',
          error: 'Appointment capture requires an active Recepta Pro plan.' })
      }
      if (typeof data?.available !== 'boolean') throw new Error('The availability RPC returned no scheduling status.')
      console.info('Recepta appointment availability checked', {
        tool: name, call_trace: callTrace, available: data.available, reason: data.reason,
        elapsed_ms: Date.now() - startedAt,
      })
      return json(200, { ...data, ...localContext })
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
      if (data?.success && data.status === 'booked' && data.appointment_id && data.start) {
        console.info('Recepta appointment booked', { tool: name, call_trace: callTrace,
          status: data.status, elapsed_ms: Date.now() - startedAt })
        return json(200, { ...data, booking_reference: data.appointment_id })
      }
      if (data?.success !== false) throw new Error('The booking RPC returned no confirmed appointment.')
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
    if (data.status === 'booked') {
      const existing = await db.from('appointments').select('appointment_time, booking_time_zone')
        .eq('client_id', clientId).eq('id', data.id).eq('status', 'booked').maybeSingle()
      if (existing.error) throw existing.error
      if (existing.data?.appointment_time) return json(200, {
        success: true, status: 'booked', booking_reference: data.id,
        start: existing.data.appointment_time, time_zone: existing.data.booking_time_zone,
        instruction: 'This call already booked the returned time. Read it back in the business time zone.',
      })
    }
    return json(200, {
      success: data.status === 'pending',
      appointment_id: data.id, status: data.status, captured_fields: capturedFields,
      instruction: data.status === 'pending'
        ? 'The request is awaiting confirmation. Do not claim a calendar time was reserved.'
        : 'An appointment record already exists for this call. Use its returned status.',
    })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    console.error('Recepta appointment tool failed', { tool: name, code, call_trace: callTrace,
      elapsed_ms: Date.now() - startedAt })
    if (code === '42501') return json(403, { success: false, code: 'inactive_pro_subscription', error: 'Appointment capture requires an active Recepta Pro plan.' })
    return json(503, { success: false, code: 'scheduling_backend_unavailable', error: name === SAVE ? 'The request could not be recorded. Tell the caller it was not saved.' : 'Scheduling could not be verified. Offer to record a pending request.' })
  }
}
