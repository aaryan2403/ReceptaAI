type AppointmentEmailDetails = {
  businessName: string
  businessOwnerEmail?: string | null
  customerName: string
  customerEmail?: string | null
  customerPhone?: string | null
  customerCompany?: string | null
  employeeName: string
  employeeEmail?: string | null
  service?: string | null
  notes?: string | null
  start: string
  end: string
  timeZone: string
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

const sendEmail = async ({
  apiKey,
  from,
  to,
  replyTo,
  subject,
  text,
}: {
  apiKey: string
  from: string
  to: string
  replyTo: string
  subject: string
  text: string
}) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo,
      subject,
      text,
    }),
  })

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '')

    throw new Error(
      `Resend rejected an appointment email (${response.status})${
        responseBody ? `: ${responseBody.slice(0, 300)}` : '.'
      }`
    )
  }
}

export const sendAppointmentConfirmations = async (
  details: AppointmentEmailDetails
) => {
  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    return {
      sent: false,
      warning:
        'The appointment was booked, but RESEND_API_KEY is missing so confirmation emails were not sent.',
    }
  }

  const from =
    process.env.APPOINTMENT_FROM_EMAIL?.trim() ||
    process.env.REQUEST_NOTIFICATION_FROM_EMAIL?.trim() ||
    'Recepta Appointments <onboarding@resend.dev>'
  const supportEmail =
    process.env.RECEPTA_SUPPORT_EMAIL?.trim() ||
    'receptahelp02@gmail.com'
  const ownerEmail = isEmail(details.businessOwnerEmail)
    ? details.businessOwnerEmail!.trim()
    : null
  const customerEmail = isEmail(details.customerEmail)
    ? details.customerEmail!.trim()
    : null
  const start = formatDateTime(details.start, details.timeZone)
  const end = new Intl.DateTimeFormat('en-CA', {
    timeZone: details.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(details.end))
  const appointmentLines = [
    `Business: ${details.businessName}`,
    `Customer: ${details.customerName}`,
    details.customerCompany
      ? `Customer company: ${details.customerCompany}`
      : null,
    details.customerPhone
      ? `Customer phone: ${details.customerPhone}`
      : null,
    customerEmail ? `Customer email: ${customerEmail}` : null,
    `Employee: ${details.employeeName}`,
    details.service ? `Reason/service: ${details.service}` : null,
    `Starts: ${start}`,
    `Ends: ${end}`,
    details.notes ? `Details: ${details.notes}` : null,
  ].filter((line): line is string => Boolean(line))
  const deliveries: Promise<void>[] = []

  if (customerEmail) {
    deliveries.push(
      sendEmail({
        apiKey,
        from,
        to: customerEmail,
        replyTo: ownerEmail || supportEmail,
        subject: `Appointment confirmed with ${details.businessName}`,
        text: [
          `Hi ${details.customerName},`,
          '',
          'Your appointment is confirmed.',
          '',
          ...appointmentLines.filter(
            (line) => !line.startsWith('Customer email:')
          ),
          '',
          'If anything needs to change, reply to this email.',
        ].join('\n'),
      })
    )
  }

  if (ownerEmail && ownerEmail !== customerEmail) {
    deliveries.push(
      sendEmail({
        apiKey,
        from,
        to: ownerEmail,
        replyTo: customerEmail || supportEmail,
        subject: `New appointment: ${details.customerName} with ${details.employeeName}`,
        text: [
          'A new appointment was booked through Recepta.',
          '',
          ...appointmentLines,
          '',
          'Open the Recepta calendar to manage this appointment.',
        ].join('\n'),
      })
    )
  }

  if (deliveries.length === 0) {
    return {
      sent: false,
      warning:
        'The appointment was booked, but neither the caller nor business owner has a valid email address.',
    }
  }

  try {
    await Promise.all(deliveries)
    return { sent: true, warning: null }
  } catch (error) {
    return {
      sent: false,
      warning:
        error instanceof Error
          ? error.message
          : 'The appointment was booked, but confirmation emails failed.',
    }
  }
}
