import { createClient } from '@supabase/supabase-js'

type RetellCall = {
  call_id?: string
  agent_id?: string
  call_status?: string
  direction?: string
  from_number?: string
  to_number?: string
  start_timestamp?: number
  end_timestamp?: number
  duration_ms?: number
  transcript?: string
  scrubbed_transcript?: string
  recording_url?: string
  scrubbed_recording_url?: string
  disconnection_reason?: string
  metadata?: Record<string, unknown>
  retell_llm_dynamic_variables?: Record<string, unknown>
  call_analysis?: {
    call_summary?: string
    user_sentiment?: string
    call_successful?: boolean
    custom_analysis_data?: Record<string, unknown>
  }
}

type RetellListResponse = {
  items?: RetellCall[]
}

type CachedCall = {
  expiresAt: number
  call: RetellCall
}

type ClientCallRecord = {
  id: string
  retell_call_id: string | null
  caller_name: string | null
  caller_number: string | null
  started_at: string
  duration_seconds: number
  outcome: string | null
  summary: string | null
  appointment_booked: boolean
  call_status: string | null
  transcript: string | null
  recording_url: string | null
}

const detailCache = new Map<string, CachedCall>()

const json = (
  status: number,
  body: Record<string, unknown>
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })

const getString = (value: unknown) =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : null

const getBoolean = (value: unknown) =>
  value === true ||
  (typeof value === 'string' &&
    value.toLowerCase() === 'true')

const getDurationSeconds = (call: RetellCall) => {
  if (
    typeof call.duration_ms === 'number' &&
    Number.isFinite(call.duration_ms)
  ) {
    return Math.max(0, Math.round(call.duration_ms / 1000))
  }

  if (
    typeof call.start_timestamp === 'number' &&
    typeof call.end_timestamp === 'number'
  ) {
    return Math.max(
      0,
      Math.round(
        (call.end_timestamp - call.start_timestamp) / 1000
      )
    )
  }

  return 0
}

const retellRequest = async <T>(
  apiKey: string,
  path: string,
  init: RequestInit = {}
) => {
  const response = await fetch(
    `https://api.retellai.com${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...init.headers,
      },
    }
  )

  const text = await response.text()
  let body: unknown = null

  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message =
      body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `Retell request failed with status ${response.status}.`

    throw new Error(message)
  }

  return body as T
}

const getRetellCall = async (
  apiKey: string,
  call: RetellCall
) => {
  const callId = getString(call.call_id)

  if (!callId) return call

  const cached = detailCache.get(callId)

  if (cached && cached.expiresAt > Date.now()) {
    return cached.call
  }

  try {
    const detailedCall = await retellRequest<RetellCall>(
      apiKey,
      `/v2/get-call/${encodeURIComponent(callId)}`
    )

    detailCache.set(callId, {
      call: detailedCall,
      expiresAt:
        Date.now() +
        (detailedCall.call_analysis
          ? 30 * 60 * 1000
          : 10 * 1000),
    })

    if (detailCache.size > 500) {
      detailCache.clear()
    }

    return detailedCall
  } catch (error) {
    console.error(
      'Could not load Retell call details:',
      callId,
      error
    )

    return call
  }
}

const toCallRecord = (
  call: RetellCall,
  clientId: string,
  piiRedactionEnabled: boolean
) => {
  const callId = getString(call.call_id)
  const status = getString(call.call_status) ?? 'ended'
  const active = status === 'ongoing' || status === 'registered'
  const variables = call.retell_llm_dynamic_variables ?? {}
  const metadata = call.metadata ?? {}
  const analysis = call.call_analysis
  const customAnalysis = analysis?.custom_analysis_data ?? {}

  const callerName =
    getString(variables.customer_name) ??
    getString(metadata.customer_name)

  const callerNumber =
    call.direction === 'outbound'
      ? getString(call.to_number)
      : getString(call.from_number)

  const startedAt =
    typeof call.start_timestamp === 'number'
      ? new Date(call.start_timestamp).toISOString()
      : new Date().toISOString()

  let outcome = active
    ? 'In progress'
    : getString(call.disconnection_reason) ?? 'Completed'

  if (
    !active &&
    typeof analysis?.call_successful === 'boolean'
  ) {
    outcome = analysis.call_successful
      ? 'Successful'
      : 'Unsuccessful'
  }

  return {
    client_id: clientId,
    retell_call_id: callId,
    caller_name: callerName,
    caller_number: callerNumber,
    started_at: startedAt,
    duration_seconds: getDurationSeconds(call),
    outcome,
    summary: getString(analysis?.call_summary),
    appointment_booked: getBoolean(
      customAnalysis.appointment_booked
    ),
    call_status: status,
    transcript: piiRedactionEnabled
      ? getString(call.scrubbed_transcript)
      : getString(call.transcript),
    recording_url: piiRedactionEnabled
      ? getString(call.scrubbed_recording_url)
      : getString(call.recording_url),
    disconnection_reason: getString(
      call.disconnection_reason
    ),
    user_sentiment: getString(analysis?.user_sentiment),
    call_successful: analysis?.call_successful ?? null,
    updated_at: new Date().toISOString(),
  }
}

const getScheduleMode = (
  businessHours?: string | null
) => {
  const normalized = businessHours?.trim().toLowerCase()

  if (!normalized || normalized === 'not configured') {
    return null
  }

  if (normalized === 'not required' || normalized === '24/7') {
    return '24/7' as const
  }

  try {
    const parsed = JSON.parse(businessHours ?? '') as {
      mode?: unknown
    }

    if (parsed?.mode === '24/7' || parsed?.mode === 'custom') {
      return parsed.mode
    }
  } catch {
    // Legacy arrays and plain text are custom schedules.
  }

  return 'custom' as const
}

const getSchedulePreference = (businessHours?: string | null) => {
  const mode = getScheduleMode(businessHours)
  return mode === null ? null : mode === 'custom'
}

export default async (request: Request) => {
  if (request.method !== 'GET') {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const retellApiKey = process.env.RETELL_API_KEY

  if (!supabaseUrl || !supabaseSecretKey || !retellApiKey) {
    return json(500, {
      error: 'Server configuration is missing.',
    })
  }

  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized.' })
  }

  const supabaseAdmin = createClient(
    supabaseUrl,
    supabaseSecretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  const token = authHeader.slice('Bearer '.length)
  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(token)

  if (userError || !user) {
    return json(401, { error: 'Unauthorized.' })
  }

  const [agentResult, subscriptionResult, storedCallsResult] =
    await Promise.all([
      supabaseAdmin
        .from('agents')
        .select('retell_agent_id, business_hours')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('subscriptions')
        .select('pii_redaction_enabled')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('calls')
        .select(
          'id, retell_call_id, caller_name, caller_number, started_at, duration_seconds, outcome, summary, appointment_booked, call_status, transcript, recording_url'
        )
        .eq('client_id', user.id)
        .order('started_at', { ascending: false }),
    ])

  if (agentResult.error) {
    return json(500, { error: 'Could not load assigned agent.' })
  }

  const agentId = getString(agentResult.data?.retell_agent_id)

  if (!agentId) {
    return json(409, {
      error: 'No Retell Agent ID is assigned to this customer.',
      calls: storedCallsResult.data ?? [],
      scheduleMode: getScheduleMode(
        agentResult.data?.business_hours
      ),
      scheduleEnabled: getSchedulePreference(
        agentResult.data?.business_hours
      ),
    })
  }

  const piiRedactionEnabled =
    subscriptionResult.data?.pii_redaction_enabled === true

  try {
    const list = await retellRequest<RetellListResponse>(
      retellApiKey,
      '/v3/list-calls',
      {
        method: 'POST',
        body: JSON.stringify({
          filter_criteria: {
            agent: [{ agent_id: agentId }],
          },
          sort_order: 'descending',
          limit: 100,
          include_total: false,
        }),
      }
    )

    const listedCalls = Array.isArray(list.items) ? list.items : []
    const detailedCallIds = new Set(
      listedCalls
        .filter((call) => {
          const status = getString(call.call_status)
          return status !== 'ongoing' && status !== 'registered'
        })
        .slice(0, 10)
        .map((call) => getString(call.call_id))
        .filter((callId): callId is string => Boolean(callId))
    )

    const detailedCalls = await Promise.all(
      listedCalls.map((call) =>
        detailedCallIds.has(getString(call.call_id) ?? '')
          ? getRetellCall(retellApiKey, call)
          : Promise.resolve(call)
      )
    )

    const retellRecords = detailedCalls
      .filter((call) => getString(call.call_id))
      .map((call) =>
        toCallRecord(call, user.id, piiRedactionEnabled)
      )

    let storageWarning: string | null = null

    if (retellRecords.length > 0) {
      const { error: upsertError } = await supabaseAdmin
        .from('calls')
        .upsert(retellRecords, {
          onConflict: 'retell_call_id',
        })

      if (upsertError) {
        storageWarning =
          'Calls were loaded from Retell but could not be saved to Supabase. Run supabase_fix_retell_dashboard.sql.'
        console.error('Retell call repair upsert failed:', upsertError)
      }
    }

    const storedByRetellId = new Map(
      (storedCallsResult.data ?? [])
        .filter((call) => call.retell_call_id)
        .map((call) => [call.retell_call_id, call])
    )

    const calls: ClientCallRecord[] = retellRecords.map((record) => {
      const stored = record.retell_call_id
        ? storedByRetellId.get(record.retell_call_id)
        : null

      return {
        id: String(stored?.id ?? record.retell_call_id),
        retell_call_id: record.retell_call_id,
        caller_name: record.caller_name,
        caller_number: record.caller_number,
        started_at: record.started_at,
        duration_seconds: record.duration_seconds,
        outcome: record.outcome,
        appointment_booked: record.appointment_booked,
        call_status: record.call_status,
        transcript: record.transcript ?? stored?.transcript ?? null,
        recording_url:
          record.recording_url ?? stored?.recording_url ?? null,
        summary: record.summary ?? stored?.summary ?? null,
      }
    })

    const retellIds = new Set(
      retellRecords.map((record) => record.retell_call_id)
    )

    for (const storedCall of storedCallsResult.data ?? []) {
      if (
        !storedCall.retell_call_id ||
        !retellIds.has(storedCall.retell_call_id)
      ) {
        calls.push({
          id: String(storedCall.id),
          retell_call_id: storedCall.retell_call_id ?? null,
          caller_name: storedCall.caller_name ?? null,
          caller_number: storedCall.caller_number ?? null,
          started_at: storedCall.started_at,
          duration_seconds:
            Number(storedCall.duration_seconds) || 0,
          outcome: storedCall.outcome ?? null,
          summary: storedCall.summary ?? null,
          appointment_booked:
            storedCall.appointment_booked === true,
          call_status: storedCall.call_status ?? null,
          transcript: storedCall.transcript ?? null,
          recording_url: storedCall.recording_url ?? null,
        })
      }
    }

    calls.sort(
      (a, b) =>
        new Date(b.started_at).getTime() -
        new Date(a.started_at).getTime()
    )

    return json(200, {
      calls,
      activeCalls: calls.filter(
        (call) =>
          call.call_status === 'ongoing' ||
          call.call_status === 'registered'
      ).length,
      scheduleMode: getScheduleMode(
        agentResult.data?.business_hours
      ),
      scheduleEnabled: getSchedulePreference(
        agentResult.data?.business_hours
      ),
      storageWarning,
    })
  } catch (error) {
    console.error('Could not synchronize Retell calls:', error)

    if (storedCallsResult.data) {
      return json(200, {
        calls: storedCallsResult.data,
        activeCalls: storedCallsResult.data.filter(
          (call) =>
            call.call_status === 'ongoing' ||
            call.call_status === 'registered'
        ).length,
        scheduleMode: getScheduleMode(
          agentResult.data?.business_hours
        ),
        scheduleEnabled: getSchedulePreference(
          agentResult.data?.business_hours
        ),
        integrationWarning:
          error instanceof Error
            ? error.message
            : 'Could not load calls from Retell.',
      })
    }

    return json(502, {
      error:
        error instanceof Error
          ? error.message
          : 'Could not load calls from Retell.',
    })
  }
}
