import { createClient } from '@supabase/supabase-js'
import {
  buildEmployeeScheduleContext,
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
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !retellApiKey ||
    !adminEmail
  ) {
    return json(500, {
      error: 'Retell synchronization is not configured on the server.',
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

  if (
    userError ||
    !user ||
    user.email?.trim().toLowerCase() !== adminEmail
  ) {
    return json(403, { error: 'Admin access required.' })
  }

  const [clientsResult, agentsResult] = await Promise.all([
    supabaseAdmin
      .from('clients')
      .select('id, company_name, contact_email'),
    supabaseAdmin
      .from('agents')
      .select('client_id, retell_agent_id, business_hours')
      .not('retell_agent_id', 'is', null),
  ])

  const lookupError = clientsResult.error || agentsResult.error

  if (lookupError) {
    return json(500, { error: lookupError.message })
  }

  const clients = clientsResult.data ?? []
  const agents = (agentsResult.data ?? []).filter(
    (agent) => agent.retell_agent_id?.trim()
  )
  const results: Array<{
    clientId: string
    companyName: string | null
    email: string | null
    synced: boolean
    error?: string
  }> = []

  for (const agent of agents) {
    const client = clients.find((row) => row.id === agent.client_id)

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

        if (schedulesResult.error) throw schedulesResult.error
        schedules = schedulesResult.data ?? []
      }

      const storeSchedule = getStoredBusinessSchedule(
        agent.business_hours
      )
      const employeeSchedule = buildEmployeeScheduleContext({
        employees: employeeRows,
        schedules,
        timeZone: storeSchedule.timeZone,
      })

      await syncRetellSchedule({
        apiKey: retellApiKey,
        agentId: agent.retell_agent_id!.trim(),
        schedule: storeSchedule,
        employeeSchedule,
        employeeScheduleTimeZone: storeSchedule.timeZone,
      })

      results.push({
        clientId: agent.client_id,
        companyName: client?.company_name ?? null,
        email: client?.contact_email ?? null,
        synced: true,
      })
    } catch (error) {
      results.push({
        clientId: agent.client_id,
        companyName: client?.company_name ?? null,
        email: client?.contact_email ?? null,
        synced: false,
        error:
          error instanceof Error
            ? error.message
            : 'Unknown Retell synchronization error.',
      })
    }
  }

  const synced = results.filter((result) => result.synced).length
  const failed = results.length - synced
  const testAgent = results.find(
    (result) =>
      result.email?.trim().toLowerCase() ===
      'receptahelp02@gmail.com'
  )

  return json(200, {
    success: failed === 0,
    total: results.length,
    synced,
    failed,
    testAgent: testAgent ?? null,
    results,
  })
}
