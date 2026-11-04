import { verifyReceptionResources } from '../lib/phoneReception'
import { syncRetellPhoneBindings } from '../lib/retell'
import { requestAuth, json } from '../lib/requestAuth'
import { normalizePhone, PhoneValidationError } from '../lib/phoneValidation'
import { syncHumanCallTransfer } from '../lib/callTransfer'
import { PhoneError, checked, requirePhoneFeature, rateLimit, withPhoneLock, loadPhoneAccount, requireDedicatedAgent,
  assertDirectDestination, assertBusinessVerificationTarget, isVerifiedNumber, verifyRequest, verificationConfigured } from '../lib/phoneSetup'

const carriers = new Set(['rogers', 'bell', 'telus', 'other'])
export default async (request: Request) => {
  if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    requirePhoneFeature()
    const { db, user } = auth
    if (request.method === 'GET') {
      const account = await loadPhoneAccount(db, user.id)
      return json(200, { ...account, verificationAvailable: verificationConfigured() })
    }
    const text = await request.text()
    if (text.length > 4096) return json(413, { error: 'Request too large.' })
    let raw: Record<string, unknown>
    try { raw = JSON.parse(text); if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error() }
    catch { return json(400, { error: 'Invalid request body.' }) }
    // Never accept a client ID, agent ID, verification result, or sync state from customers.
    if ('clientId' in raw || 'agentId' in raw) return json(400, { error: 'Phone setup uses your signed-in account only.' })
    await rateLimit(db, 'phone-mutations:' + user.id, 30, 60)
    return await withPhoneLock(db, user.id, async () => {
      const account = await loadPhoneAccount(db, user.id)
      const action = raw.action
      if (action === 'disable') {
        checked(await db.rpc('disable_recepta_phone_transfer', { p_client_id: user.id }))
        return json(200, { success: true, message: 'Human transfers disabled for new calls. Calls already in progress keep their original settings.' })
      }
      if (action === 'check-connection') {
        if (!process.env.RETELL_API_KEY) throw new PhoneError(503, 'Retell is not connected.')
        const id = await requireDedicatedAgent(db, user.id, account.agent?.retell_agent_id)
        const result = await verifyReceptionResources(process.env.RETELL_API_KEY, id, account.numbers)
        return json(200, { success: true, ...result, message: result.routingReady
          ? 'Assigned number routing is configured. A real call is still required to verify reception and carrier forwarding.'
          : 'Number routing needs setup. With active billing, save and sync, then repeat the call test.' })
      }
      if (action === 'send-code' || action === 'verify-code') {
        if (!account.paid) throw new PhoneError(403, 'An active paid subscription is required for phone verification.')
        const purpose = raw.purpose
        if (!['business', 'worker'].includes(String(purpose))) throw new PhoneError(400, 'Choose a business or worker number.')
        const phone = normalizePhone(raw.phoneNumber)
        if (!phone) throw new PhoneError(400, 'Enter the phone number to verify.')
        if (purpose === 'business') await assertBusinessVerificationTarget(db, user.id, phone)
        else await assertDirectDestination(db, phone)
        if (action === 'send-code') {
          if (raw.authorized !== true) throw new PhoneError(400, 'Confirm you are authorized to verify this number.')
          if (raw.channel !== 'sms' && raw.channel !== 'call') throw new PhoneError(400, 'Choose text message or voice call.')
          await rateLimit(db, 'send-cooldown:' + user.id, 1, 60)
          await rateLimit(db, 'send-account:' + user.id, 5, 3600)
          await rateLimit(db, 'send-target:' + phone, 5, 3600)
          await rateLimit(db, 'send-global', 100, 3600)
          const result = await verifyRequest('Verifications', { To: phone, Channel: String(raw.channel) })
          if (!result.sid || result.status !== 'pending') throw new PhoneError(502, 'Verification could not be started.')
          checked(await db.from('phone_verified_numbers').upsert({ client_id: user.id, purpose, phone_number: phone,
            provider_sid: result.sid, expires_at: new Date(Date.now() + 10 * 60000).toISOString() }, { onConflict: 'client_id,purpose,phone_number' }))
          return json(200, { success: true, message: 'Code requested. It expires in 10 minutes. Wait at least a minute before requesting another.' })
        }
        if (typeof raw.code !== 'string' || !/^\d{4,10}$/.test(raw.code)) throw new PhoneError(400, 'Enter the verification code.')
        const challenge = checked(await db.from('phone_verified_numbers').select('provider_sid,expires_at').eq('client_id', user.id)
          .eq('purpose', purpose).eq('phone_number', phone).maybeSingle())
        if (!challenge?.provider_sid || Date.parse(challenge.expires_at ?? '') <= Date.now()) throw new PhoneError(400, 'Request a new verification code.')
        await rateLimit(db, 'check:' + user.id + ':' + challenge.provider_sid, 5, 600)
        const result = await verifyRequest('VerificationCheck', { VerificationSid: challenge.provider_sid, Code: raw.code })
        if (result.status !== 'approved' || result.valid !== true) throw new PhoneError(400, 'Incorrect verification code.')
        checked(await db.from('phone_verified_numbers').update({ verified_at: new Date().toISOString(), provider_sid: null, expires_at: null })
          .eq('client_id', user.id).eq('purpose', purpose).eq('phone_number', phone))
        return json(200, { success: true, message: 'Number verified. You can now save your setup.' })
      }
      if (action === 'confirm-test') {
        if (!account.paid || !account.agent?.retell_agent_id || !account.numbers.length || account.settings?.sync_state !== 'synced') throw new PhoneError(409, 'Save and sync an active phone setup before testing.')
        if (raw.expectedRevision !== account.settings.revision) throw new PhoneError(409, 'Setup changed. Reload before confirming a test.')
        if (raw.confirmed !== true) throw new PhoneError(400, 'Confirm you completed a real call test.')
        if (raw.kind !== 'reception' && raw.kind !== 'transfer') throw new PhoneError(400, 'Choose the completed test.')
        if (raw.kind === 'transfer' && !account.destination?.enabled) throw new PhoneError(400, 'Enable transfers before testing a handoff.')
        checked(await db.from('phone_setups').update(raw.kind === 'transfer' ? { transfer_tested_at: new Date().toISOString() } : {
          reception_tested_at: new Date().toISOString(), forwarding_confirmed_at: account.settings.mode === 'existing' ? new Date().toISOString() : null,
        }).eq('client_id', user.id).eq('revision', account.settings.revision))
        return json(200, { success: true, message: 'Your test confirmation was saved. Carrier activation is still managed by your carrier.' })
      }
      if (action !== 'save' && action !== 'disable') throw new PhoneError(400, 'Unknown phone setup action.')
      const enabled = action === 'save' && raw.transferEnabled === true
      if (action === 'save' && !account.paid) throw new PhoneError(403, 'Complete payment in Billing before configuring phone service. You can still disable transfers.')
      const agentId = await requireDedicatedAgent(db, user.id, account.agent?.retell_agent_id)
      const apiKey = process.env.RETELL_API_KEY
      if (!apiKey) throw new PhoneError(503, 'Retell synchronization is not configured.')
      if (enabled && !account.numbers.length) throw new PhoneError(409, 'An assigned Recepta number is required before enabling transfers.')
      const mode = action === 'disable' ? account.settings?.mode ?? 'new' : raw.mode
      const business = action === 'disable' ? account.settings?.business_number ?? null : mode === 'existing' ? normalizePhone(raw.businessNumber) : null
      const worker = action === 'disable' ? account.destination?.phone_number ?? null : normalizePhone(raw.workerNumber)
      if (mode !== 'new' && mode !== 'existing') throw new PhoneError(400, 'Choose how to connect your business.')
      if (mode === 'existing' && (!business || !isVerifiedNumber(account.verifiedNumbers, 'business', business))) throw new PhoneError(400, 'Verify your existing business number first.')
      if (enabled) {
        if (!worker || !isVerifiedNumber(account.verifiedNumbers, 'worker', worker)) throw new PhoneError(400, 'Verify the worker number before enabling transfers.')
        if (raw.directLineAuthorized !== true) throw new PhoneError(400, 'Confirm the worker authorized this direct line and it does not forward to Recepta.')
        await assertDirectDestination(db, worker, business)
      }
      const carrier = action === 'disable' ? account.settings?.carrier ?? 'other' : String(raw.carrier)
      const lineType = action === 'disable' ? account.settings?.line_type ?? 'mobile' : raw.lineType
      if (!carriers.has(carrier) || !['mobile', 'landline', 'voip'].includes(String(lineType))) throw new PhoneError(400, 'Choose a valid carrier and line type.')
      if (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision !== (account.settings?.revision ?? 0)) throw new PhoneError(409, 'Settings changed. Reload before saving.')
      const saved = await db.rpc('save_recepta_phone_setup', { p_client_id: user.id, p_expected_revision: raw.expectedRevision,
        p_settings: { mode, business_number: business, worker_number: worker, enabled, carrier, line_type: lineType, agent_id: agentId } })
      if (saved.error) throw new PhoneError(409, 'Could not save. Recheck verified numbers, direct-line safety, and reload if another tab changed your settings.')
      const revision = saved.data
      // Desired state is durable before external publication. Inbound transfers
      // are disabled during pending/error states, including DB failures after publish.
      try {
        await verifyReceptionResources(apiKey, agentId, account.numbers)
        const bindings = await syncRetellPhoneBindings({ apiKey, agentId, phoneNumbers: account.numbers, active: account.paid })
        if (bindings.some(result => !result.updated)) throw new Error('A number is disconnected.')
        await syncHumanCallTransfer({ apiKey, agentId, destination: enabled ? worker : null })
        const finished = checked(await db.from('phone_setups').update({ sync_state: 'synced' }).eq('client_id', user.id).eq('revision', revision).select('revision').maybeSingle())
        if (!finished) throw new Error('A newer update superseded this synchronization.')
      } catch {
        await db.from('phone_setups').update({ sync_state: 'error' }).eq('client_id', user.id).eq('revision', revision)
        throw new PhoneError(502, 'Settings saved, but agent sync failed. Transfers are unavailable for new calls until you save and sync successfully.')
      }
      return json(200, { success: true, message: enabled ? 'Warm transfer synced. Complete the real call tests below before relying on it.' : 'Phone setup synced. Human transfers are disabled.' })
    })
  } catch (error) {
    return json(error instanceof PhoneError ? error.status : error instanceof PhoneValidationError ? 400 : 503, {
      error: error instanceof PhoneError || error instanceof PhoneValidationError ? error.message : 'Phone setup is temporarily unavailable. Try again shortly.',
    })
  }
}
