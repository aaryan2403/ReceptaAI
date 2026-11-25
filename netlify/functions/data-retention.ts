import { createClient } from '@supabase/supabase-js'
import { isRecordingSid, twilioVoiceRequest } from '../lib/inboundVoice'
import { voiceDeployment } from '../lib/voiceEnvironment'

export const config={ schedule:'17 * * * *' }
export default async (request: Request) => {
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Retention job configuration is missing.')
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  const result=await db.rpc('queue_recepta_retention')
  if (result.error) throw result.error
  const deployment = voiceDeployment(request)
  if (deployment) {
    const due = await db.from('inbound_voicemails').select('recording_sid').eq('account_sid', deployment.account)
      .or(`callback_id.is.null,expires_at.lte.${new Date().toISOString()}`).order('expires_at').limit(20)
    if (due.error) throw due.error
    const removed = await Promise.allSettled(due.data.map(async ({ recording_sid }) => {
      if (!isRecordingSid(recording_sid)) throw new Error('Invalid voicemail recording ID.')
      const deleted = await twilioVoiceRequest(deployment, `Recordings/${recording_sid}.json`, { method: 'DELETE' })
      if (!deleted.ok && deleted.status !== 404) throw new Error('Could not delete expired voicemail.')
      const result = await db.from('inbound_voicemails').delete()
        .eq('recording_sid', recording_sid).eq('account_sid', deployment.account)
      if (result.error) throw result.error
    }))
    if (removed.some(result => result.status === 'rejected')) throw new Error('Some voicemail removals will be retried.')
  }
  return new Response(null,{ status:204 })
}
