type AppointmentSmsDetails = {
  enabled: boolean
  consent: boolean
  customerPhone?: string | null
  businessName: string
  employeeName: string
  start: string
  durationMinutes: number
  timeZone: string
}

const normalizeE164 = (value?: string | null) => {
  if (!value) return null
  const normalized = value.trim().replace(/[^\d+]/g, '')
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null
}

const formatDateTime = (value: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))

export const sendAppointmentSms = async (
  details: AppointmentSmsDetails
) => {
  if (!details.enabled || !details.consent) {
    return { sent: false, warning: null }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim()
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim()
  const fromNumber = process.env.TWILIO_SMS_FROM_NUMBER?.trim()
  const messagingServiceSid =
    process.env.TWILIO_MESSAGING_SERVICE_SID?.trim()
  const to = normalizeE164(details.customerPhone)

  if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
    return {
      sent: false,
      warning:
        'The buyer requested SMS, but Twilio SMS credentials or a sender are not configured.',
    }
  }

  if (!to) {
    return {
      sent: false,
      warning:
        'The buyer requested SMS, but their phone number is not in international format such as +14165550123.',
    }
  }

  const body = [
    `${details.businessName} appointment confirmed.`,
    `${formatDateTime(details.start, details.timeZone)} with ${details.employeeName}.`,
    `${details.durationMinutes} minutes.`,
    'Reply to the business if you need to make a change.',
  ].join(' ')
  const form = new URLSearchParams({ To: to, Body: body })

  if (messagingServiceSid) {
    form.set('MessagingServiceSid', messagingServiceSid)
  } else {
    form.set('From', fromNumber!)
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      accountSid
    )}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${accountSid}:${authToken}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  )

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '')
    return {
      sent: false,
      warning: `Twilio rejected the appointment SMS (${response.status})${
        responseBody ? `: ${responseBody.slice(0, 300)}` : '.'
      }`,
    }
  }

  return { sent: true, warning: null }
}
