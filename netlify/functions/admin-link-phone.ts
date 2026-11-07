import { getRetellApiKey } from '../lib/retellEnvironment'
import { requestAuth, json } from '../lib/requestAuth'
import { checked, PhoneError, requirePhoneFeature, rateLimit, withPhoneLock } from '../lib/phoneSetup'
import { normalizePhone } from '../lib/phoneValidation'
import { verifyReceptionResources } from '../lib/phoneReception'
import { syncRetellPhoneBindings } from '../lib/retell'

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    requirePhoneFeature()
    const raw = await request.json()
    if (!raw || !/^[0-9a-f-]{36}$/i.test(raw.clientId ?? '') || !/^agent_[a-z0-9]+$/i.test(raw.agentId ?? '') || raw.ownershipConfirmed !== true) {
      return json(400, { error: 'Select the owner account, enter its existing agent and number, and confirm ownership.' })
    }
    const { db } = auth
    const phone = normalizePhone(raw.phoneNumber)
    if (!phone || !getRetellApiKey()) throw new PhoneError(503, 'A valid number and Retell connection are required.')
    const owner = checked(await db.from('clients').select('contact_email,deletion_pending').eq('id', raw.clientId).maybeSingle())
    const user = await db.auth.admin.getUserById(raw.clientId)
    if (!owner || owner.deletion_pending || user.error || !user.data.user?.email || !user.data.user.email_confirmed_at ||
      owner.contact_email?.toLowerCase() !== user.data.user.email.toLowerCase() ||
      String(raw.ownerEmail).trim().toLowerCase() !== user.data.user.email.toLowerCase()) {
      throw new PhoneError(409, 'The entered owner email must match both the selected Recepta account and its verified login.')
    }
    await rateLimit(db, 'admin-link:' + auth.user.id, 10, 60)
    return await withPhoneLock(db, raw.clientId, async () => {
      // Read the provider BEFORE any assignment write. No purchases, agent
      // creation, subscription activation, or guesses about account ownership.
      await verifyReceptionResources(getRetellApiKey()!, raw.agentId, [phone])
      checked(await db.rpc('link_recepta_phone_pair', { p_client_id: raw.clientId, p_agent_id: raw.agentId, p_phone: phone }),
        'Could not link these resources. They may already belong to another account or conflict with its setup.')
      // Immediately remove any direct binding that could bypass paid admission.
      const results = await syncRetellPhoneBindings({ apiKey: getRetellApiKey()!, agentId: raw.agentId, phoneNumbers: [phone], active: false })
      if (results.some(result => !result.updated)) throw new PhoneError(502, 'Assignment saved, but number routing needs a retry. Service has not been activated.')
      return json(200, { success: true, message: 'Existing number and agent linked to the verified account. Billing and normal activation checks still apply. Reload the client before editing further.' })
    })
  } catch (error) {
    return json(error instanceof PhoneError ? error.status : 502, { error: error instanceof Error ? error.message : 'Could not verify the phone assignment.' })
  }
}
