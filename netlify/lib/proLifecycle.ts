import Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { billingOrigin, deliverBillingNotices } from './billingNotifications'
import { configuredStripeKey } from './subscriptionConfiguration'
import { normalizeAppointmentFields, receptaRetellOrigin, retellRequest, syncManagedRetellInboundRoute, syncRetellSchedule } from './retell'
import { loadServiceAccess } from './serviceAccess'
import { activeCallEmailSettings, normalizeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { loadClientScheduleContext } from './employeeSchedule'
import {
  captureRetellBackup, removeArchivedRetellAgent, replaceArchivedRetellAgent, resolveRetellRecoveryEngine,
  restoreRetellOutbound, retellAgentExists, type RetellBackup,
} from './retellLifecycle'

type Timeline = { reason?: string; deadline?: string; stripe_id?: string; invoice_id?: string }
type Work = { client_id: string; agent_id: string | null; timeline: Timeline; operation: string | null; notice_key: string }
type Lease = {
  lease: string; original_agent_id: string; replacement_agent_id: string | null; backup: RetellBackup | null
}
type Deployment = { key?: string; previewOrigin?: string; preview: boolean }

const checked = <T>(result: { data:T; error:unknown }) => {
  if (result.error) throw result.error
  return result.data
}

export const confirmUnpaidLifecycle = async (stripe: Stripe, timeline: Timeline, preview: boolean) => {
  if (!timeline.stripe_id) return timeline.reason !== 'cancellation'
  const remote = await stripe.subscriptions.retrieve(timeline.stripe_id)
  if (remote.id !== timeline.stripe_id || (preview && remote.livemode)) return false
  if (timeline.reason === 'cancellation') return remote.status === 'canceled'
  const latestId = typeof remote.latest_invoice === 'string' ? remote.latest_invoice : remote.latest_invoice?.id
  // A fresh invoice or successful renewal must be reconciled by Stripe before
  // any deletion. Checkout takes a separate database lease before payment.
  if (!latestId || timeline.invoice_id && timeline.invoice_id !== latestId) return false
  if (remote.status === 'canceled' && !timeline.invoice_id && remote.cancellation_details?.reason !== 'payment_failed') return true
  if (!['past_due','unpaid','incomplete','canceled'].includes(remote.status)) return false
  const invoice = await stripe.invoices.retrieve(latestId)
  return invoice.id === latestId && !(preview && invoice.livemode) &&
    ['open','uncollectible'].includes(invoice.status ?? '') && invoice.amount_remaining > 0
}

const queueWarning = async (db: SupabaseClient, work: Work, deployment: Deployment) => {
  if (!work.timeline.deadline) return
  const time = new Intl.DateTimeFormat('en-CA', { dateStyle:'long', timeStyle:'short', timeZone:'America/Toronto' })
    .format(new Date(work.timeline.deadline))
  const text = [
    'Your existing Recepta AI receptionist is scheduled for permanent removal on ' + time + ' Toronto time.',
    'Reactivate your subscription in Billing before the deadline if you want to keep the existing agent.',
    'Your Recepta account, business settings, phone number and appointment history are retained.',
    (deployment.previewOrigin ?? billingOrigin()) + '/dashboard/billing',
  ].join('\n\n')
  checked(await db.from('billing_notifications').upsert({
    notification_key:work.notice_key, client_id:work.client_id, kind:'agent_retention',
    payload:{ subject:'Your Recepta agent is scheduled for removal', text },
  }, { onConflict:'notification_key', ignoreDuplicates:true }))
}

const ownedPhoneNumbers = async (db: SupabaseClient, clientId: string, primary: string | null) => {
  const rows = checked(await db.from('agent_phone_numbers').select('phone_number').eq('client_id',clientId))
  const numbers = [...new Set([...(primary ? [primary] : []),...rows.map(row => row.phone_number as string)])]
  for (const number of numbers) {
    const [mapped, agents] = await Promise.all([
      db.from('agent_phone_numbers').select('client_id').eq('phone_number',number),
      db.from('agents').select('client_id').eq('phone_number',number),
    ])
    if ([...checked(mapped),...checked(agents)].some(row => row.client_id !== clientId)) {
      throw new Error('An assigned phone number is shared with another client.')
    }
  }
  return numbers
}

const processAgent = async (db: SupabaseClient, work: Work, deployment: Deployment) => {
  const key = deployment.key
  if (!key) return false
  const restoring = work.operation === 'deleted' || work.operation === 'restoring'
  if (!restoring && !work.operation &&
    (!work.timeline.deadline || Date.parse(work.timeline.deadline)>Date.now())) return false
  const stripeKey = configuredStripeKey(deployment.preview)
  if (!restoring && work.timeline.stripe_id && !stripeKey) return false

  const lease = checked(await db.rpc('recepta_pro_claim_lifecycle', {
    p_client:work.client_id, p_agent:work.agent_id, p_operation:restoring?'restoring':'deleting',
  })) as Lease | null
  if (!lease) return false

  const save = async (values: object) => {
    const data = checked(await db.from('recepta_pro_lifecycle').update(values).eq('client_id',work.client_id)
      .eq('lease',lease.lease).select('client_id').maybeSingle())
    if (!data) throw new Error('The agent operation lease expired.')
  }
  const finish = async (result: string, error: string | null = null) => {
    if (!checked(await db.rpc('recepta_pro_finish_lifecycle',{
      p_client:work.client_id,p_lease:lease.lease,p_result:result,p_error:error,
    }))) throw new Error('Could not confirm the agent operation result.')
  }

  try {
    const current = checked(await db.from('agents').select('retell_agent_id,phone_number,business_hours')
      .eq('client_id',work.client_id).maybeSingle())
    if (!current) throw new Error('The assigned receptionist record is missing.')
    const numbers = await ownedPhoneNumbers(db,work.client_id,current.phone_number)
    const oldId = lease.original_agent_id
    if (!restoring) {
      const exists = await retellAgentExists(key,oldId)
      if (!exists && lease.backup) {
        await finish('deleted')
        return true
      }
      if (!exists) throw new Error('Retell agent is missing and the recovery backup could not be verified.')
      const newBackup = await captureRetellBackup(key,oldId,numbers)
      await save({ backup:newBackup })
      const timeline = checked(await db.rpc('recepta_pro_timeline',{ p_client:work.client_id })) as Timeline
      const providerAllows = timeline.stripe_id
        ? stripeKey && await confirmUnpaidLifecycle(new Stripe(stripeKey, { timeout:5000,maxNetworkRetries:0 }),timeline,deployment.preview)
        : timeline.reason !== 'cancellation'
      const dbAllows = providerAllows && checked(await db.rpc('recepta_pro_confirm_delete',{
        p_client:work.client_id,p_lease:lease.lease,
      }))
      if (!dbAllows) {
        await finish('cancelled')
        return true
      }
      await removeArchivedRetellAgent(key,oldId)
      await finish('deleted')
      return true
    }

    const backup = lease.backup!
    const engine = lease.replacement_agent_id ? backup.engine : await resolveRetellRecoveryEngine(key,backup)
    if (engine.llm_id !== backup.engine.llm_id) {
      backup.engine=engine
      await save({ backup })
    }
    const replacement = lease.replacement_agent_id ?? await replaceArchivedRetellAgent(key,oldId,backup,engine)
    if (!lease.replacement_agent_id) await save({ replacement_agent_id:replacement })
    const version = await retellRequest<{ agent_id?:string; version?:number; is_published?:boolean }>(
      key,'/get-agent/' + encodeURIComponent(replacement))
    if (version.agent_id!==replacement || typeof version.version!=='number') throw new Error('Retell could not verify the recovery draft.')
    if (!version.is_published) await retellRequest(key,'/publish-agent-version/' + encodeURIComponent(replacement),
      { method:'POST',body:JSON.stringify({ version:version.version }) })
    if (!numbers.length) throw new Error('The retained phone number is missing.')
    const origin = deployment.previewOrigin ?? receptaRetellOrigin(false)
    for (const number of numbers) {
      await syncManagedRetellInboundRoute(key,number,replacement,origin,oldId)
      if (backup.outbound[number]) await restoreRetellOutbound(key,number,oldId,replacement,backup.outbound[number])
    }
    const [schedule, service, account, subscription] = await Promise.all([
      loadClientScheduleContext({ supabase:db,clientId:work.client_id,businessHours:current.business_hours }),
      loadServiceAccess(db,work.client_id),
      db.auth.admin.getUserById(work.client_id),
      db.from('subscriptions').select('ai_model_id,pii_redaction_enabled,safety_guardrails_enabled')
        .eq('client_id',work.client_id).maybeSingle(),
    ])
    const user = checked(account).user
    const billing = checked(subscription)
    const preferences = activeCallEmailSettings(user?.app_metadata)
    const plan = service.plan ?? 'Recepta Pro'
    await syncRetellSchedule({
      apiKey:key,agentId:replacement,...schedule,servicePlan:plan,appointmentScheduling:plan==='Recepta Pro',
      appointmentFields:preferences ? normalizeCallEmailSettings(preferences).customFields :
        normalizeAppointmentFields(user?.user_metadata?.appointment_custom_fields),
      emailNotificationsEnabled:user?.user_metadata?.appointment_email_notifications_enabled !== false,
      smsNotificationsEnabled:user?.user_metadata?.appointment_sms_notifications_enabled === true,
      provisionProtection: billing ? {
        aiModelId:billing.ai_model_id,piiRedactionEnabled:billing.pii_redaction_enabled===true,
        safetyGuardrailsEnabled:billing.safety_guardrails_enabled===true,demoMode:false,
      } : undefined,
      ensureCallEvents:true,deploymentOrigin:origin,preserveAvailability:true,
    })
    await finish('restored')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The agent retention operation could not be confirmed.'
    await finish('retry', message.slice(0,500))
  }
  return true
}

export const runProLifecycle = async (db: SupabaseClient, deployment: Deployment) => {
  const work = checked(await db.rpc('recepta_pro_lifecycle_work',{ p_limit:30 })) as Work[]
  const warnings = work.filter(item => !item.operation)
  for (const item of warnings) await queueWarning(db,item,deployment)
  for (const item of work) if (await processAgent(db,item,deployment)) break
  if (warnings.length) await deliverBillingNotices(db,1)
}
