import { isRecordingSid, isUuid, twilioVoiceRequest } from '../lib/inboundVoice'
import { json, requestAuth } from '../lib/requestAuth'
import { voiceDeployment } from '../lib/voiceEnvironment'

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    const deployment = voiceDeployment(request)
    const id = new URL(request.url).searchParams.get('id')
    if (!deployment || !isUuid(id)) return json(404, { error: 'Voicemail unavailable.' })

    const { db, user } = auth
    const callback = await db.from('callback_requests').select('id').eq('id', id).eq('client_id', user.id).maybeSingle()
    if (callback.error) throw callback.error
    if (!callback.data) return json(404, { error: 'Voicemail unavailable.' })

    const { data, error } = await db.from('inbound_voicemails').select('recording_sid')
      .eq('callback_id', id).eq('account_sid', deployment.account)
      .gt('expires_at', new Date().toISOString()).order('expires_at', { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    if (!isRecordingSid(data?.recording_sid ?? null)) return json(404, { error: 'Voicemail unavailable.' })

    const media = await twilioVoiceRequest(deployment, `Recordings/${data!.recording_sid}.mp3`)
    if (media.status === 404) return json(404, { error: 'Voicemail unavailable.' })
    if (!media.ok) throw new Error('Could not load voicemail media.')
    return new Response(media.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' } })
  } catch {
    return json(503, { error: 'Could not load voicemail.' })
  }
}
