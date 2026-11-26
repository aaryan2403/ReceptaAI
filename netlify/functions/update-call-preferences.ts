import { normalizeHours, normalizeTimeZone } from '../lib/storeSchedule'
import { serviceDeployment } from '../lib/serviceAccess'
import { businessForwardingNumber, humanForwardingNumber, reconcileRetellForwarding } from '../lib/retellForwarding'
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
  if (!['GET', 'POST'].includes(request.method)) {
    return json(405, { error: 'Method not allowed.' })
  }

  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return json(503, { error: 'This preview must use Recepta Staging.' })

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
    humanNumber?: unknown
    forwardingSource?: unknown
  }
  try { body = request.method === 'POST' ? await request.json() : { clientId: new URL(request.url).searchParams.get('clientId') } }
  catch { return json(400, { error: 'Invalid request body.' }) }

  const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    return json(400, { error: 'Choose the client whose store hours you want to update.' })
  }
  const client = await supabaseAdmin.from('clients').select('deletion_pending').eq('id', clientId).maybeSingle()
  if (client.error) return json(500, { error: 'Could not verify this client.' })
  if (!client.data || client.data.deletion_pending) return json(403, { error: 'This client is unavailable or awaiting deletion.' })

  if (request.method === 'GET') {
    const [human, source] = await Promise.all([
      supabaseAdmin.from('phone_transfer_destinations').select('phone_number').eq('client_id', clientId)
        .eq('is_primary', true).eq('enabled', true).maybeSingle(),
      supabaseAdmin.from('phone_forwarding_sources').select('phone_number').eq('client_id', clientId)
        .order('phone_number').limit(1).maybeSingle(),
    ])
    if (human.error || source.error) return json(503, { error: 'Could not load the human forwarding number.' })
    return json(200, { humanNumber: human.data?.phone_number ?? '', forwardingSource: source.data?.phone_number ?? '' })
  }

  const editHuman = body.humanNumber !== undefined
  const human = humanForwardingNumber(body.humanNumber)
  if (editHuman && body.humanNumber !== '' && !human) {
    return json(400, { error: 'Enter a direct US or Canadian human number without an extension.' })
  }
  const business = businessForwardingNumber(body.forwardingSource)
  if (body.forwardingSource !== undefined && body.forwardingSource !== '' && !business) {
    return json(400, { error: 'Enter the original business number in international format, including the country code.' })
  }

  const scheduleMode = body.scheduleMode ??
    (typeof body.useSchedule === 'boolean' ? body.useSchedule ? 'custom' : '24/7' : null)
  if (scheduleMode !== '24/7' && scheduleMode !== 'custom') {
    return json(400, { error: 'Choose either 24/7 or Custom hours.' })
  }

  const { data: agent, error: agentError } = await supabaseAdmin
    .from('agents').select('business_hours, retell_agent_id').eq('client_id', clientId).maybeSingle()
  if (agentError || !agent) return json(404, { error: 'Save the client setup before configuring store hours.' })
  const retellAgentId = agent.retell_agent_id?.trim()
  const retellApiKey = deployment.key
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

  const saveSchedule = () => supabaseAdmin.rpc('recepta_save_retell_forwarding_schedule', {
    p_client: clientId, p_previous: agent.business_hours, p_schedule: businessHours,
    p_edit_human: editHuman, p_human: human, p_business: business,
  })
  const saveFailure = ({ data, error }: Awaited<ReturnType<typeof saveSchedule>>) => {
    if (error?.code === '22023') return json(400, { error: error.message })
    if (error) return json(500, { error: 'Could not save the availability setting.' })
    if (data !== true) return json(409, { error: 'Store hours changed. Refresh before saving again.' })
    return null
  }
  const savedSettings = { scheduleMode, answeringMode, scheduleEnabled: scheduleMode === 'custom', businessHours,
    timeZone: schedule.timeZone }

  // Admins can prepare store hours before a provider agent has been assigned.
  if (!retellAgentId) {
    return saveFailure(await saveSchedule()) ??
      json(200, { ...savedSettings, retellSynced: false, employeeScheduleSynced: false })
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

  let routingWarning: string | null = null
  let retellSynced = false
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

    retellSynced = retellSync.agentUpdated
  } catch (error) {
    console.error('Retell schedule sync failed:', error instanceof Error ? error.message : 'unknown error')
    return json(502, { error: 'Retell schedule sync failed. Store hours could not be saved.' })
  }

  const failed = saveFailure(await saveSchedule())
  if (failed) return failed

  try {
    const routing = await reconcileRetellForwarding(supabaseAdmin, deployment, clientId, 10000)
    if (routing.unsafe) routingWarning = 'Forwarding is disabled for an unsafe destination or unsupported phone binding.'
    else if (routing.pending) routingWarning = 'Retell has yet to confirm forwarding. The scheduled sync will retry.'
    else if (!routing.checked && human && scheduleMode === 'custom' && answeringMode === 'business_hours') {
      routingWarning = 'This client has no Retell number connected to this deployment.'
    }
  } catch {
    routingWarning = 'Retell forwarding could not be confirmed. The scheduled sync will retry.'
  }
  return json(200, { ...savedSettings, retellSynced, employeeScheduleSynced: retellSynced, routingWarning })
}
