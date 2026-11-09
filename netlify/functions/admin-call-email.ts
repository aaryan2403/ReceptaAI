import { randomUUID } from 'node:crypto'
import { requestAuth, json, isDeletingClient } from '../lib/requestAuth'
import { normalizeCallEmailSettings, customCallFields, customCallFieldError, customEmailContentError, activeCallEmailSettings } from '../../src/lib/callEmailSettings'
import { syncRetellSchedule, getRetellAnalysisFields } from '../lib/retell'
import { loadClientScheduleContext } from '../lib/employeeSchedule'
import { buildCallNotification } from '../lib/callNotificationEmail'
import { configuredCallEmailRetellKey, emailApiKey, callEmailSender, assertEmailRecipients, emailProviderError, callEmailPreferencesEnabled, callEmailPreferencesReady } from '../lib/emailEnvironment'

export default async (request: Request) => {
  if (!['GET', 'PUT', 'POST'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    if (request.method === 'PUT' && !callEmailPreferencesEnabled()) return json(503, { error: 'Call email updates are temporarily disabled by the service configuration.' })
    const { db, user: admin } = auth
    const body = request.method === 'GET' ? null : await request.json()
    const clientId = body?.clientId ?? new URL(request.url).searchParams.get('clientId')
    if (typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientId)) return json(400, { error: 'A valid client is required.' })
    if (await isDeletingClient(db, clientId)) return json(409, { error: 'This account is awaiting deletion.' })
    const [account, client, subscription, agent] = await Promise.all([
      db.auth.admin.getUserById(clientId),
      db.from('clients').select('company_name,contact_email').eq('id', clientId).maybeSingle(),
      db.from('subscriptions').select('plan_name,status').eq('client_id', clientId).maybeSingle(),
      db.from('agents').select('retell_agent_id').eq('client_id', clientId).maybeSingle(),
    ])
    if (account.error || !account.data.user || client.error || !client.data || subscription.error || agent.error) return json(404, { error: 'Client email configuration could not be loaded.' })
    const targetUser = account.data.user
    const saved = normalizeCallEmailSettings(targetUser.app_metadata?.recepta_call_email)
    const settings = body?.settings ? normalizeCallEmailSettings(body.settings) : saved
    const planName: 'Recepta Standard' | 'Recepta Pro' = subscription.data?.plan_name === 'Recepta Pro' ? 'Recepta Pro' : 'Recepta Standard'
    if (request.method === 'GET') return json(200, { enabled: await callEmailPreferencesReady(db), settings: saved, needsSync: targetUser.app_metadata?.recepta_call_email_sync_required === true, planName, ownerEmail: client.data.contact_email, agentAssigned: Boolean(agent.data?.retell_agent_id) })
    if (request.method === 'PUT') {
      const problem = customCallFieldError(customCallFields(settings))
        || customEmailContentError(settings, planName === 'Recepta Pro', 'owner')
        || (settings.callerEnabled && customEmailContentError(settings, planName === 'Recepta Pro', 'caller'))
      if (problem) return json(400, { error: problem })
      const metadata = { ...targetUser.app_metadata, recepta_call_email: settings, recepta_call_email_sync_required: true,
        recepta_call_email_active: activeCallEmailSettings(targetUser.app_metadata) ?? null }
      const updated = await db.auth.admin.updateUserById(clientId, { app_metadata: metadata })
      if (updated.error) throw new Error('Could not save client email preferences.')
      if (!await callEmailPreferencesReady(db)) return json(200, { settings, synced: false, activationPending: true, message: 'Email preferences saved. Automatic call email customization awaits the database update. Save again after activation to update the AI agent.' })
      const agentId = agent.data?.retell_agent_id
      if (!agentId) return json(200, { settings, synced: false, message: 'Email settings saved. Assign an AI agent, then save these settings again to sync collection.' })
      try {
        const key = configuredCallEmailRetellKey()
        if (!key) throw new Error('The Retell workspace key is missing.')
        const context = await loadClientScheduleContext({ supabase: db, clientId })
        await syncRetellSchedule({ apiKey: key, agentId, ...context, callEmailSettings: settings, emailOnly: true,
          appointmentFields: settings.customFields,
          emailNotificationsEnabled: targetUser.user_metadata?.appointment_email_notifications_enabled !== false,
          smsNotificationsEnabled: targetUser.user_metadata?.appointment_sms_notifications_enabled === true })
        const activated = await db.auth.admin.updateUserById(clientId, { app_metadata: { ...metadata, recepta_call_email_active: settings, recepta_call_email_sync_required: false } })
        if (activated.error) throw new Error('The agent was updated, but recording its active settings failed. Retry the save to complete synchronization.')
        return json(200, { settings, synced: true, message: 'Email settings saved and synced with the AI agent.' })
      } catch (failure) {
        return json(502, { saved: true, settings, error: `Email settings saved, but AI sync failed: ${failure instanceof Error ? failure.message : 'Please retry.'}` })
      }
    }
    if (body?.action === 'load_agent_fields') {
      const agentId = agent.data?.retell_agent_id
      if (!agentId) return json(409, { error: 'Assign this client’s Retell agent before loading extraction fields.' })
      const key = configuredCallEmailRetellKey()
      if (!key) return json(503, { error: 'The Retell workspace key is missing.' })
      const availableFields = await getRetellAnalysisFields(key, agentId)
      return json(200, { availableFields, message: availableFields.length ? 'Published Retell fields loaded. Choose the ones to use below, then save.' : 'This agent has no reusable custom extraction fields. Add new call fields below.' })
    }
    if (body?.action === 'check_provider') {
      const key = emailApiKey()
      const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error(emailProviderError(response.status))
      const domains = await response.json() as { data?: Array<{ name: string; status: string }> }
      const sender = callEmailSender()
      const senderDomain = (sender.match(/@([^>\s]+)/)?.[1] ?? '').toLowerCase()
      const verified = domains.data?.some(domain => domain.name.toLowerCase() === senderDomain && domain.status === 'verified') === true
      return json(200, { ready: verified, message: verified ? `Resend authenticated. Sender domain ${senderDomain} is verified. Send a test to check delivery.` : `Resend authenticated, but sender domain ${senderDomain} is not verified.`, sender })
    }
    const sample = { planName, businessName: client.data.company_name || 'Sample business', ownerEmail: client.data.contact_email || admin.email,
      callerName: 'Sample caller', callerNumber: '+14165550100', callerEmail: 'sample@example.test', startedAt: new Date().toISOString(), durationSeconds: 90,
      timeZone: 'America/Toronto', outcome: 'Message recorded', summary: 'The caller requested a quote. The business needs to follow up.',
      callerSummary: 'You requested a quote. The business will follow up with you.', settings,
      customDetails: settings.customFields.map(label => ({ label, value: 'Sample answer' })),
      appointment: { status: 'pending', requestedDate: 'Next Tuesday', requestedTime: 'Afternoon', customerName: 'Sample caller', timeZone: 'America/Toronto' } }
    const owner = buildCallNotification(sample)
    const caller = buildCallNotification({ ...sample, recipient: 'caller' })
    if (body?.action === 'preview') return json(200, { owner, caller })
    if (body?.action !== 'send_test') return json(400, { error: 'Unknown email action.' })
    // Test destination is the authenticated admin, never an arbitrary supplied recipient.
    const contentProblem = customEmailContentError(settings, planName === 'Recepta Pro', body.role === 'caller' ? 'caller' : 'owner')
    if (contentProblem) return json(400, { error: contentProblem })
    const mail = { ...(body.role === 'caller' ? caller : owner), to: [admin.email!], reply_to: admin.email!, subject: '[RECEPTA TEST] ' + (body.role === 'caller' ? caller.subject : owner.subject) }
    assertEmailRecipients(mail.to)
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${emailApiKey()}`, 'Content-Type': 'application/json', 'Idempotency-Key': `admin-email-test:${randomUUID()}` }, body: JSON.stringify(mail) })
    if (!response.ok) throw new Error(emailProviderError(response.status))
    const receipt = await response.json() as { id?: string }
    if (!receipt.id) throw new Error('Resend did not return an acceptance receipt.')
    return json(200, { accepted: true, providerId: receipt.id, message: `Test accepted by Resend for ${admin.email}. Check your inbox and spam folder; acceptance does not confirm delivery.` })
  } catch (failure) { return json(500, { error: failure instanceof Error ? failure.message : 'Email operation failed.' }) }
}
