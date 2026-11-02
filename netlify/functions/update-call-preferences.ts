import { getAnsweringMode } from '../lib/businessHours'
import { requestAuth } from '../lib/requestAuth'
import {
  normalizeEmailNotificationsEnabled,
  normalizeAppointmentFields,
  normalizeSmsNotificationsEnabled,
  syncRetellSchedule,
  type RetellOperatingDay,
  type RetellSchedule,
} from '../lib/retell'
import {
  buildEmployeeScheduleContext,
  getBusinessTimeZone,
} from '../lib/employeeSchedule'

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

const DEFAULT_OPERATING_HOURS: RetellOperatingDay[] = DAYS.map(
  (day) => ({
    day,
    open: !['Saturday', 'Sunday'].includes(day),
    start: '09:00',
    end: '17:00',
  })
)

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const isTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)

const normalizeTimeZone = (value: unknown) => {
  const timeZone =
    typeof value === 'string' && value.trim()
      ? value.trim()
      : 'America/Toronto'

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return timeZone
  } catch {
    throw new Error('Select a valid business timezone.')
  }
}

const normalizeHours = (value: unknown): RetellOperatingDay[] => {
  if (!Array.isArray(value) || value.length !== DAYS.length) {
    throw new Error('Custom hours are required for all seven days.')
  }

  return DAYS.map((day) => {
    const item = value.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        'day' in candidate &&
        candidate.day === day
    ) as Partial<RetellOperatingDay> | undefined

    if (
      !item ||
      typeof item.open !== 'boolean' ||
      !isTime(item.start) ||
      !isTime(item.end)
    ) {
      throw new Error(`Enter valid hours for ${day}.`)
    }

    if (item.open && item.start === item.end) {
      throw new Error(
        `${day}'s opening and closing times cannot be the same.`
      )
    }

    return {
      day,
      open: item.open,
      start: item.start,
      end: item.end,
    }
  })
}

const getExistingHours = (businessHours?: string | null) => {
  if (!businessHours) return DEFAULT_OPERATING_HOURS

  try {
    const parsed = JSON.parse(businessHours) as
      | RetellOperatingDay[]
      | { hours?: RetellOperatingDay[] }

    return normalizeHours(
      Array.isArray(parsed) ? parsed : parsed.hours
    )
  } catch {
    return DEFAULT_OPERATING_HOURS
  }
}

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }

  let auth
  try { auth = await requestAuth(request, true) }
  catch { return json(503, { error: 'Store hours administration is not configured.' }) }
  if (auth.response) return auth.response
  const { db: supabaseAdmin } = auth

  let body: {
    clientId?: unknown
    scheduleMode?: '24/7' | 'custom'
    operatingHours?: unknown
    timeZone?: unknown
    useSchedule?: boolean
    answeringMode?: unknown
  }
  try { body = await request.json() }
  catch { return json(400, { error: 'Invalid request body.' }) }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    return json(400, { error: 'Choose the client whose store hours you want to update.' })
  }
  const scheduleMode = body.scheduleMode ??
    (typeof body.useSchedule === 'boolean' ? body.useSchedule ? 'custom' : '24/7' : null)
  if (scheduleMode !== '24/7' && scheduleMode !== 'custom') {
    return json(400, { error: 'Choose either 24/7 or Custom hours.' })
  }
  const client = await supabaseAdmin.from('clients').select('deletion_pending').eq('id', clientId).maybeSingle()
  if (client.error) return json(500, { error: 'Could not verify this client.' })
  if (!client.data || client.data.deletion_pending) return json(403, { error: 'This client is unavailable or awaiting deletion.' })

  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents').select('business_hours, retell_agent_id').eq('client_id', clientId).maybeSingle()
  if (agentError || !agent) return json(404, { error: 'Save the client setup before configuring store hours.' })
  const retellAgentId = agent.retell_agent_id?.trim()
  const retellApiKey = process.env.RETELL_API_KEY
  if (retellAgentId && !retellApiKey) return json(503, { error: 'AI synchronization is not configured.' })

  const answeringMode = body.answeringMode ?? getAnsweringMode(agent.business_hours)
  if (answeringMode !== '24/7' && answeringMode !== 'business_hours') return json(400, { error: 'Choose valid AI answering hours.' })

  let schedule: RetellSchedule

  try {
    const storedTimeZone = getBusinessTimeZone(
      agent.business_hours
    )

    schedule = {
      mode: scheduleMode,
      answeringMode,
      timeZone: normalizeTimeZone(
        body.timeZone ?? storedTimeZone
      ),
      hours:
        scheduleMode === 'custom'
          ? body.operatingHours
            ? normalizeHours(body.operatingHours)
            : getExistingHours(agent.business_hours)
          : DEFAULT_OPERATING_HOURS,
    }
  } catch (error) {
    return json(400, {
      error:
        error instanceof Error
          ? error.message
          : 'The custom hours are invalid.',
    })
  }

  const businessHours = JSON.stringify(schedule)

  // Admins can prepare store hours before a provider agent has been assigned.
  if (!retellAgentId) {
    const saved = await supabaseAdmin.from('agents').update({ business_hours: businessHours }).eq('client_id', clientId)
    if (saved.error) return json(500, { error: 'Could not save store hours.' })
    return json(200, { scheduleMode, answeringMode, scheduleEnabled: scheduleMode === 'custom', businessHours,
      timeZone: schedule.timeZone, retellSynced: false, employeeScheduleSynced: false })
  }

  const { data: employees, error: employeesError } = await supabaseAdmin
    .from('employees')
    .select('id, name, role, is_active')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })

  if (employeesError) {
    return json(500, {
      error: 'Could not load employee availability for Retell.',
    })
  }

  const employeeRows = employees ?? []
  const employeeIds = employeeRows.map((employee) => employee.id)
  let employeeSchedules: Array<{
    employee_id: string
    day_of_week: number
    is_working: boolean
    start_time: string | null
    end_time: string | null
  }> = []

  if (employeeIds.length > 0) {
    const schedulesResult = await supabaseAdmin
      .from('employee_schedules')
      .select(
        'employee_id, day_of_week, is_working, start_time, end_time'
      )
      .in('employee_id', employeeIds)
      .order('day_of_week', { ascending: true })

    if (schedulesResult.error) {
      return json(500, {
        error: 'Could not load employee schedules for Retell.',
      })
    }

    employeeSchedules = schedulesResult.data ?? []
  }

  const employeeSchedule = buildEmployeeScheduleContext({
    employees: employeeRows,
    schedules: employeeSchedules,
    timeZone: schedule.timeZone,
  })
  const { data: targetUser, error: targetUserError } = await supabaseAdmin.auth.admin.getUserById(clientId)
  if (targetUserError || !targetUser.user) return json(500, { error: 'Could not load this client’s agent preferences.' })
  const appointmentFields = normalizeAppointmentFields(
    targetUser.user.user_metadata?.appointment_custom_fields
  )
  const emailNotificationsEnabled = normalizeEmailNotificationsEnabled(
    targetUser.user.user_metadata?.appointment_email_notifications_enabled
  )
  const smsNotificationsEnabled = normalizeSmsNotificationsEnabled(
    targetUser.user.user_metadata?.appointment_sms_notifications_enabled
  )

  const { error: updateError } = await supabaseAdmin
    .from('agents')
    .update({ business_hours: businessHours })
    .eq('client_id', clientId)

  if (updateError) {
    return json(500, {
      error: 'Could not save the availability setting.',
    })
  }

  try {
    const retellSync = await syncRetellSchedule({
      apiKey: retellApiKey!,
      agentId: retellAgentId,
      schedule,
      employeeSchedule,
      employeeScheduleTimeZone: schedule.timeZone,
      appointmentFields,
      emailNotificationsEnabled,
      smsNotificationsEnabled,
    })

    return json(200, {
      scheduleMode,
      answeringMode,
      scheduleEnabled: scheduleMode === 'custom',
      businessHours,
      timeZone: schedule.timeZone,
      retellSynced: retellSync.agentUpdated,
      employeeScheduleSynced: retellSync.agentUpdated,
    })
  } catch (error) {
    const { error: rollbackError } = await supabaseAdmin
      .from('agents')
      .update({ business_hours: agent.business_hours })
      .eq('client_id', clientId)

    if (rollbackError) {
      console.error('Schedule rollback failed:', rollbackError)
    }

    console.error('Retell schedule sync failed:', error)

    return json(502, {
      error:
        error instanceof Error
          ? `Retell schedule sync failed: ${error.message}`
          : 'Retell schedule sync failed.',
    })
  }
}
