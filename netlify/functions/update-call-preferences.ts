import { createClient } from '@supabase/supabase-js'
import {
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

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const retellApiKey = process.env.RETELL_API_KEY

  if (!supabaseUrl || !supabaseSecretKey || !retellApiKey) {
    return json(500, {
      error:
        'Schedule sync is unavailable because the server configuration is missing.',
    })
  }

  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized.' })
  }

  let body: {
    scheduleMode?: '24/7' | 'custom'
    operatingHours?: unknown
    timeZone?: unknown
    useSchedule?: boolean
  }

  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid request body.' })
  }

  const scheduleMode =
    body.scheduleMode ??
    (typeof body.useSchedule === 'boolean'
      ? body.useSchedule
        ? 'custom'
        : '24/7'
      : null)

  if (scheduleMode !== '24/7' && scheduleMode !== 'custom') {
    return json(400, {
      error: 'Choose either 24/7 or Custom hours.',
    })
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

  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents')
    .select('business_hours, retell_agent_id')
    .eq('client_id', user.id)
    .maybeSingle()

  if (agentError || !agent) {
    return json(404, {
      error: 'No receptionist is assigned to this customer.',
    })
  }

  const retellAgentId = agent.retell_agent_id?.trim()

  if (!retellAgentId) {
    return json(409, {
      error:
        'Your Retell Agent ID must be assigned before availability can be synchronized.',
    })
  }

  let schedule: RetellSchedule

  try {
    const storedTimeZone = getBusinessTimeZone(
      agent.business_hours
    )

    schedule = {
      mode: scheduleMode,
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

  const { data: employees, error: employeesError } = await supabaseAdmin
    .from('employees')
    .select('id, name, role, is_active')
    .eq('client_id', user.id)
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

  const { error: updateError } = await supabaseAdmin
    .from('agents')
    .update({ business_hours: businessHours })
    .eq('client_id', user.id)

  if (updateError) {
    return json(500, {
      error: 'Could not save the availability setting.',
    })
  }

  try {
    const retellSync = await syncRetellSchedule({
      apiKey: retellApiKey,
      agentId: retellAgentId,
      schedule,
      employeeSchedule,
      employeeScheduleTimeZone: schedule.timeZone,
    })

    return json(200, {
      scheduleMode,
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
      .eq('client_id', user.id)

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
