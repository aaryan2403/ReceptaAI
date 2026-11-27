import { createClient } from '@supabase/supabase-js'
import { repairAppointmentAgent } from '../lib/appointmentAgentSetup'
import { loadServiceAccess, serviceDeployment } from '../lib/serviceAccess'

export const config = { schedule: '*/5 * * * *' }

export default async (request: Request) => {
  const deployment = serviceDeployment(request)
  if (!deployment.isolated || !deployment.key) return new Response('Isolated Retell deployment required.',{status:503})
  const {SUPABASE_URL,SUPABASE_SECRET_KEY} = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return new Response('Service configuration missing.',{status:503})
  const db = createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
  const candidates = await db.rpc('recepta_caller_management_sync_candidates')
  if (candidates.error) throw candidates.error
  for (const candidate of candidates.data ?? []) {
    const {client_id:clientId,agent_id:agentId} = candidate
    const attempted = await db.from('booking_settings').update({
      caller_management_sync_attempted_at:new Date().toISOString(),
    }).eq('client_id',clientId)
      .or('caller_management_sync_attempted_at.is.null,caller_management_sync_attempted_at.lt.' +
        new Date(Date.now()-15*60_000).toISOString()).select('client_id').maybeSingle()
    if (attempted.error) { console.error('Appointment sync attempt could not be recorded.'); continue }
    if (!attempted.data) continue
    try {
      const access = await loadServiceAccess(db,clientId)
      if (access.plan!=='Recepta Pro' || !access.assignment_valid || access.agent_id!==agentId || access.retention_operation) continue
      await repairAppointmentAgent(db,clientId,deployment,{agentId,plan:'Recepta Pro',expectedPlan:'Recepta Pro',revision:access.revision,ensureCallEvents:false})
      const current = await loadServiceAccess(db,clientId)
      if (current.plan!=='Recepta Pro' || current.agent_id!==agentId) continue
      const saved = await db.from('booking_settings').update({
        caller_management_synced_agent_id:agentId,
      }).eq('client_id',clientId)
      if (saved.error) throw saved.error
    } catch {
      console.error('Managed appointment tools sync failed; eligible agents will retry.')
    }
  }
  return new Response(null,{status:204})
}
