import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

type RetellEvent =
  | 'call_started'
  | 'call_ended'
  | 'call_analyzed'

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

const json = (
  status: number,
  body: Record<string, unknown>
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })

const verifyRetellSignature = (
  rawBody: string,
  signature: string | null,
  apiKey: string
) => {
  if (!signature) return false

  const match =
    /^v=(\d+),d=([a-fA-F0-9]+)$/.exec(
      signature.trim()
    )

  if (!match) return false

  const timestamp = Number(match[1])
  const suppliedDigest = match[2]

  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) >
      5 * 60 * 1000
  ) {
    return false
  }

  const expectedDigest = createHmac(
    'sha256',
    apiKey
  )
    .update(`${rawBody}${timestamp}`)
    .digest('hex')

  const expected = Buffer.from(
    expectedDigest,
    'hex'
  )
  const supplied = Buffer.from(
    suppliedDigest,
    'hex'
  )

  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  )
}

const timestampToIso = (
  timestamp?: number
) => {
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp)
  ) {
    return null
  }

  return new Date(timestamp).toISOString()
}

const getDurationSeconds = (
  call: RetellCall
) => {
  if (
    typeof call.duration_ms === 'number' &&
    Number.isFinite(call.duration_ms)
  ) {
    return Math.max(
      0,
      Math.round(call.duration_ms / 1000)
    )
  }

  if (
    typeof call.start_timestamp === 'number' &&
    typeof call.end_timestamp === 'number'
  ) {
    return Math.max(
      0,
      Math.round(
        (call.end_timestamp -
          call.start_timestamp) /
          1000
      )
    )
  }

  return 0
}

const getString = (
  value: unknown
) =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : null

const getBoolean = (
  value: unknown
) => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }

  return false
}

export default async (
  request: Request
) => {
  if (request.method !== 'POST') {
    return json(405, {
      error: 'Method not allowed.',
    })
  }

  const supabaseUrl =
    process.env.SUPABASE_URL
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY
  const retellApiKey =
    process.env.RETELL_API_KEY

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !retellApiKey
  ) {
    return json(500, {
      error: 'Server configuration is missing.',
    })
  }

  const rawBody = await request.text()
  const signature = request.headers.get(
    'x-retell-signature'
  )

  if (
    !verifyRetellSignature(
      rawBody,
      signature,
      retellApiKey
    )
  ) {
    return json(401, {
      error: 'Invalid Retell signature.',
    })
  }

  let payload: {
    event?: RetellEvent | string
    call?: RetellCall
  }

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, {
      error: 'Invalid JSON payload.',
    })
  }

  if (
    payload.event !== 'call_started' &&
    payload.event !== 'call_ended' &&
    payload.event !== 'call_analyzed'
  ) {
    return new Response(null, {
      status: 204,
    })
  }

  const call = payload.call
  const callId = getString(call?.call_id)
  const agentId = getString(call?.agent_id)

  if (!call || !callId || !agentId) {
    return json(400, {
      error: 'Missing call or agent ID.',
    })
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

  const {
    data: agent,
    error: agentError,
  } = await supabaseAdmin
    .from('agents')
    .select('client_id')
    .eq('retell_agent_id', agentId)
    .maybeSingle()

  if (agentError) {
    console.error(
      'Retell agent lookup failed:',
      agentError
    )

    return json(500, {
      error: 'Could not resolve Retell agent.',
    })
  }

  if (!agent?.client_id) {
    console.warn(
      'Ignoring call for an unassigned Retell agent:',
      agentId
    )

    return new Response(null, {
      status: 204,
    })
  }

  const {
    data: subscription,
  } = await supabaseAdmin
    .from('subscriptions')
    .select('pii_redaction_enabled')
    .eq('client_id', agent.client_id)
    .maybeSingle()

  const piiRedactionEnabled =
    subscription?.pii_redaction_enabled ===
    true

  const dynamicVariables =
    call.retell_llm_dynamic_variables ?? {}
  const metadata = call.metadata ?? {}
  const analysis = call.call_analysis
  const customAnalysis =
    analysis?.custom_analysis_data ?? {}

  const callerName =
    getString(
      dynamicVariables.customer_name
    ) ?? getString(metadata.customer_name)

  const callerNumber =
    call.direction === 'outbound'
      ? getString(call.to_number)
      : getString(call.from_number)

  const startedAt =
    timestampToIso(
      call.start_timestamp
    ) ?? new Date().toISOString()

  const callStatus =
    getString(call.call_status) ??
    (payload.event === 'call_started'
      ? 'ongoing'
      : 'ended')

  const record: Record<string, unknown> = {
    client_id: agent.client_id,
    retell_call_id: callId,
    caller_name: callerName,
    caller_number: callerNumber,
    started_at: startedAt,
    duration_seconds:
      getDurationSeconds(call),
    call_status: callStatus,
    disconnection_reason:
      getString(
        call.disconnection_reason
      ),
    updated_at: new Date().toISOString(),
  }

  if (payload.event === 'call_started') {
    record.outcome = 'In progress'
    record.appointment_booked = false
  }

  if (
    payload.event === 'call_ended' ||
    payload.event === 'call_analyzed'
  ) {
    record.outcome =
      getString(
        call.disconnection_reason
      ) ?? 'Completed'

    record.transcript =
      piiRedactionEnabled
        ? getString(
            call.scrubbed_transcript
          )
        : getString(call.transcript)

    record.recording_url =
      piiRedactionEnabled
        ? getString(
            call.scrubbed_recording_url
          )
        : getString(call.recording_url)
  }

  if (payload.event === 'call_analyzed') {
    record.summary =
      getString(analysis?.call_summary)
    record.user_sentiment =
      getString(analysis?.user_sentiment)
    record.call_successful =
      analysis?.call_successful ?? null
    record.appointment_booked =
      getBoolean(
        customAnalysis.appointment_booked
      )

    if (
      typeof analysis?.call_successful ===
      'boolean'
    ) {
      record.outcome =
        analysis.call_successful
          ? 'Successful'
          : 'Unsuccessful'
    }
  }

  const { error: upsertError } =
    await supabaseAdmin
      .from('calls')
      .upsert(record, {
        onConflict: 'retell_call_id',
      })

  if (upsertError) {
    console.error(
      'Retell call upsert failed:',
      upsertError
    )

    return json(500, {
      error: 'Could not save Retell call.',
    })
  }

  return new Response(null, {
    status: 204,
  })
}
