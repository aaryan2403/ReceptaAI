import type { SupabaseClient } from '@supabase/supabase-js'
import { activeCallEmailSettings, normalizeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { bookingDay, defaultSchedulingSettings } from '../../src/lib/appointmentScheduling'
import { getStoredBusinessSchedule, loadClientScheduleContext } from './employeeSchedule'
import {
  assertRetellAgentAvailable, findProvisionedRetellPhone, normalizeAppointmentFields, normalizeE164,
  purchaseRetellPhoneNumber, receptaRetellOrigin, retellScheduleSyncMessage,
  RetellSetupError, syncManagedRetellInboundRoute, syncRetellSchedule,
} from './retell'
import { loadServiceAccess, serviceDeployment } from './serviceAccess'
import type { ServiceJob } from './serviceJobs'

export const startProProvisioning = async (request: Request, clientId: string) => {
  try {
    const deployment = serviceDeployment(request)
    const origin = deployment.previewOrigin ?? receptaRetellOrigin(false)
    const response = await fetch(origin + '/.netlify/functions/provision-pro-background', {
      method: 'POST', body: JSON.stringify({ clientId }), redirect: 'error',
      headers: { Authorization: request.headers.get('authorization') ?? '', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) console.warn('Immediate Pro provisioning trigger unavailable. The durable job is queued.')
  } catch {
    console.warn('Immediate Pro provisioning trigger unavailable. The durable job is queued.')
  }
}

const canProvision = async (db: SupabaseClient, clientId: string) => {
  const result = await db.rpc('recepta_provisioning_candidate', { p_client: clientId, p_allow_paid: true })
  if (result.error) throw result.error
  return result.data === true
}

const ownedLines = async (db: SupabaseClient, clientId: string, legacy: string | null) => {
  const result = await db.from('agent_phone_numbers').select('phone_number').eq('client_id', clientId)
    .order('is_primary', { ascending: false }).order('created_at')
  if (result.error) throw result.error
  return [...new Set([...result.data.map(row => row.phone_number), ...(legacy ? [legacy] : [])])]
}

export const provisionPro = async (db: SupabaseClient, job: ServiceJob,
  deployment: { key?: string; previewOrigin?: string }) => {
  const clientId = job.client_id
  if (!await canProvision(db, clientId)) return
  const access = await loadServiceAccess(db, clientId)
  if (!access.agent_id || !access.assignment_valid) throw new RetellSetupError('Assign a unique Retell agent to this Pro client.')
  const apiKey = deployment.key
  if (!apiKey) throw new RetellSetupError('The Retell API key is missing for this deployment.')
  const agentId = access.agent_id
  const agent = await db.from('agents').select('business_hours, phone_number, demo_mode').eq('client_id', clientId).maybeSingle()
  const subscription = await db.from('subscriptions').select('ai_model_id, pii_redaction_enabled, safety_guardrails_enabled')
    .eq('client_id', clientId).maybeSingle()
  if (agent.error || subscription.error) throw agent.error ?? subscription.error
  if (!agent.data || !subscription.data) throw new RetellSetupError('The saved agent or service configuration is missing.')

  // Recheck ownership and the explicit holds before a provider write.
  const verifyAssignment = async () => {
    const current = await loadServiceAccess(db, clientId)
    if (current.agent_id !== agentId || !current.assignment_valid || !await canProvision(db, clientId)) {
      throw new RetellSetupError('The agent assignment or service authorization changed during provisioning.')
    }
  }

  const origin = deployment.previewOrigin ?? receptaRetellOrigin(false)
  try {
    await assertRetellAgentAvailable({ apiKey, agentId })
    const phones = await ownedLines(db, clientId, agent.data.phone_number)
    const minimum = Number(job.payload.minimum_phone_count ?? 0)
    const country = job.payload.country_code === 'US' ? 'US' : 'CA'
    const area = Number(job.payload.area_code) || null
    while (phones.length < minimum) {
      await verifyAssignment()
      // If Retell bought the line before a response or DB write failed, the next
      // lease reconciles that exact purchase from Retell's phone inventory.
      const nickname = `Recepta Pro ${clientId}/${phones.length + 1}`
      const number = await findProvisionedRetellPhone(apiKey, nickname, agentId) ??
        await purchaseRetellPhoneNumber({ apiKey, agentId, countryCode: country, areaCode: area, nickname, deploymentOrigin: origin })
      if (phones.includes(number)) throw new RetellSetupError('The provisioned phone number already belongs to this client.')
      const saved = await db.from('agent_phone_numbers').insert({
        client_id: clientId, phone_number: number, source: 'retell', is_primary: !phones.length,
      })
      if (saved.error) throw saved.error
      phones.push(number)
    }
    if (!phones.length || phones.some(number => normalizeE164(number) !== number)) {
      throw new RetellSetupError('Connect an existing Retell phone number in Edit Client to continue provisioning.')
    }
    for (const number of phones) {
      const legacy = await db.from('agents').select('client_id').eq('phone_number', number)
      const mapped = await db.from('agent_phone_numbers').select('client_id').eq('phone_number', number).maybeSingle()
      if (legacy.error || mapped.error) throw legacy.error ?? mapped.error
      if (legacy.data.some(row => row.client_id !== clientId) || (mapped.data && mapped.data.client_id !== clientId)) {
        throw new RetellSetupError(`The phone number ending in ${number.slice(-4)} is assigned to another client.`)
      }
      await verifyAssignment()
      await syncManagedRetellInboundRoute(apiKey, number, agentId, origin)
    }
    if (!agent.data.phone_number) {
      const saved = await db.from('agents').update({ phone_number: phones[0] }).eq('client_id', clientId).eq('retell_agent_id', agentId)
      if (saved.error) throw saved.error
    }

    const [account, scheduleContext] = await Promise.all([
      db.auth.admin.getUserById(clientId),
      loadClientScheduleContext({ supabase: db, clientId, businessHours: agent.data.business_hours }),
    ])
    if (account.error) throw account.error
    const metadata = account.data.user?.user_metadata
    const emailSettings = activeCallEmailSettings(account.data.user?.app_metadata)
    const appointmentFields = emailSettings ? normalizeCallEmailSettings(emailSettings).customFields :
      normalizeAppointmentFields(metadata?.appointment_custom_fields)
    await syncRetellSchedule({
      apiKey, agentId, ...scheduleContext, appointmentFields, servicePlan: 'Recepta Pro', appointmentScheduling: true,
      ensureCallEvents: true, deploymentOrigin: origin, beforePublish: verifyAssignment,
      preserveAvailability: scheduleContext.schedule.mode === 'unconfigured',
      emailNotificationsEnabled: metadata?.appointment_email_notifications_enabled !== false,
      smsNotificationsEnabled: metadata?.appointment_sms_notifications_enabled === true,
      provisionProtection: {
        aiModelId: subscription.data.ai_model_id,
        piiRedactionEnabled: subscription.data.pii_redaction_enabled === true,
        safetyGuardrailsEnabled: subscription.data.safety_guardrails_enabled === true,
        demoMode: agent.data.demo_mode === true,
      },
    })
    // Existing booking policies are preserved. Start new calendars from the
    // business's supplied opening hours, or capture requests until hours exist.
    const schedule = getStoredBusinessSchedule(agent.data.business_hours)
    const rules = defaultSchedulingSettings(schedule.timeZone)
    rules.email_owner = true
    rules.email_customer = metadata?.appointment_email_notifications_enabled !== false
    if (schedule.mode !== 'unconfigured') {
      rules.enabled = true
      rules.weekly = Object.fromEntries(schedule.hours.map((day, index) => [
        String(index + 1),
        schedule.mode === '24/7'
          ? { ...bookingDay(true), start: '00:00', end: '24:00' }
          : { ...bookingDay(day.open), start: day.start, end: day.end },
      ]))
    }
    const settings = await db.from('booking_settings').upsert({ ...rules, client_id: clientId,
      sync_agent_id: agentId, synced_at: new Date().toISOString() }, { onConflict: 'client_id', ignoreDuplicates: true })
    if (settings.error) throw settings.error

    const completion = await db.rpc('recepta_complete_provisioning', {
      p_client: clientId, p_lease: job.lease_token, p_agent: agentId, p_phone_numbers: [...phones].sort(),
    })
    if (completion.error) throw completion.error
    if (!completion.data) throw new RetellSetupError('The account changed during provisioning. The worker will recheck it.')
  } catch (error) {
    if (error instanceof Error) throw new Error(retellScheduleSyncMessage(error))
    throw error
  }
}
