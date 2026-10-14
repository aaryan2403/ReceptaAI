import { createClient } from '@supabase/supabase-js'
import {
  normalizeAppointmentFields,
  verifyRetellSignature,
} from '../lib/retell'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const textValue = (value: unknown, maximum = 500) => {
  const valueText = typeof value === 'string' ? value.trim() : ''
  return valueText ? valueText.slice(0, maximum) : null
}

type Detail = { label: string; value: string }

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const retellApiKey = process.env.RETELL_API_KEY

  if (!supabaseUrl || !supabaseSecretKey || !retellApiKey) {
    return json(500, { error: 'Recepta appointment capture is not configured.' })
  }

  const rawBody = await request.text()
  if (!verifyRetellSignature(rawBody, request.headers.get('x-retell-signature'), retellApiKey)) {
    return json(401, { error: 'Invalid Retell signature.' })
  }

  let payload: {
    name?: string
    args?: Record<string, unknown>
    call?: {
      call_id?: string
      agent_id?: string
      from_number?: string
      metadata?: Record<string, unknown>
    }
  }

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, { error: 'Invalid JSON payload.' })
  }

  if (payload.name !== 'recepta_save_appointment_details') {
    return json(400, { error: 'Unknown Recepta appointment function.' })
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const agentId = textValue(payload.call?.agent_id, 200)
  const metadataClientId = textValue(payload.call?.metadata?.recepta_client_id, 100)
  let clientId = metadataClientId

  if (!clientId && agentId) {
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .select('client_id')
      .eq('retell_agent_id', agentId)
      .maybeSingle()

    if (error) return json(500, { error: 'Could not resolve the Recepta account.' })
    clientId = agent?.client_id ?? null
  }

  if (!clientId) return json(404, { error: 'This agent is not assigned to Recepta.' })

  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from('subscriptions')
    .select('plan_name, status')
    .eq('client_id', clientId)
    .maybeSingle()

  if (subscriptionError) return json(500, { error: 'Could not verify appointment access.' })
  if (subscription?.status !== 'active' || subscription.plan_name !== 'Recepta Pro') {
    return json(403, { error: 'Appointment capture requires an active Recepta Pro plan.' })
  }

  const { data: userResult, error: userError } =
    await supabaseAdmin.auth.admin.getUserById(clientId)
  if (userError) return json(500, { error: 'Could not load appointment fields.' })

  const configuredFields = normalizeAppointmentFields(
    userResult.user?.user_metadata?.appointment_custom_fields
  )
  const configuredByName = new Map(
    configuredFields.map((field) => [field.toLowerCase(), field])
  )
  const rawDetails = Array.isArray(payload.args?.appointment_details)
    ? payload.args?.appointment_details
    : []
  const details: Detail[] = []

  rawDetails.forEach((item) => {
    if (!item || typeof item !== 'object') return
    const row = item as Record<string, unknown>
    const suppliedLabel = textValue(row.label, 60)
    const value = textValue(row.value, 1000)
    if (!suppliedLabel || !value) return
    const label = configuredByName.get(suppliedLabel.toLowerCase())
    if (!label || details.some((detail) => detail.label === label)) return
    details.push({ label, value })
  })

  const customerName = textValue(payload.args?.customer_name, 160)
  if (!customerName) return json(400, { error: 'Customer name is required.' })

  const callId = textValue(payload.call?.call_id, 200)
  if (!callId) return json(400, { error: 'A provider call ID is required.' })

  const result = await supabaseAdmin.rpc('capture_recepta_appointment_request', {
    p_client_id: clientId,
    p_call_id: callId,
    p_details: {
      customer_name: customerName,
      customer_email: textValue(payload.args?.customer_email, 320),
      customer_phone: textValue(payload.args?.customer_phone, 60) ||
        textValue(payload.call?.from_number, 60),
      company_name: textValue(payload.args?.customer_company, 200),
      service: textValue(payload.args?.reason, 300) || 'Appointment request',
      requested_date: textValue(payload.args?.preferred_date, 200),
      requested_time: textValue(payload.args?.preferred_time, 200),
      requested_timezone: textValue(payload.args?.preferred_timezone, 100),
      notes: JSON.stringify({ version: 1, details }),
    },
  })

  if (result.error || !result.data) {
    return json(500, { error: result.error?.message || 'Could not save appointment details.' })
  }

  return json(200, {
    success: true,
    appointment_id: result.data.id,
    status: result.data.status,
    captured_fields: details.map((detail) => detail.label),
    instruction:
      'The appointment request and caller details were recorded. Do not claim a calendar time was reserved.',
  })
}
