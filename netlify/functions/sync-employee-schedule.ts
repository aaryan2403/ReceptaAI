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
  const employeeIds = employees.map((employee) => employee.id)
  let schedules: Array<{
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
    console.error('Retell employee schedule sync failed:', error)

    return json(502, {
      error:
        error instanceof Error
          ? `Retell employee schedule sync failed: ${error.message}`
          : 'Retell employee schedule sync failed.',
    })
  }
}
