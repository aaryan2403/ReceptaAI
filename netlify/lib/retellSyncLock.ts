import { getRetellApiKey } from './retellEnvironment'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const withRetellAgentSync = async <T>(agentId: string, run: () => Promise<T>): Promise<T> => {
  // Existing service is unchanged until the staged feature and migration are enabled.
  if (process.env.RECEPTA_PHONE_SETUP_ENABLED !== 'true') return run()
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Agent synchronization storage is unavailable.')
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const token = randomUUID()
  const lock = await db.rpc('acquire_retell_agent_sync', { p_agent_id: agentId, p_token: token })
  if (lock.error || lock.data !== true) throw new Error('This agent is being updated. Retry after that update finishes.')
  try {
    const assignments = await db.from('agents').select('client_id,retell_agent_id,retell_llm_id')
    if (assignments.error) throw new Error('Could not verify isolated agent configuration.')
    const assigned = (assignments.data ?? []).filter(row => row.retell_agent_id === agentId)
    if (assigned.length !== 1) throw new Error('A dedicated customer agent is required before synchronization.')
    const get = async (id: string) => {
      const response = await fetch('https://api.retellai.com/get-agent/' + encodeURIComponent(id), {
        headers: { Authorization: 'Bearer ' + getRetellApiKey() }, signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('Could not verify provider agent isolation.')
      const agent = await response.json()
      if (agent.agent_id !== id) throw new Error('Provider returned a different agent.')
      return agent
    }
    const current = await get(agentId)
    const llmId = current.response_engine?.llm_id
    if (!llmId) throw new Error('Could not verify a dedicated Retell LLM.')
    const record = async (id: string, llm: string) => {
      const saved = await db.rpc('register_recepta_agent_llm', { p_agent_id: id, p_llm_id: llm })
      if (saved.error) throw new Error('Provider LLM ownership conflicts with another customer. No agent configuration was changed.')
    }
    await record(agentId, llmId)
    for (const other of assignments.data ?? []) {
      if (!other.retell_agent_id || other.client_id === assigned[0].client_id) continue
      if (other.retell_llm_id === llmId) throw new Error('Two customers share the same provider LLM. Separate them before synchronization.')
      if (other.retell_llm_id) continue
      const remote = await get(other.retell_agent_id)
      if (remote.response_engine?.llm_id === llmId) throw new Error('Two customers share the same provider LLM. Their configuration must be separated before synchronization.')
      if (!remote.response_engine?.llm_id) throw new Error('Could not verify a legacy provider LLM assignment.')
      await record(other.retell_agent_id, remote.response_engine.llm_id)
    }
    return await run()
  }
  finally { await db.from('retell_agent_sync_locks').delete().eq('agent_id', agentId).eq('token', token) }
}
