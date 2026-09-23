type AppointmentEmailDetails = {
  sendCustomerEmail?: boolean
  includeFullDetails?: boolean
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
  durationMinutes: number
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
      deliveredRecipients: [] as string[],
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
  const validCustomerEmail = isEmail(details.customerEmail)
    ? details.customerEmail!.trim()
    : null
  const customerEmail =
    details.sendCustomerEmail === false ? null : validCustomerEmail
  const employeeEmail = isEmail(details.employeeEmail)
    ? details.employeeEmail!.trim()
    : null
  const start = formatDateTime(details.start, details.timeZone)
  const end = new Intl.DateTimeFormat('en-CA', {
    timeZone: details.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(details.end))
  const basicAppointmentLines = [
    `Business: ${details.businessName}`,
    `Customer: ${details.customerName}`,
    `Employee: ${details.employeeName}`,
    details.service ? `Reason/service: ${details.service}` : null,
    `Starts: ${start}`,
    `Ends: ${end}`,
    `Duration: ${details.durationMinutes} minutes`,
  ].filter((line): line is string => Boolean(line))
  const fullAppointmentLines = [
    ...basicAppointmentLines,
    details.customerCompany
      ? `Customer company: ${details.customerCompany}`
      : null,
    details.customerPhone
      ? `Customer phone: ${details.customerPhone}`
      : null,
    validCustomerEmail ? `Customer email: ${validCustomerEmail}` : null,
    details.notes ? `Details: ${details.notes}` : null,
  ].filter((line): line is string => Boolean(line))
  const staffAppointmentLines =
    details.includeFullDetails === false
      ? basicAppointmentLines
      : fullAppointmentLines
  const deliveries: Array<{
    recipient: string
    email: string
    promise: Promise<void>
  }> = []
  const usedEmails = new Set<string>()

  const addDelivery = (
    recipient: string,
    email: string,
    send: () => Promise<void>
  ) => {
    const key = email.toLowerCase()
    if (usedEmails.has(key)) return
    usedEmails.add(key)
    deliveries.push({ recipient, email, promise: send() })
  }

  // Prioritize the business owner when two roles share an address. The
  // Recepta customer must always receive the plan-appropriate staff copy.
  if (ownerEmail) {
    addDelivery(
      'business owner',
      ownerEmail,
      () => sendEmail({
        apiKey,
        from,
        to: ownerEmail,
        replyTo: validCustomerEmail || supportEmail,
        subject: `New appointment: ${details.customerName} with ${details.employeeName}`,
        text: [
          'A new appointment was booked through Recepta.',
          '',
          ...staffAppointmentLines,
          '',
          'Open the Recepta calendar to manage this appointment.',
        ].join('\n'),
      })
    )
  }

  if (customerEmail) {
    addDelivery(
      'customer',
      customerEmail,
      () => sendEmail({
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
          ...basicAppointmentLines,
          '',
          'If anything needs to change, reply to this email.',
        ].join('\n'),
      })
    )
  }

  if (employeeEmail) {
    addDelivery(
      'employee',
      employeeEmail,
      () => sendEmail({
        apiKey,
        from,
        to: employeeEmail,
        replyTo: validCustomerEmail || ownerEmail || supportEmail,
        subject: `Appointment assigned: ${details.customerName} with ${details.employeeName}`,
        text: [
          `Hi ${details.employeeName},`,
          '',
          'A Recepta appointment was assigned to you.',
          '',
          ...staffAppointmentLines,
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
        'The appointment was booked, but the customer, employee, and business owner do not have a valid email address.',
      deliveredRecipients: [] as string[],
    }
  }

  const results = await Promise.allSettled(
    deliveries.map((delivery) => delivery.promise)
  )
  const deliveredRecipients = deliveries
    .filter((_, index) => results[index].status === 'fulfilled')
    .map((delivery) => delivery.recipient)
  const failedRecipients = deliveries
    .filter((_, index) => results[index].status === 'rejected')
    .map((delivery) => delivery.recipient)
  const warnings: string[] = []

  if (!employeeEmail) {
    warnings.push(
      'The selected employee has no valid email, so the employee confirmation was skipped.'
    )
  }
  if (details.sendCustomerEmail !== false && !customerEmail) {
    warnings.push(
      'The customer has no valid email, so the customer confirmation was skipped.'
    )
  }
  if (!ownerEmail) {
    warnings.push(
      'The business owner has no valid contact email, so the owner confirmation was skipped.'
    )
  }
  if (failedRecipients.length > 0) {
    warnings.push(
      `Email delivery failed for: ${failedRecipients.join(', ')}.`
    )
  }

  return {
    sent: deliveredRecipients.length > 0 && failedRecipients.length === 0,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
    deliveredRecipients,
  }
}
