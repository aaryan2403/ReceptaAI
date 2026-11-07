import { selectedNumbersConfigured } from '../lib/twilioNumbers'
import { requestAuth, json } from '../lib/requestAuth'
import { getRetellApiKey } from '../lib/retellEnvironment'
import { stripeSecretKey, stripeTestModeRequired } from '../lib/stripeEnvironment'
import { phoneFeatureEnabled, verifyServiceReadiness } from '../lib/phoneSetup'

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    return json(200, {
      staging: stripeTestModeRequired(),
      selectedNumbersConfigured: selectedNumbersConfigured(),
      phoneSetupEnabled: phoneFeatureEnabled(),
      twilioVerify: await verifyServiceReadiness(),
      stagingTargetsConfigured: Boolean(process.env.RECEPTA_STAGING_VERIFY_TARGETS?.trim()),
      retellCredentialPresent: Boolean(getRetellApiKey()),
      stripeCredentialPresent: Boolean(stripeSecretKey()),
      stripeSigningSecretPresent: Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim()),
    })
  } catch {
    return json(503, { error: 'Phone provider readiness is temporarily unavailable.' })
  }
}
