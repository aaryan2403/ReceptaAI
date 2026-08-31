import { createClient } from '@supabase/supabase-js'
import {
  normalizeE164,
  syncRetellPhoneBinding,
  verifyRetellSignature,
} from '../lib/retell'

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

const addOneMonth = (date: Date) => {
  const result = new Date(date)
  result.setUTCMonth(result.getUTCMonth() + 1)
  return result
}

export default async (request: Request) => {
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

  if (
    !verifyRetellSignature(
      rawBody,
      request.headers.get('x-retell-signature'),
      retellApiKey
    )
  ) {
    return json(401, {
      error: 'Invalid Retell signature.',
    })
  }

  let payload: {
    event?: string
    call_inbound?: {
      agent_id?: string
      from_number?: string
      to_number?: string
    }
  }

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, {
      error: 'Invalid JSON payload.',
    })
  }

  if (
    payload.event !== 'call_inbound' ||
    !payload.call_inbound
  ) {
    return new Response(null, {
      status: 204,
    })
  }

  const requestedAgentId =
    payload.call_inbound.agent_id?.trim() ||
    null
  const toNumber = normalizeE164(
    payload.call_inbound.to_number
  )

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

  let agent: {
    client_id: string
    retell_agent_id: string | null
    phone_number: string | null
    status: string | null
  } | null = null

  if (toNumber) {
    const { data, error } =
      await supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, status'
        )
        .eq('phone_number', toNumber)
        .maybeSingle()

    if (error) {
      return json(500, {
        error: 'Could not resolve phone number.',
      })
    }

    agent = data
  }

  if (!agent && requestedAgentId) {
    const { data, error } =
      await supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, status'
        )
        .eq('retell_agent_id', requestedAgentId)
        .maybeSingle()

    if (error) {
      return json(500, {
        error: 'Could not resolve Retell agent.',
      })
    }

    agent = data
  }

  if (!agent?.retell_agent_id) {
    return json(200, {
      call_inbound: {
        reject: true,
      },
    })
  }

  const {
    data: subscription,
    error: subscriptionError,
  } = await supabaseAdmin
    .from('subscriptions')
    .select(
      'status, monthly_minutes, current_period_start, current_period_end'
    )
    .eq('client_id', agent.client_id)
    .maybeSingle()

  if (subscriptionError) {
    return json(500, {
      error: 'Could not load subscription.',
    })
  }

  if (
    !subscription ||
    subscription.status !== 'active'
  ) {
    return json(200, {
      call_inbound: {
        reject: true,
      },
    })
  }

  const now = new Date()
  let periodStart =
    subscription.current_period_start
      ? new Date(
          subscription.current_period_start
        )
      : now
  let periodEnd =
    subscription.current_period_end
      ? new Date(
          subscription.current_period_end
        )
      : addOneMonth(periodStart)

  const periodExpired =
    !Number.isFinite(periodEnd.getTime()) ||
    periodEnd <= now

  if (
    !Number.isFinite(periodStart.getTime()) ||
    periodExpired
  ) {
    periodStart = now
    periodEnd = addOneMonth(now)

    const { error: periodUpdateError } =
      await supabaseAdmin
        .from('subscriptions')
        .update({
          current_period_start:
            periodStart.toISOString(),
          current_period_end:
            periodEnd.toISOString(),
          next_billing_date:
            periodEnd.toISOString(),
        })
        .eq('client_id', agent.client_id)

    if (periodUpdateError) {
      return json(500, {
        error: 'Could not start billing period.',
      })
    }

    await Promise.all([
      supabaseAdmin
        .from('clients')
        .update({ status: 'live' })
        .eq('id', agent.client_id),
      supabaseAdmin
        .from('agents')
        .update({ status: 'live' })
        .eq('client_id', agent.client_id),
    ])

    try {
      await syncRetellPhoneBinding({
        apiKey: retellApiKey,
        agentId: agent.retell_agent_id,
        phoneNumber: agent.phone_number,
        active: true,
      })
    } catch (error) {
      console.error(
        'Could not restore Retell phone binding:',
        error
      )
    }
  }

  const monthlyMinutes = Number(
    subscription.monthly_minutes
  )

  if (
    !Number.isFinite(monthlyMinutes) ||
    monthlyMinutes < 1
  ) {
    return json(200, {
      call_inbound: {
        reject: true,
      },
    })
  }

  const {
    data: reservationRows,
    error: reservationError,
  } = await supabaseAdmin.rpc(
    'reserve_recepta_call',
    {
      p_client_id: agent.client_id,
      p_monthly_seconds:
        Math.floor(monthlyMinutes) * 60,
      p_period_start:
        periodStart.toISOString(),
    }
  )

  if (reservationError) {
    console.error(
      'Minute reservation failed:',
      reservationError
    )

    return json(500, {
      error: 'Could not reserve call minutes.',
    })
  }

  const reservation = Array.isArray(
    reservationRows
  )
    ? reservationRows[0]
    : null
  const reservationId =
    typeof reservation?.reservation_id ===
    'string'
      ? reservation.reservation_id
      : null
  const reservedSeconds = Number(
    reservation?.reserved_seconds ?? 0
  )

  if (
    !reservationId ||
    !Number.isFinite(reservedSeconds) ||
    reservedSeconds < 60
  ) {
    await Promise.all([
      supabaseAdmin
        .from('clients')
        .update({ status: 'paused' })
        .eq('id', agent.client_id),
      supabaseAdmin
        .from('agents')
        .update({ status: 'paused' })
        .eq('client_id', agent.client_id),
    ])

    try {
      await syncRetellPhoneBinding({
        apiKey: retellApiKey,
        agentId: agent.retell_agent_id,
        phoneNumber: agent.phone_number,
        active: false,
      })
    } catch (error) {
      console.error(
        'Could not pause Retell phone binding:',
        error
      )
    }

    return json(200, {
      call_inbound: {
        reject: true,
      },
    })
  }

  return json(200, {
    call_inbound: {
      override_agent_id:
        agent.retell_agent_id,
      agent_override: {
        agent: {
          max_call_duration_ms:
            Math.min(
              7_200_000,
              Math.floor(reservedSeconds) * 1000
            ),
        },
      },
      metadata: {
        recepta_client_id: agent.client_id,
        recepta_reservation_id:
          reservationId,
      },
    },
  })
}
