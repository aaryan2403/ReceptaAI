import { createClient } from '@supabase/supabase-js'
import {
  buildEmployeeScheduleContext,
  getBusinessTimeZone,
  getStoredBusinessSchedule,
} from '../lib/employeeSchedule'
import { syncRetellSchedule } from '../lib/retell'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

type ScheduleRow = {
  employee_id: string
  day_of_week: number
  is_working: boolean
  start_time: string | null
  end_time: string | null
}

type ScheduleSaveBody = {
  employeeId?: unknown
  schedules?: unknown
}

const isTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)

const normalizeScheduleSave = (
  body: ScheduleSaveBody
): { employeeId: string; schedules: ScheduleRow[] } | null => {
  if (body.employeeId === undefined && body.schedules === undefined) {
    return null
  }

  if (
    typeof body.employeeId !== 'string' ||
    !body.employeeId.trim() ||
    !Array.isArray(body.schedules) ||
    body.schedules.length !== 7
  ) {
    throw new Error('A complete seven-day employee schedule is required.')
  }

  const days = new Set<number>()
  const schedules = body.schedules.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('The employee schedule contains an invalid day.')
    }

    const candidate = item as Record<string, unknown>
    const dayOfWeek = candidate.dayOfWeek
    const isWorking = candidate.isWorking
    const startTime = candidate.startTime
    const endTime = candidate.endTime

    if (
      !Number.isInteger(dayOfWeek) ||
      (dayOfWeek as number) < 0 ||
      (dayOfWeek as number) > 6 ||
      days.has(dayOfWeek as number) ||
      typeof isWorking !== 'boolean'
    ) {
      throw new Error('The employee schedule contains an invalid day.')
    }

    if (
      isWorking &&
      (!isTime(startTime) ||
        !isTime(endTime) ||
        startTime === endTime)
    ) {
      throw new Error(
        'Every working day needs valid start and end times.'
      )
    }

    days.add(dayOfWeek as number)

    return {
      employee_id: body.employeeId.trim(),
      day_of_week: dayOfWeek as number,
      is_working: isWorking,
      start_time: isWorking ? (startTime as string) : null,
      end_time: isWorking ? (endTime as string) : null,
    }
  })

  return { employeeId: body.employeeId.trim(), schedules }
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
      error: 'Employee schedule sync is not configured on the server.',
    })
  }

  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized.' })
  }

  let scheduleSave: ReturnType<typeof normalizeScheduleSave>

  try {
    const rawBody = await request.text()
    scheduleSave = normalizeScheduleSave(
      rawBody ? (JSON.parse(rawBody) as ScheduleSaveBody) : {}
    )
  } catch (error) {
    return json(400, {
      error:
        error instanceof Error
          ? error.message
          : 'Invalid employee schedule.',
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

  const [agentResult, subscriptionResult, employeesResult] =
    await Promise.all([
      supabaseAdmin
        .from('agents')
        .select('retell_agent_id, business_hours')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('subscriptions')
        .select('status')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('employees')
        .select('id, name, role, is_active')
        .eq('client_id', user.id)
        .order('created_at', { ascending: true }),
    ])

  if (subscriptionResult.data?.status !== 'active') {
    return json(403, {
      error: 'An active Recepta subscription is required.',
    })
  }

  if (agentResult.error || !agentResult.data) {
    return json(404, {
      error: 'No receptionist is assigned to this customer.',
    })
  }

  if (employeesResult.error) {
    return json(500, { error: 'Could not load employees.' })
  }

  const retellAgentId = agentResult.data.retell_agent_id?.trim()

  if (!retellAgentId) {
    return json(409, {
      error:
        'Your Retell Agent ID must be assigned before employee schedules can synchronize.',
    })
  }

  const employees = employeesResult.data ?? []

  if (
    scheduleSave &&
    !employees.some(
      (employee) => employee.id === scheduleSave.employeeId
    )
  ) {
    return json(404, { error: 'Employee not found.' })
  }

  let previousSchedule: ScheduleRow[] | null = null

  if (scheduleSave) {
    const previousResult = await supabaseAdmin
      .from('employee_schedules')
      .select(
        'employee_id, day_of_week, is_working, start_time, end_time'
      )
      .eq('employee_id', scheduleSave.employeeId)

    if (previousResult.error) {
      return json(500, {
        error: 'Could not load the existing employee schedule.',
      })
    }

    previousSchedule = previousResult.data ?? []

    const saveResult = await supabaseAdmin
      .from('employee_schedules')
      .upsert(scheduleSave.schedules, {
        onConflict: 'employee_id,day_of_week',
      })

    if (saveResult.error) {
      return json(500, {
        error: 'Could not save the employee schedule.',
      })
    }
  }

  const rollbackSchedule = async () => {
    if (!scheduleSave || previousSchedule === null) return

    const deleteResult = await supabaseAdmin
      .from('employee_schedules')
      .delete()
      .eq('employee_id', scheduleSave.employeeId)

    if (deleteResult.error) {
      console.error('Employee schedule rollback delete failed:', deleteResult.error)
      return
    }

    if (previousSchedule.length > 0) {
      const restoreResult = await supabaseAdmin
        .from('employee_schedules')
        .insert(previousSchedule)

      if (restoreResult.error) {
        console.error(
          'Employee schedule rollback restore failed:',
          restoreResult.error
        )
      }
    }
  }

  const employeeIds = employees.map((employee) => employee.id)
  let schedules: ScheduleRow[] = []

  if (employeeIds.length > 0) {
    const schedulesResult = await supabaseAdmin
      .from('employee_schedules')
      .select(
        'employee_id, day_of_week, is_working, start_time, end_time'
      )
      .in('employee_id', employeeIds)
      .order('day_of_week', { ascending: true })

    if (schedulesResult.error) {
      await rollbackSchedule()
      return json(500, { error: 'Could not load employee schedules.' })
    }

    schedules = schedulesResult.data ?? []
  }

  const timeZone = getBusinessTimeZone(
    agentResult.data.business_hours
  )
  const employeeSchedule = buildEmployeeScheduleContext({
    employees,
    schedules,
    timeZone,
  })
  const storeSchedule = getStoredBusinessSchedule(
    agentResult.data.business_hours
  )

  try {
    const result = await syncRetellSchedule({
      apiKey: retellApiKey,
      agentId: retellAgentId,
      schedule: storeSchedule,
      employeeSchedule,
      employeeScheduleTimeZone: timeZone,
    })

    return json(200, {
      success: true,
      retellSynced: result.agentUpdated,
      activeEmployees: employees.filter(
        (employee) => employee.is_active
      ).length,
      timeZone,
    })
  } catch (error) {
    await rollbackSchedule()
    console.error('Retell employee schedule sync failed:', error)

    return json(502, {
      error:
        error instanceof Error
          ? `Nothing was changed because Retell could not synchronize: ${error.message}`
          : 'Nothing was changed because Retell could not synchronize.',
    })
  }
}
