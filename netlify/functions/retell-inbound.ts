import { createClient } from '@supabase/supabase-js'
import {
  formatAppointmentFields,
  normalizeAppointmentFields,
  normalizeEmailNotificationsEnabled,
  normalizeE164,
  normalizeSmsNotificationsEnabled,
  verifyRetellSignature,
} from '../lib/retell'
import {
  buildEmployeeScheduleContext,
  getBusinessTimeZone,
} from '../lib/employeeSchedule'
import { getAnsweringMode, isBusinessOpen } from '../lib/businessHours'
import { getStoredBusinessSchedule } from '../lib/employeeSchedule'
import { getCallMaxSeconds, CALL_MIN_SECONDS } from '../lib/callMinutes'

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
      call_id?: string
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

  const callId = typeof payload.call_inbound.call_id === 'string'
    ? payload.call_inbound.call_id.trim() : null
  if (!callId) {
    console.error('Inbound call has no stable call ID; minute reservation declined.')
    return json(200, { call_inbound: { reject: true } })
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

  const decline = async (reason: 'agent_unavailable' | 'outside_answering_hours' | 'allowance_unavailable' | 'admission_unavailable') => {
    if (agent?.client_id) {
      const result = await supabaseAdmin.rpc('record_recepta_callback', {
        p_client_id: agent.client_id, p_call_id: callId, p_from: normalizeE164(payload.call_inbound?.from_number), p_to: toNumber, p_reason: reason,
      })
      if (result.error) {
        console.error('Could not preserve declined call for callback:', result.error)
        // Let Retell retry; there is no static inbound agent that can bypass admission.
        return json(503, { error: 'Callback storage is temporarily unavailable.' })
      }
    }
    return json(200, { call_inbound: { reject:true } })
  }

  if (!agent?.retell_agent_id || !['active', 'live'].includes(agent.status ?? '')) {
    return decline('agent_unavailable')
  }

  const businessSchedule = getStoredBusinessSchedule(agent.business_hours)
  const customSchedule = businessSchedule.mode === 'custom' ? businessSchedule : null
  const businessOpen = isBusinessOpen(businessSchedule)
  const answeringMode = getAnsweringMode(agent.business_hours)

  if (
    answeringMode === 'business_hours' && !businessOpen
  ) {
    return decline('outside_answering_hours')
  }

  const { data: reservationRows, error: reservationError } = await supabaseAdmin.rpc(
    'reserve_recepta_agent_call', { p_client_id: agent.client_id, p_call_id: callId, p_agent_id: agent.retell_agent_id }
  )
  if (reservationError) {
    console.error('Minute reservation failed; inbound call declined:', reservationError)
    return decline('admission_unavailable')
  }
  const reservation = Array.isArray(reservationRows) ? reservationRows[0] : null
  const reservationId = typeof reservation?.reservation_id === 'string' ? reservation.reservation_id : null
  const reservedSeconds = Number(reservation?.reserved_seconds ?? 0)
  if (!reservationId || typeof reservation?.demo_mode !== 'boolean' || !Number.isInteger(reservedSeconds) ||
      reservedSeconds < CALL_MIN_SECONDS || reservedSeconds > getCallMaxSeconds(reservation.demo_mode)) {
    // A busy or exhausted allowance declines this call; it never disables the
    // customer or unbinds their number. A later call can use released/renewed time.
    return decline('allowance_unavailable')
  }

  const employeeScheduleTimeZone = getBusinessTimeZone(
    agent.business_hours
  )
  let employeeSchedule = `Business timezone: ${employeeScheduleTimeZone}. No active employees are configured.`
  let appointmentFields: string[] = []
  let emailNotificationsEnabled = true
  let smsNotificationsEnabled = false

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

  try {
    const { data: clientUserResult, error: clientUserError } =
      await supabaseAdmin.auth.admin.getUserById(agent.client_id)

    if (clientUserError) throw clientUserError

    appointmentFields = normalizeAppointmentFields(
      clientUserResult.user?.user_metadata?.appointment_custom_fields
    )
    emailNotificationsEnabled = normalizeEmailNotificationsEnabled(
      clientUserResult.user?.user_metadata
        ?.appointment_email_notifications_enabled
    )
    smsNotificationsEnabled = normalizeSmsNotificationsEnabled(
      clientUserResult.user?.user_metadata
        ?.appointment_sms_notifications_enabled
    )
  } catch (error) {
    console.error(
      'Could not load dashboard appointment fields for inbound call:',
      error
    )
  }

  return json(200, {
    call_inbound: {
      override_agent_id:
        agent.retell_agent_id,
      agent_override: {
        agent: {
          max_call_duration_ms:
            reservedSeconds * 1000,
        },
      },
      dynamic_variables: {
        recepta_answering_mode: answeringMode,
        recepta_business_open: businessSchedule.mode === 'unconfigured' ? 'unknown' : businessOpen ? 'open' : 'closed',
        recepta_schedule_mode: businessSchedule.mode,
        recepta_business_hours: customSchedule
          ? JSON.stringify(customSchedule.hours)
          : businessSchedule.mode === 'unconfigured' ? 'Store hours are not configured; do not guess opening hours.' : 'Available 24 hours a day, 7 days a week',
        recepta_business_timezone:
          customSchedule?.timeZone ?? 'America/Toronto',
        recepta_employee_schedule: employeeSchedule,
        recepta_employee_schedule_timezone:
          employeeScheduleTimeZone,
        recepta_appointment_fields:
          formatAppointmentFields(appointmentFields),
        recepta_email_confirmations: emailNotificationsEnabled
          ? 'enabled'
          : 'disabled',
        recepta_sms_confirmations: smsNotificationsEnabled
          ? 'enabled'
          : 'disabled',
      },
      metadata: {
        recepta_client_id: agent.client_id,
        recepta_reservation_id:
          reservationId,
        recepta_answering_mode: answeringMode,
        recepta_business_open: businessSchedule.mode === 'unconfigured' ? 'unknown' : businessOpen ? 'open' : 'closed',
        recepta_schedule_mode: businessSchedule.mode,
      },
    },
  })
}
