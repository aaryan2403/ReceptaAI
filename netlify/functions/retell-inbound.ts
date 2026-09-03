import { createClient } from '@supabase/supabase-js'
import {
  normalizeE164,
  syncRetellPhoneBinding,
  verifyRetellSignature,
} from '../lib/retell'
import {
  buildEmployeeScheduleContext,
  getBusinessTimeZone,
} from '../lib/employeeSchedule'

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

type OperatingDay = {
  day: string
  open: boolean
  start: string
  end: string
}

type StoredSchedule = {
  mode: '24/7' | 'custom'
  timeZone: string
  hours: OperatingDay[]
}

const DAY_ORDER = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

const parseSchedule = (
  businessHours?: string | null
): StoredSchedule | null => {
  const normalized = businessHours?.trim().toLowerCase()

  if (
    !normalized ||
    normalized === 'not configured' ||
    normalized === 'not required' ||
    normalized === '24/7'
  ) {
    return null
  }

  try {
    const parsed = JSON.parse(businessHours ?? '') as
      | OperatingDay[]
      | Partial<StoredSchedule>
    const hours = Array.isArray(parsed) ? parsed : parsed.hours
    const mode = Array.isArray(parsed) ? 'custom' : parsed.mode

    if (mode === '24/7') return null

    if (
      mode !== 'custom' ||
      !Array.isArray(hours) ||
      hours.length !== 7
    ) {
      return null
    }

    return {
      mode: 'custom',
      timeZone:
        !Array.isArray(parsed) &&
        typeof parsed.timeZone === 'string' &&
        parsed.timeZone.trim()
          ? parsed.timeZone
          : 'America/Toronto',
      hours,
    }
  } catch {
    return null
  }
}

const isInsideCustomHours = (
  schedule: StoredSchedule,
  date = new Date()
) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timeZone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value])
    )
    const day = values.weekday
    const currentMinutes =
      Number(values.hour) * 60 + Number(values.minute)
    const today = schedule.hours.find((item) => item.day === day)

    if (today?.open) {
      const start = toMinutes(today.start)
      const end = toMinutes(today.end)

      if (
        (end > start &&
          currentMinutes >= start &&
          currentMinutes < end) ||
        (end < start && currentMinutes >= start)
      ) {
        return true
      }
    }

    const dayIndex = DAY_ORDER.indexOf(day)
    const previousDay =
      DAY_ORDER[(dayIndex + DAY_ORDER.length - 1) % DAY_ORDER.length]
    const previous = schedule.hours.find(
      (item) => item.day === previousDay
    )

    if (previous?.open) {
      const previousStart = toMinutes(previous.start)
      const previousEnd = toMinutes(previous.end)

      if (
        previousEnd < previousStart &&
        currentMinutes < previousEnd
      ) {
        return true
      }
    }

    return false
  } catch (error) {
    console.error('Could not evaluate custom hours:', error)
    return true
  }
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
    business_hours: string | null
    status: string | null
  } | null = null

  if (toNumber) {
    const { data: assignedPhone, error: phoneLookupError } =
      await supabaseAdmin
        .from('agent_phone_numbers')
        .select('client_id')
        .eq('phone_number', toNumber)
        .maybeSingle()

    if (phoneLookupError) {
      return json(500, {
        error: 'Could not resolve phone number.',
      })
    }

    if (assignedPhone?.client_id) {
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, business_hours, status'
        )
        .eq('client_id', assignedPhone.client_id)
        .maybeSingle()

      if (error) {
        return json(500, {
          error: 'Could not resolve assigned agent.',
        })
      }

      agent = data
    }

    if (!agent) {
      const { data, error } = await supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, business_hours, status'
        )
        .eq('phone_number', toNumber)
        .maybeSingle()

      if (error) {
        return json(500, {
          error: 'Could not resolve legacy phone number.',
        })
      }

      agent = data
    }
  }

  if (!agent && requestedAgentId) {
    const { data, error } =
      await supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, business_hours, status'
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

  const customSchedule = parseSchedule(agent.business_hours)

  if (
    customSchedule &&
    !isInsideCustomHours(customSchedule)
  ) {
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

  const employeeScheduleTimeZone = getBusinessTimeZone(
    agent.business_hours
  )
  let employeeSchedule = `Business timezone: ${employeeScheduleTimeZone}. No active employees are configured.`

  try {
    const { data: employees, error: employeesError } =
      await supabaseAdmin
        .from('employees')
        .select('id, name, role, is_active')
        .eq('client_id', agent.client_id)
        .order('created_at', { ascending: true })

    if (employeesError) throw employeesError

    const employeeRows = employees ?? []
    const employeeIds = employeeRows.map((employee) => employee.id)
    let scheduleRows: Array<{
      employee_id: string
      day_of_week: number
      is_working: boolean
      start_time: string | null
      end_time: string | null
    }> = []

    if (employeeIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('employee_schedules')
        .select(
          'employee_id, day_of_week, is_working, start_time, end_time'
        )
        .in('employee_id', employeeIds)
        .order('day_of_week', { ascending: true })

      if (error) throw error
      scheduleRows = data ?? []
    }

    employeeSchedule = buildEmployeeScheduleContext({
      employees: employeeRows,
      schedules: scheduleRows,
      timeZone: employeeScheduleTimeZone,
    })
  } catch (error) {
    console.error(
      'Could not load employee availability for inbound call:',
      error
    )
    employeeSchedule = `Business timezone: ${employeeScheduleTimeZone}. Employee availability is temporarily unavailable; do not invent an employee schedule.`
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
        phoneNumber: toNumber ?? agent.phone_number,
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
        phoneNumber: toNumber ?? agent.phone_number,
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
              180_000,
              Math.floor(reservedSeconds) * 1000
            ),
        },
      },
      dynamic_variables: {
        recepta_schedule_mode: customSchedule ? 'custom' : '24/7',
        recepta_business_hours: customSchedule
          ? JSON.stringify(customSchedule.hours)
          : 'Available 24 hours a day, 7 days a week',
        recepta_business_timezone:
          customSchedule?.timeZone ?? 'America/Toronto',
        recepta_employee_schedule: employeeSchedule,
        recepta_employee_schedule_timezone:
          employeeScheduleTimeZone,
      },
      metadata: {
        recepta_client_id: agent.client_id,
        recepta_reservation_id:
          reservationId,
        recepta_schedule_mode: customSchedule ? 'custom' : '24/7',
      },
    },
  })
}
