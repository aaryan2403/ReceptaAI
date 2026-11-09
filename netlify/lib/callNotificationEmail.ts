import { normalizeCallEmailSettings, customCallFields, isEmailAddress, type CallEmailSettings } from '../../src/lib/callEmailSettings'
import { callEmailSender } from './emailEnvironment'
import { formatAppointmentPreference, isConfirmedAppointment } from '../../src/lib/appointmentRequests'
type PlanName = 'Recepta Standard' | 'Recepta Pro'

type AppointmentDetails = {
  status: string
  requestedDate?: string | null
  requestedTime?: string | null
  requestedTimezone?: string | null
  customerName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  customerCompany?: string | null
  employeeName?: string | null
  service?: string | null
  notes?: string | null
  start?: string | null
  end?: string | null
  durationMinutes?: number | null
  timeZone: string
}

export type CallNotificationDetails = {
  planName: PlanName
  businessName: string
  ownerEmail?: string | null
  callerName?: string | null
  callerNumber?: string | null
  startedAt: string
  durationSeconds: number
  timeZone: string
  outcome?: string | null
  summary?: string | null
  appointment?: AppointmentDetails | null
  recipient?: 'owner' | 'caller'
  callerEmail?: string | null
  callerSummary?: string | null
  settings?: CallEmailSettings
  customDetails?: Array<{ label: string; value: string }>
}

const isEmail = (value?: string | null) =>
  Boolean(
    value &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )

const formatDateTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))

const formatDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(seconds || 0))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60

  return `${minutes}m ${remainder}s`
}
const appointmentNote = (notes?: string | null) => {
  if (!notes) return 'None provided'
  try {
    const parsed = JSON.parse(notes)
    if (parsed?.version === 1 && Array.isArray(parsed.details)) return 'Structured answers are included only in the selected call detail fields.'
  } catch { /* Preserve ordinary appointment notes. */ }
  return notes
}

export type CallEmailPayload = {
  from: string
  to: string[]
  reply_to: string
  subject: string
  text: string
}

export const buildCallNotification = (details: CallNotificationDetails): CallEmailPayload => {
  const caller = details.recipient === 'caller'
  const recipientEmail = caller ? details.callerEmail : details.ownerEmail
  if (!isEmailAddress(recipientEmail)) throw new Error('Recipient email is missing or invalid.')
  const ownerEmail = isEmail(details.ownerEmail) ? details.ownerEmail!.trim() : null
  const settings = normalizeCallEmailSettings(details.settings)
  const fields = caller ? settings.callerFields : settings.ownerFields
  const customFields = customCallFields(settings)
  const customDetails = details.customDetails?.filter(detail => {
    const field = customFields.find(field => field.label.toLowerCase() === detail.label.toLowerCase())
    return field && (caller ? field.caller : field.owner)
  }) ?? []
  const include = (field: keyof typeof import('../../src/lib/callEmailSettings').EMAIL_FIELDS) => fields.includes(field)
  const from = callEmailSender()
  const supportEmail =
    process.env.RECEPTA_SUPPORT_EMAIL?.trim() ||
    'receptahelp02@gmail.com'
  const appointment = details.appointment
  const confirmed = appointment && isConfirmedAppointment({ status: appointment.status, appointment_time: appointment.start ?? null })
  const timeZone = details.timeZone
  const basicLines = [
    `Business: ${details.businessName}`,
    include('callerName') ? `Caller: ${details.callerName || 'Not provided'}` : null,
    include('callerNumber') ? `Caller phone: ${details.callerNumber || 'Not available'}` : null,
    include('callerEmail') ? `Caller email: ${details.callerEmail || 'Not provided'}` : null,
    include('startedAt') ? `Call started: ${formatDateTime(details.startedAt, timeZone)}` : null,
    include('duration') ? `Call duration: ${formatDuration(details.durationSeconds)}` : null,
    include('outcome') ? `Outcome: ${details.outcome || 'Completed'}` : null,
  ].filter((line): line is string => line !== null)
  const appointmentLines = appointment
    ? [
        `Status: ${confirmed ? 'Confirmed booking' : appointment.status === 'pending' ? 'Pending — follow-up required' : appointment.status}`,
        `Caller’s preferred date/time: ${formatAppointmentPreference({ requested_date: appointment.requestedDate, requested_time: appointment.requestedTime, requested_timezone: appointment.requestedTimezone })}`,
        include('callerName') ? `Customer: ${appointment.customerName || 'Not provided'}` : null,
        !caller ? `Customer company: ${appointment.customerCompany || 'Not provided'}` : null,
        !caller && include('callerNumber') ? `Customer phone: ${appointment.customerPhone || 'Not provided'}` : null,
        !caller && include('callerEmail') ? `Customer email: ${appointment.customerEmail || 'Not provided'}` : null,
        !caller ? `Employee: ${appointment.employeeName || 'Unassigned'}` : null,
        `Service: ${appointment.service || 'Appointment'}`,
        confirmed && appointment.start
          ? `Starts: ${formatDateTime(appointment.start, appointment.timeZone)}`
          : null,
        confirmed && appointment.end
          ? `Ends: ${formatDateTime(appointment.end, appointment.timeZone)}`
          : null,
        confirmed && typeof appointment.durationMinutes === 'number'
          ? `Duration: ${appointment.durationMinutes} minutes`
          : null,
        !caller ? `Appointment details: ${appointmentNote(appointment.notes)}` : null,
      ].filter((line): line is string => Boolean(line))
    : []
  const proLines = details.planName === 'Recepta Pro' ? [
    ...(include('summary') ? ['', 'Call summary', (caller ? details.callerSummary : details.summary) || 'No AI summary was returned for this call.'] : []),
    ...(include('appointment') ? appointment
      ? ['', confirmed ? 'Confirmed appointment' : 'Appointment request / follow-up', ...appointmentLines]
      : ['', 'Appointment details', 'No appointment request or confirmed booking was recorded during this call.'] : []),
    ...(include('custom') && customDetails.length ? ['', caller ? 'Details you provided' : 'Captured call details', ...customDetails.map(item => `${item.label}: ${item.value}`)] : []),
  ] : []
  return {
    from,
    to: [recipientEmail.trim()],
    reply_to: caller ? ownerEmail || supportEmail : supportEmail,
    subject: caller ? `Your call with ${details.businessName}`
      : details.planName === 'Recepta Pro' ? `Recepta call details for ${details.businessName}` : `New Recepta call for ${details.businessName}`,
    text: [
      caller ? `Thank you for calling ${details.businessName}. Here is a receipt of your call.` : 'Your Recepta call is complete.',
      ...(caller ? ['An appointment request is not a confirmed booking. The business will follow up to confirm any requested arrangements.'] : []),
      '',
      ...basicLines,
      ...proLines,
    ].join('\n'),
    }
}
