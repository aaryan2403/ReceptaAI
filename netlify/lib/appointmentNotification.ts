import type { SupabaseClient } from '@supabase/supabase-js'
import { isEmailAddress } from '../../src/lib/callEmailSettings'
import { formatAppointmentPreference } from '../../src/lib/appointmentRequests'
import { callEmailSender } from './emailEnvironment'

export const loadAppointmentEmail = async (db: SupabaseClient, clientId: string, payload: Record<string, unknown>) => {
  const [appointment, business, settings] = await Promise.all([
    db.from('appointments').select('status, booking_version, booking_email_consent, customer_name, customer_email, customer_phone, appointment_time, appointment_end_time, booking_time_zone, duration_minutes, requested_date, requested_time, requested_timezone')
      .eq('client_id', clientId).eq('id', payload.appointment_id).maybeSingle(),
    db.from('clients').select('company_name, contact_email, deletion_pending').eq('id', clientId).maybeSingle(),
    db.from('booking_settings').select('email_owner, email_customer').eq('client_id', clientId).maybeSingle(),
  ])
  if (appointment.error || business.error || settings.error) throw new Error('Could not load appointment email details.')
  const record = appointment.data
  const client = business.data
  const customer = payload.recipient === 'customer'
  if (!record || !client || client.deletion_pending || record.customer_name === 'Deleted caller' ||
    record.status !== payload.status || record.booking_version !== payload.version ||
    (customer ? !settings.data?.email_customer || !record.booking_email_consent : !settings.data?.email_owner)) return null

  const recipient = customer ? record.customer_email?.trim() : client.contact_email?.trim()
  if (!isEmailAddress(recipient)) return null
  const company = client.company_name || 'the business'
  const ownerAddress = client.contact_email?.trim()
  const pending = record.status === 'pending'
  const state = pending ? 'Awaiting Confirmation' : 'Appointment Confirmed'
  const lines = [
    pending ? 'The business will follow up to confirm the appointment.' : 'The appointment is confirmed.',
    `Customer: ${record.customer_name || 'Caller'}`,
  ]

  if (pending) {
    lines.push(`Requested time: ${formatAppointmentPreference(record)}`)
  } else {
    const timeZone = record.booking_time_zone || 'UTC'
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'full', timeStyle: 'short' })
    lines.push(
      `Starts: ${format.format(new Date(record.appointment_time))}`,
      `Ends: ${format.format(new Date(record.appointment_end_time))}`,
      `Timezone: ${timeZone}`, `Duration: ${record.duration_minutes} minutes`,
    )
  }
  if (!customer && record.customer_phone) lines.push(`Phone: ${record.customer_phone}`)
  return {
    from: callEmailSender(), to: [recipient], subject: `${state} | ${company}`,
    text: [state, '', ...lines].join('\n'),
    ...(customer && isEmailAddress(ownerAddress) ? { reply_to: ownerAddress } : {}),
  }
}
