import { getPublishedRetellAgent, listAvailableRetellAgents, readRetellLlm, RetellRequestError, retellRequest } from './retell'

type Engine = { type: 'retell-llm'; llm_id: string; version: number }
type Phone = {
  phone_number: string
  inbound_agents?: { agent_id: string }[] | null
  outbound_agents?: { agent_id: string; agent_version?: string | number; weight?: number }[] | null
}
export type RetellBackup = {
  settings: Record<string, unknown>
  engine: Engine
  llm: Record<string, unknown>
  outbound: Record<string, NonNullable<Phone['outbound_agents']>>
}

// Only fields accepted by the provider's Create Voice Agent and Create Retell
// LLM APIs are replayed. The response IDs, timestamps and publication state are
// managed by Retell.
const agentFields = [
  'voice_id', 'agent_name', 'version_description', 'llm_websocket_url', 'voice_model', 'fallback_voice_ids',
  'voice_temperature', 'voice_speed', 'volume', 'responsiveness', 'interruption_sensitivity',
  'enable_backchannel', 'backchannel_frequency', 'backchannel_words', 'reminder_trigger_ms', 'reminder_max_count',
  'ambient_sound', 'ambient_sound_volume', 'normalize_for_speech', 'language', 'webhook_url', 'webhook_events',
  'webhook_timeout_ms', 'boosted_keywords', 'data_storage_setting', 'opt_in_signed_url', 'signed_url_expiration_ms',
  'end_call_after_silence_ms', 'max_call_duration_ms', 'begin_message_delay_ms', 'voicemail_option', 'ivr_option',
  'allow_user_dtmf', 'user_dtmf_options', 'ring_duration_ms', 'post_call_analysis_data', 'post_call_analysis_model',
  'pronunciation_dictionary', 'pii_config', 'guardrail_config', 'dynamic_variables', 'denoising_mode', 'stt_mode',
  'vocab_specialization', 'analysis_successful_prompt', 'analysis_summary_prompt',
] as const
const llmFields = [
  'model', 'model_temperature', 'model_high_priority', 'general_prompt', 'general_tools', 'states', 'starting_state',
  'begin_message', 'default_dynamic_variables', 'knowledge_base_ids', 'kb_config', 'start_speaker',
] as const
const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))

export const retellAgentExists = async (key: string, id: string) => {
  try {
    const agent = await retellRequest<{ agent_id?: string }>(key, '/get-agent/' + encodeURIComponent(id))
    if (agent?.agent_id !== id) throw new Error('Retell did not confirm the archived agent identity.')
    return true
  } catch (error) {
    if (error instanceof RetellRequestError && error.status === 404) return false
    throw error
  }
}

export const captureRetellBackup = async (key: string, id: string, ownedNumbers: string[]): Promise<RetellBackup> => {
  const agent = await getPublishedRetellAgent(key,id)
  if (agent.response_engine?.type !== 'retell-llm' || !agent.response_engine.llm_id ||
      typeof agent.response_engine.version !== 'number') throw new Error('Retell agent has no restorable published response engine.')
  const saved = pick(agent as Record<string, unknown>, agentFields)
  if (typeof saved.voice_id !== 'string') throw new Error('Retell agent has no restorable voice.')
  const llm = pick(await readRetellLlm(key,agent) as Record<string, unknown>, llmFields)
  if (typeof llm.general_prompt !== 'string' && !Array.isArray(llm.states)) {
    throw new Error('The published Retell response engine could not be archived.')
  }

  const outbound: RetellBackup['outbound'] = {}
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ limit: '100' })
    if (cursor) query.set('pagination_key',cursor)
    const page = await retellRequest<{ items?: Phone[]; has_more?: boolean; pagination_key?: string }>(
      key, '/v2/list-phone-numbers?' + query, { method: 'POST', body: '{}' })
    if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean' ||
      (page.has_more && (!page.pagination_key || cursors.has(page.pagination_key)))) {
      throw new Error('Could not verify the complete Retell phone inventory.')
    }
    for (const phone of page.items) {
      const incoming = phone.inbound_agents?.some(item => item.agent_id === id)
      const outgoing = phone.outbound_agents?.some(item => item.agent_id === id)
      if (!incoming && !outgoing) continue
      if (!ownedNumbers.includes(phone.phone_number)) throw new Error('This agent is used by another Retell phone number.')
      if (outgoing) outbound[phone.phone_number] = phone.outbound_agents ?? []
    }
    cursor = page.has_more ? page.pagination_key : undefined
    if (cursor) cursors.add(cursor)
    if (cursors.size > 100) throw new Error('Retell phone inventory is too large to verify safely.')
  } while (cursor)
  return { settings: saved, engine: { type: 'retell-llm', llm_id: agent.response_engine.llm_id, version: agent.response_engine.version }, llm, outbound }
}

export const removeArchivedRetellAgent = async (key: string, id: string) => {
  try {
    await retellRequest(key, '/delete-agent/' + encodeURIComponent(id), { method: 'DELETE' })
  } catch (error) {
    if (!(error instanceof RetellRequestError && error.status === 404)) throw error
  }
  if (await retellAgentExists(key,id)) throw new Error('Retell has not confirmed that the archived agent was deleted.')
}

export const resolveRetellRecoveryEngine = async (key: string, backup: RetellBackup): Promise<Engine> => {
  try {
    const engine = await retellRequest<{ llm_id?: string }>(key,
      '/get-retell-llm/' + encodeURIComponent(backup.engine.llm_id) + '?version=' + backup.engine.version)
    if (engine.llm_id !== backup.engine.llm_id) throw new Error('Retell did not confirm the archived engine.')
    return backup.engine
  } catch (error) {
    if (!(error instanceof RetellRequestError && error.status === 404)) throw error
  }
  const result = await retellRequest<{ llm_id?: string; version?: number }>(key, '/create-retell-llm',
    { method: 'POST', body: JSON.stringify(backup.llm) })
  if (!result.llm_id || typeof result.version !== 'number') throw new Error('Retell did not confirm the restored response engine.')
  return { type:'retell-llm', llm_id:result.llm_id, version:result.version }
}

export const replaceArchivedRetellAgent = async (key: string, originalId: string, backup: RetellBackup, engine: Engine) => {
  const name = 'Recepta recovered ' + originalId
  let cursor: string | undefined
  const candidates: string[] = []
  const visited = new Set<string>()
  do {
    const page = await listAvailableRetellAgents(key,cursor)
    candidates.push(...page.agents.filter(agent => agent.name === name && !agent.transferOnly && !agent.suspended).map(agent => agent.id))
    cursor = page.nextCursor
    if (cursor && (visited.has(cursor) || visited.size > 100)) throw new Error('Could not verify the Retell recovery inventory.')
    if (cursor) visited.add(cursor)
  } while (cursor)
  if (candidates.length > 1) throw new Error('Multiple Retell replacements match this recovery. Review the agent inventory.')
  if (candidates.length === 1) {
    const existing = await retellRequest<{ response_engine?: Engine }>(key,'/get-agent/' + encodeURIComponent(candidates[0]))
    if (existing.response_engine?.llm_id !== engine.llm_id) throw new Error('A replacement agent has an unexpected response engine.')
    return candidates[0]
  }
  const result = await retellRequest<{ agent_id?: string }>(key, '/create-agent', {
    method:'POST', body:JSON.stringify({ ...backup.settings, agent_name:name, response_engine:engine }),
  })
  if (!result?.agent_id || result.agent_id === originalId) throw new Error('Retell did not confirm creation of a replacement agent.')
  return result.agent_id
}

export const restoreRetellOutbound = async (key: string, phoneNumber: string, oldId: string, newId: string,
  saved: NonNullable<Phone['outbound_agents']>) => {
  const current = await retellRequest<Phone>(key,'/get-phone-number/' + encodeURIComponent(phoneNumber))
  if (current.phone_number !== phoneNumber) throw new Error('Retell did not confirm the existing phone number.')
  const bindings = current.outbound_agents ?? []
  if (bindings.some(item => item.agent_id === newId)) return
  const others = saved.filter(item => item.agent_id !== oldId)
  if (bindings.filter(item => item.agent_id !== oldId).map(item => item.agent_id).sort().join(',') !==
    others.map(item => item.agent_id).sort().join(',')) throw new Error('Retell outbound routing changed during retention.')
  const old = saved.find(item => item.agent_id === oldId)
  if (!old) return
  await retellRequest(key,'/update-phone-number/' + encodeURIComponent(phoneNumber),{
    method:'PATCH', body:JSON.stringify({ outbound_agents:[...bindings.filter(item => item.agent_id !== oldId),
      { ...old, agent_id:newId, agent_version:'latest_published' }] }),
  })
}
