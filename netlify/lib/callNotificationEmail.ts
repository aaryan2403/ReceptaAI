type PlanName = 'Recepta Standard' | 'Recepta Pro'

type AppointmentDetails = {
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

type CallNotificationDetails = {
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

export const sendCallNotification = async (
  details: CallNotificationDetails
) => {
  const ownerEmail = isEmail(details.ownerEmail)
    ? details.ownerEmail!.trim()
    : null

  if (!ownerEmail) {
    return {
      sent: false,
      warning:
        'The Recepta customer has no valid contact email, so the call notification could not be sent.',
    }
  }

  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    return {
      sent: false,
      warning:
        'RESEND_API_KEY is missing, so the Recepta customer call notification could not be sent.',
    }
  }

  const from =
    process.env.APPOINTMENT_FROM_EMAIL?.trim() ||
    process.env.REQUEST_NOTIFICATION_FROM_EMAIL?.trim() ||
    'Recepta Calls <onboarding@resend.dev>'
  const supportEmail =
    process.env.RECEPTA_SUPPORT_EMAIL?.trim() ||
    'receptahelp02@gmail.com'
  const appointment = details.appointment
  const timeZone = details.timeZone
  const basicLines = [
    `Business: ${details.businessName}`,
    `Caller: ${details.callerName || 'Not provided'}`,
    `Caller phone: ${details.callerNumber || 'Not available'}`,
    `Call started: ${formatDateTime(details.startedAt, timeZone)}`,
    `Call duration: ${formatDuration(details.durationSeconds)}`,
    `Outcome: ${details.outcome || 'Completed'}`,
  ]
  const appointmentLines = appointment
    ? [
        `Customer: ${appointment.customerName || 'Not provided'}`,
        `Customer company: ${appointment.customerCompany || 'Not provided'}`,
        `Customer phone: ${appointment.customerPhone || 'Not provided'}`,
        `Customer email: ${appointment.customerEmail || 'Not provided'}`,
        `Employee: ${appointment.employeeName || 'Unassigned'}`,
        `Service: ${appointment.service || 'Appointment'}`,
        appointment.start
          ? `Starts: ${formatDateTime(appointment.start, appointment.timeZone)}`
          : null,
        appointment.end
          ? `Ends: ${formatDateTime(appointment.end, appointment.timeZone)}`
          : null,
        typeof appointment.durationMinutes === 'number'
          ? `Duration: ${appointment.durationMinutes} minutes`
          : null,
        `Appointment details: ${appointment.notes || 'None provided'}`,
      ].filter((line): line is string => Boolean(line))
    : []
  const proLines =
    details.planName === 'Recepta Pro'
      ? [
          '',
          'Call summary',
          details.summary || 'No AI summary was returned for this call.',
          ...(appointment
            ? ['', 'Appointment details', ...appointmentLines]
            : ['', 'Appointment details', 'No appointment was booked during this call.']),
        ]
      : []
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [ownerEmail],
      reply_to: supportEmail,
      subject:
        details.planName === 'Recepta Pro'
          ? `Recepta call details: ${details.callerName || details.callerNumber || 'New caller'}`
          : `New Recepta call for ${details.businessName}`,
      text: [
        details.planName === 'Recepta Pro'
          ? 'Your Recepta call is complete. Full details are below.'
          : 'Your Recepta call is complete.',
        '',
        ...basicLines,
        ...proLines,
      ].join('\n'),
    }),
  })

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '')
    return {
      sent: false,
      warning: `Resend rejected the Recepta customer call notification (${response.status})${
        responseBody ? `: ${responseBody.slice(0, 300)}` : '.'
      }`,
    }
  }

  return { sent: true, warning: null }
}
