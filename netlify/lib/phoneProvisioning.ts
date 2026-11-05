import type { SupabaseClient } from '@supabase/supabase-js'
import { assertAgentAssignable } from './agentOwnership'
import { checked, loadPhoneAccount, PhoneError, withPhoneLock } from './phoneSetup'

export const automaticReceptionConfigured = () => process.env.RECEPTA_PHONE_SETUP_ENABLED === 'true' && process.env.RECEPTA_AUTO_PROVISION_ENABLED === 'true'
  && Boolean(process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID && process.env.RETELL_API_KEY)

// Called exclusively after the existing signed paid-invoice workflow. A journal
// records intent before each non-idempotent provider creation. Unknown outcomes
// stop for reconciliation instead of creating duplicate resources on retries.
export const ensurePaidReceptionAgent = async (db: SupabaseClient, clientId: string) => {
  const existing = checked(await db.from('agents').select('retell_agent_id').eq('client_id', clientId).maybeSingle())
  if (existing?.retell_agent_id) {
    await assertAgentAssignable(db, existing.retell_agent_id, clientId)
    return existing.retell_agent_id as string
  }
  if (!automaticReceptionConfigured()) throw new PhoneError(503, 'Automatic receptionist setup is not configured. No provider resources were created.')
  return withPhoneLock(db, clientId, async () => {
    const account = await loadPhoneAccount(db, clientId)
    if (!account.paid) throw new PhoneError(403, 'Confirmed current payment is required before provisioning.')
    if (account.agent?.retell_agent_id) return account.agent.retell_agent_id as string
    const client = checked(await db.from('clients').select('company_name,deletion_pending').eq('id', clientId).maybeSingle())
    if (!client || client.deletion_pending) throw new PhoneError(409, 'Account unavailable.')
    const templateId = process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID!
    const templateOwners = checked(await db.from('agents').select('client_id').eq('retell_agent_id', templateId).limit(1))
    if (templateOwners.length) throw new PhoneError(409, 'The onboarding template must be a separate approved generic template, not a customer agent.')
    let journal = checked(await db.from('phone_provisioning').select('*').eq('client_id', clientId).maybeSingle())
    if (journal?.state === 'creating_llm' || journal?.state === 'creating_agent') throw new PhoneError(409, 'Provider creation has an uncertain outcome. Reconciliation is required before retrying; no duplicate will be created.')
    const api = async (path: string, body?: Record<string, unknown>) => {
      const response = await fetch('https://api.retellai.com' + path, { method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + process.env.RETELL_API_KEY, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000), ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) throw new Error('Provider receptionist setup failed. The creation journal is preserved for safe retry/reconciliation.')
      return await response.json()
    }
    const save = async (values: Record<string, unknown>) => {
      checked(await db.from('phone_provisioning').upsert({ client_id: clientId, ...journal, ...values, updated_at: new Date().toISOString() }, { onConflict: 'client_id' }))
      journal = { ...journal, ...values }
    }
    const template = await api('/get-agent/' + encodeURIComponent(templateId))
    if (template.agent_id !== templateId || template.response_engine?.type !== 'retell-llm' || !template.response_engine.llm_id || !template.voice_id) throw new Error('Approved onboarding template must be a Retell LLM voice agent.')
    if (!journal?.llm_id) {
      const llm = await api('/get-retell-llm/' + encodeURIComponent(template.response_engine.llm_id) + (typeof template.response_engine.version === 'number' ? '?version=' + template.response_engine.version : ''))
      if (llm.states?.length || (llm.general_tools ?? []).some((tool: { type?: string }) => ['transfer_call', 'agent_swap'].includes(tool.type ?? ''))) throw new Error('Use an approved single-prompt template without existing transfer routes.')
      await save({ state: 'creating_llm' })
      const created = await api('/create-retell-llm', {
        ...(llm.model_config ? { model_config: llm.model_config } : { model: llm.model }),
        general_prompt: llm.general_prompt ?? '', general_tools: llm.general_tools ?? [],
        start_speaker: llm.start_speaker ?? 'agent', begin_message: llm.begin_message ?? null,
        default_dynamic_variables: { recepta_company_name: String(client.company_name ?? 'the business'), recepta_transfer_allowed: 'disabled', recepta_transfer_destination: '' },
      })
      if (!created.llm_id) throw new Error('Provider LLM creation could not be confirmed.')
      await save({ state: 'llm_ready', llm_id: created.llm_id })
    }
    if (!journal.agent_id) {
      await save({ state: 'creating_agent' })
      const created = await api('/create-agent', { agent_name: 'Recepta ' + clientId,
        response_engine: { type: 'retell-llm', llm_id: journal.llm_id }, voice_id: template.voice_id,
        language: template.language ?? 'en-US', max_call_duration_ms: 7200000,
        webhook_url: new URL('/.netlify/functions/retell-webhook', process.env.RECEPTA_APP_URL || process.env.URL || 'https://recepta.ca').toString(),
        webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
      })
      if (!created.agent_id) throw new Error('Provider agent creation could not be confirmed.')
      await save({ state: 'agent_ready', agent_id: created.agent_id })
    }
    await assertAgentAssignable(db, journal.agent_id, clientId)
    // Never overwrite an existing assigned agent or its business configuration.
    const latest = checked(await db.from('agents').select('retell_agent_id').eq('client_id', clientId).maybeSingle())
    if (latest?.retell_agent_id && latest.retell_agent_id !== journal.agent_id) throw new PhoneError(409, 'An agent was assigned during setup. Reconcile the unused creation before continuing.')
    checked(await db.rpc('assign_recepta_provisioned_agent', { p_client_id: clientId, p_agent_id: journal.agent_id }))
    checked(await db.rpc('register_recepta_agent_llm', { p_agent_id: journal.agent_id, p_llm_id: journal.llm_id }))
    await save({ state: 'assigned' })
    return journal.agent_id as string
  })
}
