import { createClient } from '@supabase/supabase-js'
import {
  assertExactSlotAvailable,
  getClientCalendar,
  localDateTimeToUtc,
  normalizeCalendarDate,
  normalizeCalendarTime,
  normalizeDuration,
} from '../lib/calendar'
import { sendAppointmentConfirmations } from '../lib/appointmentEmail'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const text = (
  value: unknown,
  maximum: number,
  required = false
) => {
  const normalized = typeof value === 'string' ? value.trim() : ''

  if (required && !normalized) {
    throw new Error('Complete all required fields.')
  }

  if (normalized.length > maximum) {
    throw new Error(`A field exceeds the ${maximum}-character limit.`)
  }

  return normalized || null
}

export default async (request: Request) => {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const authHeader = request.headers.get('authorization')

  if (!supabaseUrl || !supabaseSecretKey) {
    return json(500, { error: 'Calendar server configuration is missing.' })
  }

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized.' })
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(
    authHeader.slice('Bearer '.length)
  )

  if (userError || !user) {
    return json(401, { error: 'Unauthorized.' })
  }

  const { data: subscription, error: subscriptionError } =
    await supabaseAdmin
      .from('subscriptions')
      .select('plan_name, status')
      .eq('client_id', user.id)
      .maybeSingle()

  if (subscriptionError) {
    return json(500, { error: 'Could not verify calendar access.' })
  }

  if (
    subscription?.status !== 'active' ||
    subscription.plan_name !== 'Recepta Pro'
  ) {
    return json(403, {
      error: 'The employee appointment calendar requires an active Recepta Pro plan.',
    })
  }

  if (request.method === 'GET') {
    const url = new URL(request.url)
    const date =
      url.searchParams.get('start') ||
      url.searchParams.get('date') ||
      new Date().toISOString().slice(0, 10)
    const endDate = url.searchParams.get('end') || undefined

    try {
      const calendar = await getClientCalendar({
        supabase: supabaseAdmin,
        clientId: user.id,
        date,
        endDate,
      })

      return json(200, { calendar })
    } catch (error) {
      return json(400, {
        error:
          error instanceof Error
            ? error.message
            : 'Could not load the employee calendar.',
      })
    }
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url)
    const kind = url.searchParams.get('kind')
    const id = url.searchParams.get('id')?.trim()

    if (!id || kind !== 'block') {
      return json(400, { error: 'Choose an item to delete.' })
    }

    const { error } = await supabaseAdmin
      .from('employee_calendar_blocks')
      .delete()
      .eq('id', id)
      .eq('client_id', user.id)

    if (error) return json(400, { error: error.message })

    return json(200, { success: true })
  }

  let body: Record<string, unknown>

  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json(400, { error: 'Invalid request body.' })
  }

  if (request.method === 'PATCH') {
    const id = text(body.id, 100, true)!
    const action = text(body.action, 30) || 'status'

    if (action === 'details') {
      try {
        const customerName = text(body.customerName, 160, true)!
        const customerEmail = text(body.customerEmail, 320)
        const customerPhone = text(body.customerPhone, 60)
        const companyName = text(body.companyName, 200)
        const service = text(body.service, 240)
        const notes = text(body.notes, 2000)
        const internalNotes = text(body.internalNotes, 4000)

        const { data, error } = await supabaseAdmin
          .from('appointments')
          .update({
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,
            company_name: companyName,
            service,
            notes,
            internal_notes: internalNotes,
            updated_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('client_id', user.id)
          .select(
            'id, employee_id, customer_name, customer_phone, customer_email, company_name, service, notes, internal_notes, appointment_time, appointment_end_time, duration_minutes, status, source'
          )
          .single()

        if (error || !data) {
          return json(400, {
            error: error?.message || 'Could not update the appointment.',
          })
        }

        return json(200, { appointment: data })
      } catch (error) {
        return json(400, {
          error:
            error instanceof Error
              ? error.message
              : 'Could not update the appointment.',
        })
      }
    }

    const status = text(body.status, 20, true)

    if (!['booked', 'completed', 'cancelled'].includes(status || '')) {
      return json(400, { error: 'Choose a valid appointment status.' })
    }

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('client_id', user.id)
      .select(
        'id, employee_id, customer_name, customer_phone, customer_email, company_name, service, notes, internal_notes, appointment_time, appointment_end_time, duration_minutes, status, source'
      )
      .single()

    if (error || !data) {
      return json(400, {
        error: error?.message || 'Could not update the appointment.',
      })
    }

    return json(200, { appointment: data })
  }

  const kind = text(body.kind, 30, true)

  const employeeId = text(body.employeeId, 100, true)!
  let date: string
  let time: string
  let durationMinutes: number

  try {
    date = normalizeCalendarDate(body.date)
    time = normalizeCalendarTime(body.time)
    durationMinutes = normalizeDuration(body.durationMinutes)
  } catch (error) {
    return json(400, {
      error: error instanceof Error ? error.message : 'Invalid calendar time.',
    })
  }

  if (kind === 'block') {
    try {
      const calendar = await getClientCalendar({
        supabase: supabaseAdmin,
        clientId: user.id,
        date,
      })
      const start = localDateTimeToUtc(date, time, calendar.timeZone)
      const end = new Date(start.getTime() + durationMinutes * 60_000)
      const title = text(body.title, 160, true)!
      const details = text(body.details, 2000)
      const blockType = text(body.blockType, 30) || 'unavailable'

      if (start <= new Date()) {
        return json(400, { error: 'Blocked time must be in the future.' })
      }

      const { data: blockId, error: rpcError } = await supabaseAdmin.rpc(
        'recepta_create_employee_block',
        {
          p_client_id: user.id,
          p_employee_id: employeeId,
          p_start: start.toISOString(),
          p_end: end.toISOString(),
          p_title: title,
          p_details: details,
          p_block_type: blockType,
        }
      )

      if (rpcError || !blockId) {
        return json(409, {
          error: rpcError?.message || 'Could not block this time.',
        })
      }

      const { data: block, error } = await supabaseAdmin
        .from('employee_calendar_blocks')
        .select(
          'id, employee_id, title, details, block_type, starts_at, ends_at'
        )
        .eq('id', blockId)
        .single()

      if (error || !block) {
        return json(400, { error: 'The time was blocked but could not be reloaded.' })
      }

      return json(201, { block })
    } catch (error) {
      return json(400, {
        error:
          error instanceof Error ? error.message : 'Could not block this time.',
      })
    }
  }

  if (kind !== 'appointment') {
    return json(400, { error: 'Choose appointment, blocked time, or saved client.' })
  }

  try {
    const customerName = text(body.customerName, 160, true)!
    const customerEmail = text(body.customerEmail, 320)
    const customerPhone = text(body.customerPhone, 60)
    const companyName = text(body.companyName, 200)
    const service = text(body.service, 300)
    const notes = text(body.notes, 2000)
    const internalNotes = text(body.internalNotes, 2000)
    const exactSlot = await assertExactSlotAvailable({
      supabase: supabaseAdmin,
      clientId: user.id,
      employeeId,
      date,
      time,
      durationMinutes,
    })
    const { data: appointmentId, error: rpcError } =
      await supabaseAdmin.rpc('recepta_book_employee_appointment', {
        p_client_id: user.id,
        p_employee_id: employeeId,
        p_start: exactSlot.start,
        p_duration_minutes: durationMinutes,
        p_customer_name: customerName,
        p_customer_email: customerEmail,
        p_customer_phone: customerPhone,
        p_company_name: companyName,
        p_service: service,
        p_notes: notes,
        p_internal_notes: internalNotes,
        p_source: 'dashboard',
        p_retell_call_id: null,
      })

    if (rpcError || !appointmentId) {
      return json(409, {
        error: rpcError?.message || 'That time is no longer available.',
      })
    }

    const { data: appointment, error } = await supabaseAdmin
      .from('appointments')
      .select(
        'id, employee_id, customer_name, customer_phone, customer_email, company_name, service, notes, internal_notes, appointment_time, appointment_end_time, duration_minutes, status, source'
      )
      .eq('id', appointmentId)
      .single()

    if (error || !appointment) {
      return json(400, {
        error: 'The appointment was booked but could not be reloaded.',
      })
    }

    const emailResult = await sendAppointmentConfirmations({
      businessName:
        exactSlot.business?.company_name || 'the business',
      businessOwnerEmail: exactSlot.business?.contact_email,
      customerName,
      customerEmail,
      customerPhone,
      customerCompany: companyName,
      employeeName: exactSlot.employee.name,
      employeeEmail: exactSlot.employee.email,
      service,
      notes,
      start: exactSlot.start,
      end: exactSlot.end,
      timeZone: exactSlot.timeZone,
    })

    return json(201, {
      appointment,
      confirmationEmailSent: emailResult.sent,
      confirmationWarning: emailResult.warning,
    })
  } catch (error) {
    return json(400, {
      error:
        error instanceof Error ? error.message : 'Could not create the appointment.',
    })
  }
}
