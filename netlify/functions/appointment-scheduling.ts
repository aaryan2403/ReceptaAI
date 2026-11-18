import { schedulingReason } from '../../src/lib/appointmentScheduling'
import { appointmentAccessIssue, objectValue, schedulingSettingsForDashboard, uuid, validDate, validStart, validateSchedulingSettings } from '../lib/appointmentScheduling'
import { appointmentAgentReadiness, repairAppointmentAgent } from '../lib/appointmentAgentSetup'
import { getStoredBusinessSchedule } from '../lib/employeeSchedule'
import { bookingCalendarFromStoreHours } from '../lib/bookingStoreHours'
import { retellScheduleSyncMessage } from '../lib/retell'
import { json, requestAuth } from '../lib/requestAuth'

const PAGE_SIZE = 25
const statusFilters = ['upcoming', 'pending', 'booked', 'cancelled', 'completed']

export default async (request: Request) => {
  if (!['GET','PUT','PATCH','POST'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  const url = new URL(request.url)
  const target = url.searchParams.get('clientId')
  if (target !== null && !uuid(target)) return json(400, { error: 'A valid client is required.' })

  try {
    const auth = await requestAuth(request, target !== null)
    if (auth.response) return auth.response
    const { db, user } = auth
    const clientId = target ?? user.id
    const [client, accessIssue] = await Promise.all([
      db.from('clients').select('id, deletion_pending').eq('id', clientId).maybeSingle(),
      appointmentAccessIssue(db, clientId),
    ])
    if (client.error) throw client.error
    if (!client.data) return json(404, { error: 'Client not found.' })
    if (client.data.deletion_pending) return json(409, { error: 'This account is awaiting deletion.' })
    const activePro = accessIssue === null
    if (request.method === 'GET' && url.searchParams.get('readiness') === '1') {
      if (target === null) return json(403, { error: 'Admin access required.' })
      return json(200, await appointmentAgentReadiness(db, clientId, accessIssue))
    }
    if (!activePro && (target === null || ['POST', 'PATCH'].includes(request.method))) {
      return json(403, { error: accessIssue })
    }

    if (request.method === 'GET') {
      const date = url.searchParams.get('date')
      if (date !== null) {
        if (!activePro) return json(403, { error: accessIssue })
        const appointmentId = url.searchParams.get('appointmentId')
        if (!validDate(date) || (appointmentId !== null && !uuid(appointmentId))) {
          return json(400, { error: 'Select a valid booking date and appointment.' })
        }
        const availability = await db.rpc('recepta_scheduling_availability', {
          p_client: clientId, p_date: date, p_automatic: false, p_appointment_id: appointmentId,
        })
        if (availability.error) throw availability.error
        return json(200, availability.data)
      }

      const status = url.searchParams.get('status') ?? 'upcoming'
      const page = Number(url.searchParams.get('page') ?? '0')
      if (!statusFilters.includes(status) || !Number.isInteger(page) || page < 0 || page > 100000) {
        return json(400, { error: 'Invalid appointment list filter.' })
      }
      let records = db.from('appointments').select(
        'id, status, customer_name, customer_phone, customer_email, company_name, service, notes, requested_date, requested_time, requested_timezone, appointment_time, appointment_end_time, duration_minutes, booking_time_zone, booking_version, retell_call_id, created_at',
        { count: 'exact' },
      ).eq('client_id', clientId).eq('status', status === 'upcoming' ? 'booked' : status)
      if (status === 'upcoming') records = records.gte('appointment_time', new Date().toISOString())
      const [appointments, rules, agent] = await Promise.all([
        records.order(status === 'upcoming' ? 'appointment_time' : 'created_at', { ascending: status === 'upcoming' })
          .order('id').range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1),
        db.from('booking_settings').select('*').eq('client_id', clientId).maybeSingle(),
        db.from('agents').select('retell_agent_id, business_hours').eq('client_id', clientId).maybeSingle(),
      ])
      if (appointments.error || rules.error || agent.error) throw appointments.error ?? rules.error ?? agent.error
      const ids = appointments.data.filter(row => row.status === 'booked').map(row => row.id)
      const conflicts = ids.length
        ? await db.rpc('recepta_appointment_conflicts', { p_client: clientId, p_ids: ids })
        : { data: [], error: null }
      if (conflicts.error) throw conflicts.error
      const settings = schedulingSettingsForDashboard(rules.data, getStoredBusinessSchedule(agent.data?.business_hours).timeZone)
      const needsSync = rules.data?.synced_at == null || rules.data.sync_agent_id !== agent.data?.retell_agent_id
      return json(200, {
        activePro, accessIssue, settings, needsSync, appointments: appointments.data, conflicts: conflicts.data,
        more: (appointments.count ?? 0) > (page + 1) * PAGE_SIZE,
      })
    }

    if (request.method === 'POST') {
      const rules = await db.from('booking_settings').select('updated_at').eq('client_id', clientId).maybeSingle()
      if (rules.error) throw rules.error
      try {
        const result = await repairAppointmentAgent(db, clientId)
        if (rules.data) {
          const saved = await db.from('booking_settings').update({
            sync_agent_id: result.agentId, synced_at: new Date().toISOString(), sync_error: null,
          }).eq('client_id', clientId).eq('updated_at', rules.data.updated_at).select('synced_at').maybeSingle()
          if (saved.error) throw saved.error
          if (!saved.data) return json(409, { error: 'Appointment settings changed during synchronization. Reload the current settings.' })
        }
        return json(200, { synced: true, version: result.version })
      } catch (error) {
        const message = retellScheduleSyncMessage(error)
        if (rules.data) {
          const failed = await db.from('booking_settings').update({ synced_at: null, sync_error: message })
            .eq('client_id', clientId).eq('updated_at', rules.data.updated_at)
          if (failed.error) console.error('Could not record appointment sync error', failed.error.code)
        }
        return json(502, { error: message })
      }
    }

    let body: Record<string, unknown>
    try { body = objectValue(await request.json()) } catch { return json(400, { error: 'Invalid appointment data.' }) }

    if (request.method === 'PATCH') {
      const { action, id, version, start } = body
      if ((action !== 'cancel' && action !== 'confirm' && action !== 'reschedule') || !uuid(id) ||
        typeof version !== 'number' || !Number.isInteger(version) || version < 1 ||
        (action !== 'cancel' && !validStart(start))) return json(400, { error: 'Invalid appointment update.' })

      const changed = await db.rpc('recepta_change_appointment', {
        p_client: clientId, p_action: action, p_start: action === 'cancel' ? null : start,
        p_id: id, p_version: version, p_actor: user.id,
      })
      if (changed.error) throw changed.error
      if (!changed.data.success) {
        return json(changed.data.reason === 'appointment_not_found' ? 404 : changed.data.reason === 'pro_required' ? 403 : 409,
          { error: schedulingReason(changed.data.reason), reason: changed.data.reason })
      }
      return json(200, changed.data)
    }

    // The client cannot supply a separate weekly calendar, date exceptions,
    // time zone, or overlapping capacity. Store hours are authoritative.
    const agent = await db.from('agents').select('business_hours').eq('client_id', clientId).maybeSingle()
    if (agent.error) throw agent.error
    let settings
    try {
      const calendar = bookingCalendarFromStoreHours(getStoredBusinessSchedule(agent.data?.business_hours))
      const requested = objectValue(body.settings)
      if (requested.enabled === true && !Object.values(calendar.weekly).some(day => day.open)) {
        return json(400, { error: 'Set at least one open day in Store Hours before enabling bookings.' })
      }
      if (requested.enabled === true && (requested.hourly_limit === null || requested.hourly_limit === undefined)) {
        return json(400, { error: 'Set the number of bookings per hour.' })
      }
      settings = validateSchedulingSettings({ ...requested, ...calendar, capacity: null })
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : 'Invalid booking settings.' })
    }
    const result = await db.rpc('recepta_save_scheduling_settings', {
      p_client: clientId, p_rules: settings, ...(target !== null ? { p_prepare: true } : {}),
    })
    if (result.error) throw result.error
    const saved = Array.isArray(result.data) ? result.data[0] : result.data
    if (!saved) throw new Error('Supabase did not return the saved booking settings.')
    if (!activePro) return json(200, { settings: saved, synced: false, accessIssue })

    let agentId: string | null = null
    try {
      const result = await repairAppointmentAgent(db, clientId)
      agentId = result.agentId
      const syncedAt = new Date().toISOString()
      const sync = await db.from('booking_settings').update({ sync_agent_id: agentId, synced_at: syncedAt, sync_error: null })
        .eq('client_id', clientId).eq('updated_at', saved.updated_at).select('synced_at').maybeSingle()
      if (sync.error) throw sync.error
      if (!sync.data) return json(409, { error: 'Appointment settings changed while Retell was synchronizing. Reload the saved settings and retry if needed.' })
      return json(200, { settings: { ...saved, sync_agent_id: agentId, synced_at: syncedAt, sync_error: null }, synced: true })
    } catch (error) {
      const message = retellScheduleSyncMessage(error)
      const updated = await db.from('booking_settings').update({ sync_error: message, sync_agent_id: agentId, synced_at: null })
        .eq('client_id', clientId).eq('updated_at', saved.updated_at)
      if (updated.error) console.error('Could not record appointment synchronization error', updated.error.code)
      return json(200, { settings: { ...saved, sync_error: message, synced_at: null }, synced: false })
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    if (code === '42501') return json(403, { error: 'An active Recepta Pro plan is required.' })
    if (typeof code === 'string' && code.startsWith('22')) return json(400, { error: 'Check the scheduling timezone, dates and capacity rules.' })
    console.error('Appointment dashboard operation failed', { code })
    return json(500, { error: 'Appointment data could not be loaded or saved. Please try again.' })
  }
}
