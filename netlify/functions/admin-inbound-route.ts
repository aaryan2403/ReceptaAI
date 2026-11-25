import { json, requestAuth } from '../lib/requestAuth'
import { inspectRetellPhoneRoute, receptaRetellOrigin } from '../lib/retell'
import { isUuid, readHumanNumber, readVoiceNumber, twilioVoiceRequest, voicePath } from '../lib/inboundVoice'
import { allowsVoiceNumber, voiceDeployment, voiceNumberKind, type VoiceDeployment } from '../lib/voiceEnvironment'

type OwnedNumber = {
  sid: string
  account_sid: string
  phone_number: string
  trunk_sid?: string | null
  voice_application_sid?: string | null
  voice_url?: string | null
  voice_method?: string | null
  voice_fallback_url?: string | null
  capabilities?: { voice?: boolean }
}

const findOwnedNumber = async (deployment: VoiceDeployment, number: string): Promise<OwnedNumber | null> => {
  const query = new URLSearchParams({ PhoneNumber: number })
  const response = await twilioVoiceRequest(deployment, 'IncomingPhoneNumbers.json?' + query)
  if (!response.ok) throw new Error('Could not verify the existing Twilio number.')
  const result = await response.json() as { incoming_phone_numbers: OwnedNumber[] }
  return result.incoming_phone_numbers.find(phone => phone.phone_number === number &&
    phone.account_sid === deployment.account && /^PN[0-9a-f]{32}$/i.test(phone.sid) &&
    phone.capabilities?.voice === true) ?? null
}

export default async (request: Request) => {
  if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const { db } = auth
    const deployment = voiceDeployment(request)
    const clientId = new URL(request.url).searchParams.get('clientId')
    if (!isUuid(clientId)) return json(400, { error: 'Choose a valid client.' })
    if (!deployment?.retellKey) {
      return request.method === 'GET' ? json(200, { available: false }) :
        json(503, { error: 'Programmable Voice is awaiting configuration in this deployment.' })
    }

    const client = await db.from('clients').select('deletion_pending').eq('id', clientId).maybeSingle()
    if (client.error) throw client.error
    if (!client.data || client.data.deletion_pending) return json(404, { error: 'Client unavailable.' })

    const fields = 'ingress_number, ai_number, human_number, business_number'
    if (request.method === 'GET') {
      const routes = await db.from('inbound_phone_routes').select(fields).eq('client_id', clientId).order('ingress_number')
      if (routes.error) throw routes.error
      return json(200, { available: true, routes: routes.data })
    }

    let body
    try { body = await request.json() } catch { return json(400, { error: 'Enter valid routing settings.' }) }
    const ingress = readVoiceNumber(body?.ingress_number)
    const ai = readVoiceNumber(body?.ai_number)
    const human = readHumanNumber(body?.human_number)
    const businessInput = typeof body?.business_number === 'string' ? body.business_number.trim() : ''
    const business = readVoiceNumber(businessInput)
    if (!ingress || !ai || !human || (businessInput && !business)) {
      return json(400, { error: 'Enter valid phone numbers and a direct US or Canadian human number.' })
    }
    if (new Set([ingress, ai, human, ...(business ? [business] : [])]).size !== (business ? 4 : 3)) {
      return json(400, { error: 'Use separate numbers for Twilio, Retell, the original business line and the human destination.' })
    }
    if (!allowsVoiceNumber(deployment, ingress)) return json(409, { error: 'This Twilio number is outside the staging allowlist.' })

    const [existing, agent, assigned, ingressKind, humanKind, businessKind] = await Promise.all([
      db.from('inbound_phone_routes').select('client_id').eq('ingress_number', ingress).maybeSingle(),
      db.from('agents').select('phone_number, retell_agent_id').eq('client_id', clientId).maybeSingle(),
      db.from('agent_phone_numbers').select('client_id').eq('phone_number', ai).maybeSingle(),
      voiceNumberKind(db, ingress),
      voiceNumberKind(db, human),
      business ? voiceNumberKind(db, business) : null,
    ])
    if (existing.error || agent.error || assigned.error) throw new Error('Could not verify number assignments.')
    if ((existing.data && existing.data.client_id !== clientId) || ['ai', 'business'].includes(ingressKind ?? '') ||
        humanKind || (businessKind && businessKind !== 'business')) {
      return json(409, { error: 'A number is already used for routing or forwarding. Use a direct human line that does not forward to Recepta.' })
    }
    if (!agent.data?.retell_agent_id || (assigned.data?.client_id !== clientId &&
        (assigned.data || agent.data.phone_number !== ai))) {
      return json(409, { error: 'Select an existing Retell number assigned to this client’s agent.' })
    }

    const origin = deployment.previewOrigin ?? receptaRetellOrigin(false)
    if (deployment.preview && origin !== new URL(request.url).origin) {
      return json(409, { error: 'Open the configured Netlify preview to connect staging routing.' })
    }
    const webhook = new URL(voicePath, origin).toString()
    const [number, retellIssue] = await Promise.all([
      findOwnedNumber(deployment, ingress),
      inspectRetellPhoneRoute(deployment.retellKey, ai, origin),
    ])
    if (retellIssue) return json(409, { error: retellIssue })
    if (!number || number.trunk_sid || number.voice_application_sid || number.voice_fallback_url ||
        (number.voice_url && number.voice_url !== webhook && !/^https:\/\/demo\.twilio\.com\/welcome\/voice\/?$/.test(number.voice_url))) {
      return json(409, { error: 'Use an existing voice-capable Twilio number with no other app, trunk or custom voice webhook.' })
    }

    const route = { ingress_number: ingress, ai_number: ai, human_number: human, business_number: business }
    const saved = existing.data
      ? await db.from('inbound_phone_routes').update(route).eq('ingress_number', ingress).eq('client_id', clientId).select(fields).maybeSingle()
      : await db.from('inbound_phone_routes').insert({ ...route, client_id: clientId }).select(fields).single()
    if (saved.error || !saved.data) return json(409, { error: 'The number assignment changed. Reload and try again.' })

    if (number.voice_url !== webhook || number.voice_method !== 'POST') {
      // Save the route before attaching the webhook. A provider timeout may mean
      // Twilio committed the update, so keep the route and make saves retryable.
      try {
        const attached = await twilioVoiceRequest(deployment, `IncomingPhoneNumbers/${number.sid}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ VoiceUrl: webhook, VoiceMethod: 'POST' }),
        })
        if (!attached.ok) throw new Error('Provider refused the update.')
        const updated = await attached.json() as OwnedNumber
        if (updated.phone_number !== ingress || updated.account_sid !== deployment.account ||
            updated.voice_url !== webhook || updated.voice_method !== 'POST') throw new Error('Provider did not confirm the webhook.')
      } catch {
        return json(502, { error: 'Routes were saved. Twilio has yet to confirm the webhook. Save the same number again to retry.' })
      }
    }
    return json(200, { route: saved.data })
  } catch {
    return json(503, { error: 'Could not verify or save inbound routing.' })
  }
}
