import { stripeTestModeRequired } from './stripeEnvironment'

// Preview deployments can inherit site-wide secrets. Require an explicit
// staging workspace key so preview routes cannot accidentally change live assets.
export const getRetellApiKey = () =>
  (stripeTestModeRequired() ? process.env.RETELL_STAGING_API_KEY : process.env.RETELL_API_KEY)?.trim() || undefined
