import { createClient } from '@supabase/supabase-js'
import {
  buildEmployeeScheduleContext,
  getStoredBusinessSchedule,
} from '../lib/employeeSchedule'
import {
  normalizeAppointmentFields,
  syncRetellSchedule,
} from '../lib/retell'

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
  const authHeader = request.headers.get('authorization')

  if (!supabaseUrl || !supabaseSecretKey || !retellApiKey) {
    return json(500, {
      error: 'Dashboard synchronization is not configured on the server.',
    })
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
  } = await supabaseAdmin.auth.getUser(authHeader.slice('Bearer '.length))

  if (userError || !user) {
    return json(401, { error: 'Unauthorized.' })
  }

  const [{ data: subscription, error: subscriptionError }, { data: agent, error: agentError }] =
    await Promise.all([
      supabaseAdmin
        .from('subscriptions')
        .select('status')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabaseAdmin
        .from('agents')
        .select('retell_agent_id, business_hours')
        .eq('client_id', user.id)
        .maybeSingle(),
    ])

  if (subscriptionError) {
    return json(500, { error: 'Could not verify synchronization access.' })
  }

  if (subscription?.status !== 'active') {
    return json(403, { error: 'An active Recepta subscription is required.' })
  }

  if (agentError || !agent) {
    return json(404, { error: 'No receptionist is assigned to this customer.' })
  }

  const retellAgentId = agent.retell_agent_id?.trim()

  if (!retellAgentId) {
    return json(409, {
      error: 'Your Retell Agent ID must be assigned before dashboard changes can synchronize.',
    })
  }

  const { data: employees, error: employeesError } = await supabaseAdmin
    .from('employees')
    .select('id, name, role, is_active')
    .eq('client_id', user.id)
    .order('created_at', { ascending: true })

  if (employeesError) {
    return json(500, { error: 'Could not load employees for synchronization.' })
  }

  const employeeRows = employees ?? []
  const employeeIds = employeeRows.map((employee) => employee.id)
  let schedules: Array<{
    employee_id: string
    day_of_week: number
    is_working: boolean
    start_time: string | null
    end_time: string | null
  }> = []

  if (employeeIds.length > 0) {
    const { data, error: schedulesError } = await supabaseAdmin
      .from('employee_schedules')
      .select('employee_id, day_of_week, is_working, start_time, end_time')
      .in('employee_id', employeeIds)
      .order('day_of_week', { ascending: true })

    if (schedulesError) {
      return json(500, {
        error: 'Could not load employee schedules for synchronization.',
      })
    }

    schedules = data ?? []
  }

  const schedule = getStoredBusinessSchedule(agent.business_hours)
  const employeeSchedule = buildEmployeeScheduleContext({
    employees: employeeRows,
    schedules,
    timeZone: schedule.timeZone,
  })
  const appointmentFields = normalizeAppointmentFields(
    user.user_metadata?.appointment_custom_fields
  )

  try {
    const result = await syncRetellSchedule({
      apiKey: retellApiKey,
      agentId: retellAgentId,
      schedule,
      employeeSchedule,
      employeeScheduleTimeZone: schedule.timeZone,
      appointmentFields,
    })

    return json(200, {
      success: true,
      retellSynced: result.agentUpdated,
      activeEmployees: employeeRows.filter((employee) => employee.is_active)
        .length,
      appointmentFields,
      timeZone: schedule.timeZone,
    })
  } catch (error) {
    console.error('Dashboard context sync failed:', error)
    return json(502, {
      error:
        error instanceof Error
          ? `Retell synchronization failed: ${error.message}`
          : 'Retell synchronization failed.',
      retellSynced: false,
    })
  }
}
