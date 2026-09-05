import { createClient } from '@supabase/supabase-js'
import {
  assertExactSlotAvailable,
  findAvailableSlots,
  getClientCalendar,
  normalizeCalendarDate,
  normalizeCalendarTime,
  normalizeDuration,
} from '../lib/calendar'
import { sendAppointmentConfirmations } from '../lib/appointmentEmail'
import { verifyRetellSignature } from '../lib/retell'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const requiredText = (value: unknown, label: string, maximum = 300) => {
  const normalized = typeof value === 'string' ? value.trim() : ''

  if (!normalized) throw new Error(`${label} is required.`)
  if (normalized.length > maximum) {
    throw new Error(`${label} is too long.`)
  }

  return normalized
}

const optionalText = (value: unknown, maximum = 1000) => {
  const normalized = typeof value === 'string' ? value.trim() : ''

  if (normalized.length > maximum) throw new Error('A booking field is too long.')

  return normalized || null
}

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const retellApiKey = process.env.RETELL_API_KEY

  if (!supabaseUrl || !supabaseSecretKey || !retellApiKey) {
    return json(500, { error: 'Recepta calendar integration is not configured.' })
  }

  const rawBody = await request.text()

  if (
    !verifyRetellSignature(
      rawBody,
      request.headers.get('x-retell-signature'),
      retellApiKey
    )
  ) {
    return json(401, { error: 'Invalid Retell signature.' })
  }

  let payload: {
    name?: string
    args?: Record<string, unknown>
    call?: {
      call_id?: string
      agent_id?: string
      metadata?: Record<string, unknown>
    }
  }

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json(400, { error: 'Invalid JSON payload.' })
  }

  const functionName = payload.name?.trim()
  const agentId = payload.call?.agent_id?.trim()
  const metadataClientId = payload.call?.metadata?.recepta_client_id
  const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  let clientId =
    typeof metadataClientId === 'string' && metadataClientId.trim()
      ? metadataClientId.trim()
      : null

  if (!clientId && agentId) {
    const { data: agent, error } = await supabaseAdmin
      .from('agents')
      .select('client_id')
      .eq('retell_agent_id', agentId)
      .maybeSingle()

    if (error) {
      return json(500, { error: 'Could not resolve the assigned Recepta account.' })
    }

    clientId = agent?.client_id ?? null
  }

  if (!clientId) {
    return json(404, { error: 'This Retell agent is not assigned to a Recepta account.' })
  }

  const { data: subscription, error: subscriptionError } =
    await supabaseAdmin
      .from('subscriptions')
      .select('plan_name, status')
      .eq('client_id', clientId)
      .maybeSingle()

  if (subscriptionError) {
    return json(500, { error: 'Could not verify appointment-booking access.' })
  }

  if (
    subscription?.status !== 'active' ||
    subscription.plan_name !== 'Recepta Pro'
  ) {
    return json(403, {
      error: 'Appointment booking is not active for this Recepta account.',
    })
  }

  const args = payload.args ?? {}

  try {
    if (functionName === 'recepta_list_employees') {
      const { data, error } = await supabaseAdmin
        .from('employees')
        .select('name, role')
        .eq('client_id', clientId)
        .eq('is_active', true)
        .order('name', { ascending: true })

      if (error) throw error

      return json(200, {
        success: true,
        employees: data ?? [],
        instruction:
          data && data.length > 0
            ? 'Let the caller choose an employee, or offer to find the earliest available employee.'
            : 'No active employees are currently available for booking.',
      })
    }

    if (functionName === 'recepta_check_availability') {
      const date = normalizeCalendarDate(args.date)
      const durationMinutes = normalizeDuration(args.duration_minutes)
      const employeeName = optionalText(args.employee_name, 160)
      const preferredTime = args.preferred_time
        ? normalizeCalendarTime(args.preferred_time)
        : null
      const result = await findAvailableSlots({
        supabase: supabaseAdmin,
        clientId,
        date,
        employeeName,
        durationMinutes,
        preferredTime,
      })

      return json(200, {
        success: true,
        date,
        time_zone: result.timeZone,
        requested_employee: employeeName,
        available_slots: result.slots.map((slot) => ({
          employee_name: slot.employeeName,
          employee_role: slot.employeeRole,
          start_iso: slot.start,
          end_iso: slot.end,
          spoken_time: slot.display,
        })),
        instruction:
          result.slots.length > 0
            ? 'Offer no more than three of these exact available slots. Do not describe any other time as available.'
            : 'No matching slots are available on this date. Ask the caller for another date, time, or employee.',
      })
    }

    if (functionName !== 'recepta_book_appointment') {
      return json(400, { error: 'Unknown Recepta calendar function.' })
    }

    const employeeName = requiredText(args.employee_name, 'Employee name', 160)
    const date = normalizeCalendarDate(args.date)
    const time = normalizeCalendarTime(args.time)
    const durationMinutes = normalizeDuration(args.duration_minutes)
    const customerName = requiredText(args.customer_name, 'Customer name', 160)
    const customerEmail = requiredText(args.customer_email, 'Customer email', 320)
    const customerPhone = optionalText(args.customer_phone, 60)
    const customerCompany = optionalText(args.customer_company, 200)
    const service = optionalText(args.service, 300)
    const notes = optionalText(args.notes, 1000)
    const calendar = await getClientCalendar({
      supabase: supabaseAdmin,
      clientId,
      date,
    })
    const query = employeeName.toLowerCase()
    const matches = calendar.employees.filter(
      (employee) =>
        employee.is_active &&
        (employee.name.toLowerCase() === query ||
          employee.name.toLowerCase().includes(query))
    )

    if (matches.length === 0) {
      return json(409, {
        success: false,
        error: `No active employee matches “${employeeName}”. Check the employee list again.`,
      })
    }

    if (matches.length > 1) {
      return json(409, {
        success: false,
        error: `More than one employee matches “${employeeName}”. Ask the caller to choose the full employee name.`,
        matches: matches.map((employee) => employee.name),
      })
    }

    const employee = matches[0]
    const callId = payload.call?.call_id?.trim() || 'retell-call'
    const bookingKey = [callId, employee.id, date, time].join(':')
    const { data: existing } = await supabaseAdmin
      .from('appointments')
      .select(
        'id, appointment_time, appointment_end_time, duration_minutes, status'
      )
      .eq('retell_call_id', bookingKey)
      .maybeSingle()

    if (existing) {
      return json(200, {
        success: true,
        appointment_id: existing.id,
        employee_name: employee.name,
        start_iso: existing.appointment_time,
        end_iso: existing.appointment_end_time,
        confirmation: 'This appointment was already booked successfully.',
      })
    }

    const exactSlot = await assertExactSlotAvailable({
      supabase: supabaseAdmin,
      clientId,
      employeeId: employee.id,
      date,
      time,
      durationMinutes,
    })

    const { data: appointmentId, error: rpcError } =
      await supabaseAdmin.rpc('recepta_book_employee_appointment', {
        p_client_id: clientId,
        p_employee_id: employee.id,
        p_start: exactSlot.start,
        p_duration_minutes: durationMinutes,
        p_customer_name: customerName,
        p_customer_email: customerEmail,
        p_customer_phone: customerPhone,
        p_company_name: customerCompany,
        p_service: service,
        p_notes: notes,
        p_internal_notes: null,
        p_source: 'retell',
        p_retell_call_id: bookingKey,
      })

    if (rpcError || !appointmentId) {
      return json(409, {
        success: false,
        error:
          rpcError?.message ||
          'That time was taken before the booking completed. Check availability again.',
      })
    }

    const emailResult = await sendAppointmentConfirmations({
      businessName: exactSlot.business?.company_name || 'the business',
      businessOwnerEmail: exactSlot.business?.contact_email,
      customerName,
      customerEmail,
      customerPhone,
      customerCompany,
      employeeName: employee.name,
      employeeEmail: employee.email,
      service,
      notes,
      start: exactSlot.start,
      end: exactSlot.end,
      timeZone: exactSlot.timeZone,
    })

    return json(200, {
      success: true,
      appointment_id: appointmentId,
      employee_name: employee.name,
      start_iso: exactSlot.start,
      end_iso: exactSlot.end,
      time_zone: exactSlot.timeZone,
      confirmation_email_sent: emailResult.sent,
      email_warning: emailResult.warning,
      confirmation:
        'The appointment is booked. Tell the caller the employee, date, and time exactly as returned.',
    })
  } catch (error) {
    return json(400, {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'The Recepta calendar request failed.',
    })
  }
}
