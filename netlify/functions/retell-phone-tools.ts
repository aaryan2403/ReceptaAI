import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { verifyRetellSignature } from '../lib/retell'
import { normalizePhone } from '../lib/phoneValidation'
import { checked, loadPhoneAccount, PhoneError, rateLimit, requireDedicatedAgent, requirePhoneFeature } from '../lib/phoneSetup'
import { json } from '../lib/requestAuth'

const text = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : ''
export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  try {
    requirePhoneFeature()
    const key = process.env.RETELL_API_KEY, url = process.env.SUPABASE_URL, secret = process.env.SUPABASE_SECRET_KEY
    if (!key || !url || !secret) throw new PhoneError(503, 'Phone tools are unavailable.')
    const body = await request.text()
    if (body.length > 160000) throw new PhoneError(413, 'Request too large.')
    if (!verifyRetellSignature(body, request.headers.get('x-retell-signature'), key)) throw new PhoneError(401, 'Invalid Retell signature.')
    let payload
    try { payload = JSON.parse(body) } catch { throw new PhoneError(400, 'Invalid request.') }
    if (!['recepta_confirm_reception', 'recepta_save_callback'].includes(payload?.name)) throw new PhoneError(400, 'Unknown phone function.')
    const callId = text(payload.call?.call_id, 160)
    if (!/^[-\w]{1,160}$/.test(callId)) throw new PhoneError(400, 'A real call ID is required.')
    const db = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } })
    await rateLimit(db, 'phone-tool:' + callId, 12, 600)
    // Resolve canonical call and account; model arguments and metadata cannot
    // select a different customer, agent, inbound line, or call direction.
    const response = await fetch('https://api.retellai.com/v2/get-call/' + encodeURIComponent(callId), {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new PhoneError(503, 'Could not verify this call.')
    const call = await response.json()
    if (call.call_id !== callId || call.call_type !== 'phone_call' || call.direction !== 'inbound'
      || call.call_status !== 'ongoing' || !call.metadata?.recepta_reservation_id) throw new PhoneError(409, 'This is not an admitted incoming phone call.')
    const owner = checked(await db.from('agents').select('client_id').eq('retell_agent_id', call.agent_id).maybeSingle())
    if (!owner?.client_id) throw new PhoneError(409, 'Agent is not assigned.')
    const account = await loadPhoneAccount(db, owner.client_id)
    await requireDedicatedAgent(db, owner.client_id, call.agent_id)
    if (!account.paid || !account.numbers.includes(call.to_number)) throw new PhoneError(403, 'This incoming line is unavailable.')
    const args = payload.args ?? {}
    if (payload.name === 'recepta_confirm_reception') {
      const code = text(args.code, 20)
      if (!/^\d{6}$/.test(code) || !Number.isFinite(call.start_timestamp)) throw new PhoneError(400, 'Ask for the six-digit reception test code.')
      await rateLimit(db, 'reception-code:' + owner.client_id, 12, 600)
      const confirmed = checked(await db.rpc('confirm_recepta_reception_test', { p_client_id: owner.client_id,
        p_hash: createHash('sha256').update(code).digest('hex'), p_call_id: callId, p_started_at: new Date(call.start_timestamp).toISOString() }))
      if (!confirmed) throw new PhoneError(409, 'The reception test code expired, was incorrect, or setup changed. Start a new test in the dashboard.')
      return json(200, { success: true, instruction: 'The AI answered this incoming test call and reception was confirmed. The owner must still check that they dialed their original business number to test carrier forwarding.' })
    }
    const name = text(args.caller_name, 160), reason = text(args.reason, 2000), preferred = text(args.preferred_callback_time, 200)
    const phone = normalizePhone(args.callback_number || call.from_number)
    if (!name || !reason || !preferred || !phone) throw new PhoneError(400, 'Collect the name, callback number, reason, and preferred callback time first.')
    checked(await db.rpc('capture_recepta_human_callback', { p_client_id: owner.client_id, p_call_id: callId,
      p_from: phone, p_to: call.to_number, p_name: name, p_reason: reason, p_preferred: preferred }))
    return json(200, { success: true, instruction: 'The callback request was saved for the business. Do not promise a callback time or claim a human transfer succeeded.' })
  } catch (error) {
    return json(error instanceof PhoneError ? error.status : 503, { error: error instanceof PhoneError ? error.message : 'Could not save phone-call details. Do not claim they were saved.' })
  }
}
