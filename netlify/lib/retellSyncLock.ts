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
  try { return await run() }
  finally { await db.from('retell_agent_sync_locks').delete().eq('agent_id', agentId).eq('token', token) }
}
