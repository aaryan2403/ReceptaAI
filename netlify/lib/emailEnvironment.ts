import { stripeTestModeRequired } from './stripeEnvironment'
import { isEmailAddress } from '../../src/lib/callEmailSettings'

export const callEmailSender = () => process.env.CALL_NOTIFICATION_FROM_EMAIL?.trim()
  || process.env.APPOINTMENT_FROM_EMAIL?.trim() || process.env.REQUEST_NOTIFICATION_FROM_EMAIL?.trim()
  || 'Recepta <notifications@mail.recepta.ca>'
export const configuredEmailApiKey = () => (stripeTestModeRequired() ? process.env.RESEND_STAGING_API_KEY : process.env.RESEND_API_KEY)?.trim()
export const emailApiKey = () => {
  const key = configuredEmailApiKey()
  if (!key) throw new Error(stripeTestModeRequired()
    ? 'Staging email is not configured. Set RESEND_STAGING_API_KEY in Netlify Functions and redeploy.'
    : 'Email is not configured. Set RESEND_API_KEY in Netlify Functions and redeploy.')
  return key
}
export const assertEmailRecipients = (recipients: string[]) => {
  if (!recipients.length || recipients.some(email => !isEmailAddress(email))) throw new Error('Email recipient is missing or invalid.')
  if (stripeTestModeRequired()) {
    const allowed = (process.env.RECEPTA_STAGING_EMAIL_TARGETS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean)
    if (recipients.some(email => !allowed.includes(email.toLowerCase()))) throw new Error('Staging email blocked: recipient is not in RECEPTA_STAGING_EMAIL_TARGETS.')
  }
}
export const emailProviderError = (status: number) => status === 401
  ? 'Resend authentication failed (401). Replace the invalid or expired email API key in Netlify Functions and redeploy.'
  : status === 403 ? 'Resend refused this email (403). Check key permissions, its domain restriction, and that the sender domain is verified.'
  : status === 429 ? 'Resend rate or sending limit reached (429). Email remains queued for retry.'
  : `Resend rejected the email (${status}). Email remains queued for retry.`

export const configuredEmailWebhookSecret = () => (stripeTestModeRequired() ? process.env.RESEND_STAGING_WEBHOOK_SECRET : process.env.RESEND_WEBHOOK_SECRET)?.trim()

export const callEmailPreferencesEnabled = () => process.env.RECEPTA_CALL_EMAIL_ENABLED === 'true'
