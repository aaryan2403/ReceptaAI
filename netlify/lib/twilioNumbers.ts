import type { SupabaseClient } from '@supabase/supabase-js'
import { checked, PhoneError } from './phoneSetup'
import { normalizePhone } from './phoneValidation'
import { getRetellApiKey } from './retellEnvironment'
import { stripeTestModeRequired } from './stripeEnvironment'
import { assertRetellPhoneAgent } from './phoneReception'

export const selectedNumbersConfigured = () => process.env.RECEPTA_TWILIO_NUMBERS_ENABLED === 'true' &&
  /^AC[\da-f]{32}$/i.test(process.env.TWILIO_ACCOUNT_SID ?? '') && Boolean(process.env.TWILIO_AUTH_TOKEN) &&
  /^TK[\da-f]{32}$/i.test(process.env.TWILIO_TRUNK_SID ?? '') &&
  /^[a-z\d-]+\.pstn\.twilio\.com$/i.test(process.env.TWILIO_TERMINATION_URI ?? '') &&
  Boolean(process.env.TWILIO_TRUNK_USERNAME && process.env.TWILIO_TRUNK_PASSWORD && getRetellApiKey())

const twilioRequest = async (path: string, fields?: Record<string, string>) => {
  if (!selectedNumbersConfigured()) throw new PhoneError(503, 'Selected-number provisioning is awaiting its dedicated Twilio SIP trunk configuration.')
  const response = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + path, {
    method: fields ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
      ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(fields ? { body: new URLSearchParams(fields).toString() } : {}),
  })
  if (!response.ok) throw new PhoneError(502, 'The number provider could not complete this request. No different number will be substituted automatically.')
  return await response.json()
}

export const searchTwilioNumbers = async (country: string, areaCode = '', exact?: string) => {
  if (!['CA', 'US'].includes(country) || (areaCode && !/^[2-9]\d{2}$/.test(areaCode))) {
    throw new PhoneError(400, 'Choose Canada or the United States and a valid three-digit area code.')
  }
  const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '10' })
  if (areaCode) query.set('AreaCode', areaCode)
  if (exact) query.set('Contains', exact.replace(/\D/g, ''))
  const result = await twilioRequest('/AvailablePhoneNumbers/' + country + '/Local.json?' + query)
  return (result.available_phone_numbers ?? []).filter((row: { phone_number?: string; capabilities?: { voice?: boolean } }) =>
    typeof row.phone_number === 'string' && row.capabilities?.voice === true)
    .map((row: { phone_number: string; locality?: string; region?: string }) => ({
      number: row.phone_number, locality: row.locality ?? '', region: row.region ?? '',
    })) as Array<{ number: string; locality: string; region: string }>
}

// Only the signed, verified live-payment handler calls this function. The
// caller holds the customer lock and records purchase intent before entering.
export const provisionSelectedTwilioNumber = async (
  db: SupabaseClient, clientId: string, agentId: string, selected: string,
  journal: { pending_number?: string | null; twilio_number_sid?: string | null; number_import_state?: string } | null
) => {
  if (stripeTestModeRequired()) throw new PhoneError(403, 'Number purchases are disabled in staging.')
  if (!selectedNumbersConfigured() || normalizePhone(selected) !== selected) throw new PhoneError(400, 'Selected-number provisioning is unavailable.')
  if (journal?.pending_number && journal.pending_number !== selected) throw new PhoneError(409, 'A different purchase is awaiting reconciliation.')
  let numberSid = journal?.twilio_number_sid
  if (!numberSid) {
    const purchased = await twilioRequest('/IncomingPhoneNumbers.json', {
      PhoneNumber: selected, TrunkSid: process.env.TWILIO_TRUNK_SID!, FriendlyName: 'Recepta ' + clientId,
    })
    if (!/^PN[\da-f]{32}$/i.test(purchased.sid ?? '') || purchased.phone_number !== selected ||
      purchased.account_sid !== process.env.TWILIO_ACCOUNT_SID || purchased.trunk_sid !== process.env.TWILIO_TRUNK_SID) {
      throw new PhoneError(502, 'The provider purchase could not be confirmed. The purchase journal requires review.')
    }
    numberSid = purchased.sid
    checked(await db.from('phone_provisioning').update({ twilio_number_sid: numberSid, pending_number: selected,
      number_state: 'received' }).eq('client_id', clientId))
  } else {
    const owned = await twilioRequest('/IncomingPhoneNumbers/' + encodeURIComponent(numberSid) + '.json')
    if (owned.phone_number !== selected || owned.account_sid !== process.env.TWILIO_ACCOUNT_SID ||
      owned.trunk_sid !== process.env.TWILIO_TRUNK_SID) throw new PhoneError(409, 'The selected number no longer matches its recorded provider ownership.')
  }
  const apiKey = getRetellApiKey()!
  const lookup = await fetch('https://api.retellai.com/get-phone-number/' + encodeURIComponent(selected), {
    headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(10000),
  })
  const expectedHook = new URL('/.netlify/functions/retell-inbound', process.env.RECEPTA_APP_URL || process.env.URL || 'https://recepta.ca').toString()
  if (lookup.ok) {
    const phone = await lookup.json()
    if (phone.phone_number !== selected || phone.sip_outbound_trunk_config?.termination_uri !== process.env.TWILIO_TERMINATION_URI ||
      phone.inbound_webhook_url !== expectedHook) throw new PhoneError(409, 'The existing provider number requires routing review.')
    assertRetellPhoneAgent(phone, agentId)
  } else {
    if (lookup.status !== 404) throw new PhoneError(502, 'Could not confirm the Retell import.')
    if (journal?.number_import_state === 'pending') throw new PhoneError(409, 'The Retell import has an uncertain outcome and requires review.')
    checked(await db.from('phone_provisioning').update({ number_import_state: 'pending' }).eq('client_id', clientId))
    const response = await fetch('https://api.retellai.com/import-phone-number', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: selected, termination_uri: process.env.TWILIO_TERMINATION_URI,
        sip_trunk_auth_username: process.env.TWILIO_TRUNK_USERNAME, sip_trunk_auth_password: process.env.TWILIO_TRUNK_PASSWORD,
        transport: 'TCP', inbound_agents: null,
        outbound_agents: [{ agent_id: agentId, agent_version: 'latest_published', weight: 1 }],
        inbound_webhook_url: expectedHook, nickname: 'Recepta ' + clientId,
      }),
    })
    if (!response.ok || (await response.json()).phone_number !== selected) throw new PhoneError(502, 'The number is preserved at Twilio. Retell connection needs review before another purchase.')
  }
  checked(await db.from('phone_provisioning').update({ number_import_state: 'ready', number_state: 'received' }).eq('client_id', clientId))
  return selected
}
