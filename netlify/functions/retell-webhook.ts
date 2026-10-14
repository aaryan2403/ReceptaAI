import { isConfirmedAppointment } from '../../src/lib/appointmentRequests'
import { createClient } from '@supabase/supabase-js'
import {
  syncRetellPhoneBindings,
  verifyRetellSignature,
} from '../lib/retell'
import { deliverCallNotices } from '../lib/callNotifications'
import { deliverBillingNotices, getBillingUsage, queueUsageNotice } from '../lib/billingNotifications'

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

  console.info('Retell lifecycle event received:', {
    event: payload.event,
    callId,
    agentId,
    callStatus: call.call_status ?? null,
  })

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
    .select('client_id, phone_number, business_hours')
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
    console.error(
      'Retell agent is not assigned to a Recepta client:',
      agentId
    )

    return json(409, {
      error:
        'This Retell Agent ID is not assigned to a Recepta client.',
    })
  }

  let {
    data: subscription,
    error: subscriptionError,
  } = await supabaseAdmin
    .from('subscriptions')
    .select(
      'client_id, stripe_subscription_id, plan_name, monthly_price, status, monthly_minutes, rollover_seconds, current_period_start, current_period_end, pii_redaction_enabled'
    )
    .eq('client_id', agent.client_id)
    .maybeSingle()

  if (
    subscriptionError?.message
      ?.toLowerCase()
      .includes('rollover_seconds')
  ) {
    const fallback = await supabaseAdmin
      .from('subscriptions')
      .select(
        'client_id, stripe_subscription_id, plan_name, monthly_price, status, monthly_minutes, current_period_start, current_period_end, pii_redaction_enabled'
      )
      .eq('client_id', agent.client_id)
      .maybeSingle()

    subscription = fallback.data
      ? {
          ...fallback.data,
          rollover_seconds: 0,
        }
      : null
    subscriptionError = fallback.error
  }

  if (subscriptionError) {
    return json(500, {
      error: 'Could not load client subscription.',
    })
  }

  const piiRedactionEnabled =
    subscription?.pii_redaction_enabled ===
    true

  const dynamicVariables =
    call.retell_llm_dynamic_variables ?? {}
  const metadata = call.metadata ?? {}
  const analysis = call.call_analysis

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

  const reportedStatus = getString(
    call.call_status
  )

  const callStatus =
    payload.event === 'call_started'
      ? reportedStatus === 'registered'
        ? 'registered'
        : 'ongoing'
      : reportedStatus === 'error' || reportedStatus === 'not_connected'
        ? reportedStatus
        : 'ended'

  const record: Record<string, unknown> = {
    client_id: agent.client_id,
    retell_call_id: callId,
    caller_name: callerName,
    caller_number: callerNumber,
    started_at: startedAt,
    duration_seconds:
      getDurationSeconds(call),
    call_status: callStatus,
    lifecycle_rank: payload.event === 'call_analyzed' ? 3 : payload.event === 'call_ended' ? 2 : callStatus === 'ongoing' ? 1 : 0,
    ended_at: payload.event === 'call_started' ? null : timestampToIso(call.end_timestamp),
    media_redacted: piiRedactionEnabled,
    transcript: null,
    recording_url: null,
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
    const { data: confirmedAppointments, error: appointmentError } = await supabaseAdmin
      .from('appointments')
      .select('status, appointment_time, retell_call_id')
      .eq('client_id', agent.client_id)
      .eq('retell_call_id', callId)
      .in('status', ['booked', 'completed'])

    if (appointmentError) console.error('Could not verify confirmed appointments:', appointmentError)
    record.appointment_booked = (confirmedAppointments ?? []).some((appointment) =>
      appointment.retell_call_id?.split(':')[0] === callId && isConfirmedAppointment(appointment)
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

  const shouldNotifyOwner = subscription?.status === 'active' && (
    (subscription.plan_name === 'Recepta Standard' &&
      (payload.event === 'call_ended' || payload.event === 'call_analyzed')) ||
    (subscription.plan_name === 'Recepta Pro' && payload.event === 'call_analyzed')
  )
  if (shouldNotifyOwner) record.owner_notification_requested = true
  record.retell_agent_id = agentId

  const { data: savedCall, error: upsertError } =
    await supabaseAdmin
      .from('calls')
      .upsert(record, {
        onConflict: 'retell_call_id',
      })
      .select('call_status, duration_seconds, ended_at')
      .maybeSingle()

  if (upsertError || !savedCall) {
    console.error(
      'Retell call upsert failed:',
      upsertError
    )

    return json(500, {
      error: 'Could not save Retell call.',
    })
  }

  console.info('Retell call saved for Recepta client:', {
    event: payload.event,
    callId,
    clientId: agent.client_id,
    callStatus: savedCall.call_status,
  })

  if (shouldNotifyOwner) {
    try {
      await deliverCallNotices(supabaseAdmin, 1, `owner-call:${agent.client_id}:${callId}`)
    } catch (notificationError) {
      // The call upsert atomically enqueued the notice. Scheduled retries recover
      // even if this attempt fails or the webhook is never replayed.
      console.error('Owner call email remains queued:', notificationError)
    }
  }

  if (
    payload.event === 'call_ended' ||
    payload.event === 'call_analyzed'
  ) {
    const reservationId = getString(
      metadata.recepta_reservation_id
    )

    if (reservationId) {
      const { error: reservationError } =
        await supabaseAdmin
          .from('call_minute_reservations')
          .update({
            status: 'completed',
            used_seconds:
              savedCall.duration_seconds,
            completed_at:
              new Date().toISOString(),
          })
          .eq('id', reservationId)
          .eq('client_id', agent.client_id)

      if (reservationError) {
        console.error(
          'Could not finalize minute reservation:',
          reservationError
        )
      }
    }

    const periodStart =
      subscription?.current_period_start

    const monthlyMinutes = Number(
      subscription?.monthly_minutes ?? 0
    )
    const rolloverSeconds = Math.max(
      0,
      Number(subscription?.rollover_seconds ?? 0) || 0
    )
    const availableSeconds =
      Math.floor(monthlyMinutes) * 60 +
      Math.floor(rolloverSeconds)

    if (
      subscription?.status === 'active' &&
      periodStart &&
      Number.isFinite(monthlyMinutes) &&
      monthlyMinutes > 0
    ) {
      const usedSeconds = await getBillingUsage(supabaseAdmin, subscription)
      await queueUsageNotice(supabaseAdmin, subscription, usedSeconds)
      try { await deliverBillingNotices(supabaseAdmin, 1) }
      catch (notificationError) { console.error('Usage notice delivery deferred:', notificationError) }

      if (
        usedSeconds >=
        availableSeconds
      ) {
        const [agentPause, clientPause] =
          await Promise.all([
            supabaseAdmin
              .from('agents')
              .update({ status: 'paused' })
              .eq('client_id', agent.client_id),
            supabaseAdmin
              .from('clients')
              .update({ status: 'paused' })
              .eq('id', agent.client_id),
          ])

        if (agentPause.error) {
          throw agentPause.error
        }

        if (clientPause.error) {
          throw clientPause.error
        }

        const { data: phoneRows, error: phoneRowsError } =
          await supabaseAdmin
            .from('agent_phone_numbers')
            .select('phone_number')
            .eq('client_id', agent.client_id)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: true })

        if (phoneRowsError) throw phoneRowsError

        const phoneNumbers = (phoneRows ?? []).map(
          (row) => row.phone_number
        )

        if (phoneNumbers.length === 0 && agent.phone_number) {
          phoneNumbers.push(agent.phone_number)
        }

        await syncRetellPhoneBindings({
          apiKey: retellApiKey,
          agentId,
          phoneNumbers,
          active: false,
        })
      }
    }
  }

  return new Response(null, {
    status: 204,
  })
}
