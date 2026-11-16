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

const probeSignedAppointmentEndpoint = async (origin: string, key: string, clientId: string, agentId: string, date: string) => {
  // A real availability lookup also verifies the deployed handler can reach its scheduling RPC.
  const body = JSON.stringify({
    name: 'recepta_check_availability', args: { requested_date: date },
    call: { agent_id: agentId, call_id: randomUUID(), metadata: { recepta_client_id: clientId } },
  })
  const now = String(Date.now())
  const digest = createHmac('sha256', key).update(body + now).digest('hex')
  const response = await fetch(origin + '/.netlify/functions/retell-appointment', {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/json', 'x-retell-signature': `v=${now},d=${digest}` },
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401) throw new RetellSetupError('The appointment endpoint rejected this deployment’s Retell signature. Check the workspace key.')
  if (payload?.code === 'inactive_pro_subscription') throw new RetellSetupError('The appointment endpoint rejected the Pro subscription. Check payment and the deployed Supabase project.')
  if (payload?.code === 'agent_mapping_invalid' || payload?.code === 'tenant_mismatch') throw new RetellSetupError('The appointment endpoint rejected the agent assignment. Check the selected agent and deployed Supabase project.')
  if (payload?.code === 'scheduling_backend_unavailable') throw new RetellSetupError('The appointment endpoint could not read the scheduling database. Check the migration and Function logs.')
  if (payload?.code === 'configuration_missing') throw new RetellSetupError('The appointment endpoint is missing its Netlify Function configuration.')
  if (!response.ok) throw new RetellSetupError(`The appointment endpoint returned HTTP ${response.status}. Check the Function URL and logs.`)
  if (typeof payload?.available !== 'boolean' || !Array.isArray(payload.alternatives)) {
    throw new RetellSetupError('The appointment endpoint returned an unexpected response. Check that it runs the scheduling implementation.')
  }
  return { reason: payload.reason, alternatives: payload.alternatives }
}

export const appointmentAgentReadiness = async (db: SupabaseClient, clientId: string, accessIssue: string | null) => {
  const checks: ReadinessCheck[] = []
  const [subscription, numbers, rules] = await Promise.all([
    db.from('subscriptions').select('status, stripe_subscription_id, current_period_start, current_period_end, monthly_minutes')
      .eq('client_id', clientId).maybeSingle(),
    db.from('agent_phone_numbers').select('phone_number').eq('client_id', clientId),
    db.from('booking_settings').select('enabled, time_zone, email_owner, email_customer').eq('client_id', clientId).maybeSingle(),
  ])
  if (subscription.error || numbers.error || rules.error) throw subscription.error ?? numbers.error ?? rules.error
  const billing = subscription.data
  const paid = hasPaidSubscription(billing) && (billing?.monthly_minutes ?? 0) > 0
  checks.push(check('Call authorization', paid ? 'ready' : 'blocked', paid
    ? 'The active billing period and minute allowance are configured. Each inbound call must still reserve minutes.'
    : 'An active Stripe subscription, current paid billing period, and call minutes are required.'))
  checks.push(check('Appointment authorization', accessIssue ? 'blocked' : 'ready',
    accessIssue ?? 'This business has a current paid Recepta Pro subscription.'))

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
    accessIssue ? Promise.resolve(null) : probeSignedAppointmentEndpoint(origin, apiKey, clientId, agentId,
      new Intl.DateTimeFormat('sv-SE', { timeZone: rules.data?.time_zone ?? 'UTC', dateStyle: 'short' }).format(new Date())),
  ])

  if (published.status === 'fulfilled') {
    const { version, issue, webhook, hasTransferTool } = published.value
    checks.push(check('Agent connection', 'ready', `Retell’s published receptionist version ${version} is accessible.`))
    checks.push(check('Call events', webhook === webhookOrigin + '/.netlify/functions/retell-webhook' ? 'ready' : 'blocked',
      webhook === webhookOrigin + '/.netlify/functions/retell-webhook'
        ? 'The published agent sends call events to this deployment.' : 'The published agent’s call-event webhook is missing or points elsewhere.'))
    if (!accessIssue) checks.push(check('Published appointment tools', issue ? 'blocked' : 'ready',
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

  if (!accessIssue) {
    const availability = signed.status === 'fulfilled' ? signed.value : null
    checks.push(check('Signed appointment endpoint', availability ? 'ready' : 'blocked',
      signed.status === 'rejected' ? retellScheduleSyncMessage(signed.reason) :
        'The deployed endpoint accepted the signature and read this business’s scheduling rules.'))
    if (availability) {
      const auto = rules.data?.enabled === true
      const bookingIssue = auto
        ? ['schedule_not_set', 'automatic_booking_disabled'].includes(availability.reason)
          ? 'Automatic booking is unavailable. Check the saved schedule and deployment.'
          : availability.alternatives.length === 0 ? 'No bookable times were found over the next week. Review hours, exceptions, and capacity.' : null
        : availability.reason !== 'automatic_booking_disabled' ? 'The deployed booking mode differs from the saved settings.' : null
      checks.push(check('Booking mode', bookingIssue ? 'blocked' : 'ready', bookingIssue ?? (auto
        ? 'Automatic booking is enabled and the scheduling engine returned bookable times.'
        : 'Request-only mode is enabled. Requests await business confirmation.')))
    }
    if (rules.data?.email_owner || rules.data?.email_customer) {
      checks.push(check('Appointment email', configuredEmailApiKey() ? 'unverified' : 'blocked', configuredEmailApiKey()
        ? 'An email key is configured. Verify receipt in the configured test inboxes.' : 'The Resend key for this deployment is missing.'))
    }
  }

  return { checks, canRetry: !accessIssue }
}
