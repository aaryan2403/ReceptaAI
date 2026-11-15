import { createHmac, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { activeCallEmailSettings, normalizeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { configuredEmailApiKey, configuredRetellKey } from './emailEnvironment'
import { getStoredBusinessSchedule } from './employeeSchedule'
import { hasPaidSubscription } from './subscriptionConfiguration'
import {
  inspectRetellAppointments, inspectRetellPhoneRoute, normalizeAppointmentFields, normalizeE164,
  receptaRetellOrigin, RetellSetupError, retellScheduleSyncMessage, syncRetellSchedule,
} from './retell'

const getAgentAssignment = async (db: SupabaseClient, clientId: string) => {
  const result = await db.from('agents').select('retell_agent_id, business_hours, status, phone_number')
    .eq('client_id', clientId).maybeSingle()
  if (result.error) throw result.error
  const agent = result.data
  const agentId = agent?.retell_agent_id?.trim()
  if (!agent || !agentId) throw new RetellSetupError('Assign and save a Retell receptionist for this business.')
  await assertAgentOwner(db, clientId, agentId)
  return { agentId, agent }
}

const assertAgentOwner = async (db: SupabaseClient, clientId: string, agentId: string) => {
  const ownership = await db.from('agents').select('client_id').eq('retell_agent_id', agentId).limit(2)
  if (ownership.error) throw ownership.error
  if (ownership.data.length !== 1 || ownership.data[0].client_id !== clientId) {
    throw new RetellSetupError('The Retell agent must be assigned only to this business.')
  }
}

const requireRetellKey = () => {
  const key = configuredRetellKey()
  if (!key) throw new RetellSetupError('The Retell workspace key for this deployment is missing from Netlify Functions.')
  return key
}

export const repairAppointmentAgent = async (db: SupabaseClient, clientId: string) => {
  const { agentId, agent } = await getAgentAssignment(db, clientId)
  const apiKey = requireRetellKey()
  const account = await db.auth.admin.getUserById(clientId)
  if (account.error) throw account.error

  const activeFields = activeCallEmailSettings(account.data.user?.app_metadata)
  const appointmentFields = activeFields ? normalizeCallEmailSettings(activeFields).customFields :
    normalizeAppointmentFields(account.data.user?.user_metadata?.appointment_custom_fields)
  const result = await syncRetellSchedule({
    apiKey, agentId, schedule: getStoredBusinessSchedule(agent.business_hours),
    appointmentFields, appointmentScheduling: true, schedulingOnly: true,
    beforePublish: () => assertAgentOwner(db, clientId, agentId),
  })
  await assertAgentOwner(db, clientId, agentId)
  return { agentId, version: result.version }
}

type ReadinessCheck = { label: string; status: 'ready' | 'blocked' | 'unverified' | 'optional'; detail: string }
const check = (label: string, status: ReadinessCheck['status'], detail: string): ReadinessCheck => ({ label, status, detail })

const probeSignedAppointmentEndpoint = async (origin: string, key: string, clientId: string, agentId: string) => {
  // Availability is read-only. An empty date reaches validation only after the
  // deployed handler verifies the signature, tenant mapping and Pro access.
  const body = JSON.stringify({
    name: 'recepta_check_availability', args: {},
    call: { agent_id: agentId, call_id: randomUUID(), metadata: { recepta_client_id: clientId } },
  })
  const now = String(Date.now())
  const digest = createHmac('sha256', key).update(body + now).digest('hex')
  const response = await fetch(origin + '/.netlify/functions/retell-appointment', {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-retell-signature': `v=${now},d=${digest}` },
  })
  if (response.status === 401) return 'The appointment endpoint rejected this deployment’s Retell signature.'
  if (response.status === 403) return 'The appointment endpoint rejected this business’s agent mapping or Pro entitlement.'
  if (!response.ok) return `The appointment endpoint returned HTTP ${response.status}.`
  const payload = await response.json()
  return payload?.reason === 'invalid_local_date_or_time' ? null : 'The appointment endpoint returned an unexpected response.'
}

export const appointmentAgentReadiness = async (db: SupabaseClient, clientId: string, activePro: boolean) => {
  const checks: ReadinessCheck[] = []
  const [subscription, numbers, rules] = await Promise.all([
    db.from('subscriptions').select('status, stripe_subscription_id, current_period_start, current_period_end, monthly_minutes')
      .eq('client_id', clientId).maybeSingle(),
    db.from('agent_phone_numbers').select('phone_number').eq('client_id', clientId),
    db.from('booking_settings').select('enabled, email_owner, email_customer').eq('client_id', clientId).maybeSingle(),
  ])
  if (subscription.error || numbers.error || rules.error) throw subscription.error ?? numbers.error ?? rules.error
  const billing = subscription.data
  const paid = hasPaidSubscription(billing) && (billing?.monthly_minutes ?? 0) > 0
  checks.push(check('Call authorization', paid ? 'ready' : 'blocked', paid
    ? 'The active billing period and minute allowance are configured. Each inbound call must still reserve minutes.'
    : 'An active Stripe subscription, current paid billing period, and call minutes are required.'))

  let assignment, apiKey, origin, webhookOrigin
  try {
    assignment = await getAgentAssignment(db, clientId)
    apiKey = requireRetellKey()
    origin = receptaRetellOrigin()
    webhookOrigin = receptaRetellOrigin(false)
  } catch (error) {
    checks.push(check('Agent connection', 'blocked', retellScheduleSyncMessage(error)))
    return { checks, canRetry: false }
  }

  const { agent, agentId } = assignment
  if (!['active', 'live'].includes(agent.status ?? '')) {
    checks.push(check('Inbound admission', 'blocked', 'The saved agent is not active. Complete the normal payment and activation flow.'))
  }
  const phoneNumbers = [...new Set([...numbers.data.map(row => row.phone_number), agent.phone_number]
    .map(number => normalizeE164(number)).filter((number): number is string => Boolean(number)))]
  const [published, routes, signed] = await Promise.allSettled([
    inspectRetellAppointments(apiKey, agentId, origin),
    Promise.all(phoneNumbers.map(async (number, index) => {
      const label = `Phone routing (${phoneNumbers.length > 1 ? 'line ' + (index + 1) + ', ' : ''}ending ${number.slice(-4)})`
      try {
        const issue = await inspectRetellPhoneRoute(apiKey, number, webhookOrigin)
        return check(label, issue ? 'blocked' : 'ready', issue ?? 'The number points to Recepta’s inbound authorization webhook.')
      } catch (error) {
        return check(label, 'blocked', retellScheduleSyncMessage(error))
      }
    })),
    activePro ? probeSignedAppointmentEndpoint(origin, apiKey, clientId, agentId) : Promise.resolve(null),
  ])

  if (published.status === 'fulfilled') {
    const { version, issue, webhook, hasTransferTool } = published.value
    checks.push(check('Agent connection', 'ready', `Retell’s published receptionist version ${version} is accessible.`))
    checks.push(check('Call events', webhook === webhookOrigin + '/.netlify/functions/retell-webhook' ? 'ready' : 'blocked',
      webhook === webhookOrigin + '/.netlify/functions/retell-webhook'
        ? 'The published agent sends call events to this deployment.' : 'The published agent’s call-event webhook is missing or points elsewhere.'))
    if (activePro) checks.push(check('Published appointment tools', issue ? 'blocked' : 'ready',
      issue ?? 'Availability, booking and request tools point to this deployment and use the expected configuration.'))
    checks.push(check('Human transfer', 'unverified', hasTransferTool
      ? 'A transfer tool is published. Verify an answered transfer and the no-answer path with real calls.'
      : 'The published agent has no Retell phone-transfer tool.'))
  } else {
    checks.push(check('Agent connection and publication', 'blocked', retellScheduleSyncMessage(published.reason)))
  }
  if (!phoneNumbers.length) {
    checks.push(check('Phone routing', 'blocked', 'Assign a number in this deployment’s Retell workspace and save it to this business.'))
  } else if (routes.status === 'fulfilled') {
    checks.push(...routes.value)
    checks.push(check('Inbound test call', 'unverified', 'Call the business number from an external line and verify that the assigned agent answers.'))
  }

  if (!activePro) {
    checks.push(check('Appointment authorization', 'optional', 'Appointment tools require an active Recepta Pro plan.'))
  } else {
    const issue = signed.status === 'fulfilled' ? signed.value : 'The signed appointment endpoint could not be reached.'
    checks.push(check('Signed appointment endpoint', issue ? 'blocked' : 'ready',
      issue ?? 'The deployed endpoint accepted the signature, agent mapping and Pro entitlement.'))
    let bookingIssue: string | null = null
    if (rules.data?.enabled) {
      const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      const availability = await db.rpc('recepta_scheduling_availability', { p_client: clientId, p_date: date })
      if (availability.error || !availability.data) {
        bookingIssue = 'Scheduling rules could not be read. Check the appointment migration and saved rules.'
      } else if (['schedule_not_set','pro_required','automatic_booking_disabled'].includes(availability.data.reason)) {
        bookingIssue = 'Automatic booking is unavailable. Check the saved schedule and active Pro entitlement.'
      } else if (!availability.data.alternatives?.length) {
        bookingIssue = 'There are no bookable times over the next week. Review open days, exceptions and capacity.'
      }
    }
    checks.push(check('Booking mode', bookingIssue ? 'blocked' : 'ready', bookingIssue ?? (rules.data?.enabled
      ? 'Automatic booking is enabled and the scheduling engine responds.' : 'Request-only mode is enabled. Requests await business confirmation.')))
    if (rules.data?.email_owner || rules.data?.email_customer) {
      checks.push(check('Appointment email', configuredEmailApiKey() ? 'unverified' : 'blocked', configuredEmailApiKey()
        ? 'An email key is configured. Verify receipt in the configured test inboxes.' : 'The Resend key for this deployment is missing.'))
    }
  }

  return { checks, canRetry: activePro }
}
