// Previews may inherit project-wide production variables. Never let those keys
// reach Stripe from a test deployment, including background cleanup jobs.
export const stripeTestModeRequired = () =>
  process.env.RECEPTA_REQUIRE_STRIPE_TEST_MODE === 'true' ||
  Boolean(process.env.CONTEXT && process.env.CONTEXT !== 'production')

export const stripeSecretKey = () => {
  const staging = stripeTestModeRequired()
  const key = (staging ? process.env.STRIPE_STAGING_SECRET_KEY : process.env.STRIPE_SECRET_KEY)?.trim()
  if (!key || (staging && !/^[sr]k_test_.+/.test(key))) return undefined
  return key
}
