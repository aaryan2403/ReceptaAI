import { createClient } from '@supabase/supabase-js'
import twilio from 'twilio'
import { isCallSid, isRecordingSid, isUuid, usesAiReception } from '../lib/inboundVoice'
import { allowsVoiceNumber, voiceDeployment, voiceNumberKind } from '../lib/voiceEnvironment'

const twiml = (response: InstanceType<typeof twilio.twiml.VoiceResponse>) =>
  new Response(response.toString(), { headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } })

const e164 = (value: string | null) => value && /^\+[1-9][0-9]{7,14}$/.test(value) ? value : null

export default async (request: Request) => {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const deployment = voiceDeployment(request)
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!deployment || !SUPABASE_URL || !SUPABASE_SECRET_KEY) return new Response(null, { status: 503 })
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
    return new Response(null, { status: 415 })
  }

  const fields = new URLSearchParams(await request.text())
  const params = Object.fromEntries(fields)
  if ([...fields.keys()].length !== Object.keys(params).length ||
      !twilio.validateRequest(deployment.token, request.headers.get('X-Twilio-Signature') ?? '', request.url, params) ||
      params.AccountSid !== deployment.account) return new Response(null, { status: 403 })

  const callSid = fields.get('CallSid')
  if (!isCallSid(callSid)) return new Response(null, { status: 400 })

  const version = new URL(request.url)
  const stage = version.searchParams.get('stage')
  const callbackUrl = (callbackStage: string, callbackId?: string) => {
    const url = new URL(version.pathname, version.origin)
    url.searchParams.set('stage', callbackStage)
    if (callbackId) url.searchParams.set('callback', callbackId)
    return url.toString()
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  const response = new twilio.twiml.VoiceResponse()
  const reject = () => {
    response.reject({ reason: 'busy' })
    return twiml(response)
  }
  const hangup = () => {
    response.hangup()
    return twiml(response)
  }

  try {
    if (stage === 'recording') {
      const recording = fields.get('RecordingSid')
      const callbackId = version.searchParams.get('callback')
      if (params.RecordingStatus !== 'completed' || !isRecordingSid(recording) || !isUuid(callbackId)) {
        return new Response(null, { status: 204 })
      }
      const { error } = await db.rpc('recepta_store_inbound_voicemail', {
        p_account: deployment.account, p_recording: recording, p_call: callSid, p_callback: callbackId,
      })
      if (error) throw error
      return new Response(null, { status: 204 })
    }
    if (stage === 'hangup') return hangup()
    if (stage && stage !== 'human') return new Response(null, { status: 400 })

    const ingress = e164(fields.get('To'))
    const caller = e164(fields.get('From'))
    const forwardedFrom = e164(fields.get('ForwardedFrom'))
    if (!ingress || !allowsVoiceNumber(deployment, ingress)) return reject()

    // The human leg presents the ingress number as caller ID. A returned leg
    // is rejected before it can dial again or reach the AI.
    if (!stage && (caller === ingress || forwardedFrom === ingress ||
        (caller && await voiceNumberKind(db, caller) === 'ingress') ||
        (forwardedFrom && await voiceNumberKind(db, forwardedFrom) === 'ingress'))) return reject()

    const { data: route, error } = await db.rpc('recepta_voice_route', { p_ingress: ingress }).maybeSingle<{
      client_id: string; ai_number: string; human_number: string; business_hours: string | null; ai_assigned: boolean | null
    }>()
    if (error) throw error
    if (!route) return reject()

    const voicemail = async () => {
      const id = 'twilio:' + callSid
      const recorded = await db.rpc('record_recepta_callback', {
        p_client_id: route.client_id, p_call_id: id, p_from: caller, p_to: ingress, p_reason: 'outside_answering_hours',
      })
      if (recorded.error) throw recorded.error
      const callback = await db.from('callback_requests').select('id').eq('retell_call_id', id)
        .eq('client_id', route.client_id).maybeSingle()
      if (callback.error) throw callback.error
      if (!callback.data) return hangup()

      response.say('Please leave a message after the tone.')
      response.record({
        action: callbackUrl('hangup'), method: 'POST', maxLength: 90, timeout: 5, playBeep: true,
        recordingStatusCallback: callbackUrl('recording', callback.data.id),
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: ['completed'],
        trim: 'trim-silence',
      })
      return twiml(response)
    }

    if (stage === 'human') {
      return ['no-answer', 'busy', 'failed', 'canceled'].includes(params.DialCallStatus) ? await voicemail() : hangup()
    }

    if (usesAiReception(route.business_hours)) {
      if (!route.ai_assigned || route.ai_number === caller || route.ai_number === forwardedFrom) return reject()
      response.dial({ answerOnBridge: true }, route.ai_number)
      response.hangup()
      return twiml(response)
    }

    if (route.human_number === caller || route.human_number === forwardedFrom ||
        await voiceNumberKind(db, route.human_number)) return await voicemail()

    response.dial({
      callerId: ingress, answerOnBridge: true, timeout: 30, action: callbackUrl('human'), method: 'POST',
    }, route.human_number)
    return twiml(response)
  } catch {
    console.error('Inbound voice routing could not complete.')
    return new Response(null, { status: 503 })
  }
}
