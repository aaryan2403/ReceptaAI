import { requestAuth, json } from '../lib/requestAuth'
import { PhoneError, requirePhoneFeature, rateLimit } from '../lib/phoneSetup'
import { searchTwilioNumbers, selectedNumbersConfigured } from '../lib/twilioNumbers'

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    requirePhoneFeature()
    if (!selectedNumbersConfigured()) return json(503, { error: 'Exact-number selection is awaiting the dedicated Twilio SIP trunk configuration. Country-based assignment remains available in Billing.' })
    await rateLimit(auth.db, 'number-search:' + auth.user.id, 15, 60)
    const query = new URL(request.url).searchParams
    return json(200, { numbers: await searchTwilioNumbers(query.get('country') ?? 'CA', query.get('areaCode') ?? ''),
      message: 'Availability is checked again at Checkout. Search results are not reservations.' })
  } catch (error) {
    return json(error instanceof PhoneError ? error.status : 503, { error: error instanceof PhoneError ? error.message : 'Number search is temporarily unavailable.' })
  }
}
