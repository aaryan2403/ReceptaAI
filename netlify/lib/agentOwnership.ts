import type { SupabaseClient } from '@supabase/supabase-js'

// Every customer needs a dedicated provider agent. Run before provider requests
// or account changes; the staged unique index also closes assignment races.
export const assertAgentAssignable = async (db: SupabaseClient, agentId: string, clientId?: string) => {
  const { data, error } = await db.from('agents').select('client_id').eq('retell_agent_id', agentId)
  if (error) throw new Error('Could not verify the agent assignment. No agent settings were changed.')
  if ((data ?? []).some(row => row.client_id !== clientId)) {
    throw new Error('This Retell agent is already assigned to another Recepta customer. Each customer needs their own agent.')
  }
}
