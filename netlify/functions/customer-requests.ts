import { createClient } from '@supabase/supabase-js'

const REQUEST_TYPES = new Set([
  'website_change',
  'ai_agent_change',
  'question',
  'meeting',
  'billing',
  'other',
])

const REQUEST_TYPE_LABELS: Record<string, string> = {
  website_change: 'Website change',
  ai_agent_change: 'AI agent change',
  question: 'Question',
  meeting: 'Meeting request',
  billing: 'Billing request',
  other: 'Other request',
}

const NOTIFICATION_EMAIL = 'receptahelp02@gmail.com'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const sendRequestNotification = async ({
  companyName,
  clientEmail,
  requestType,
  title,
  details,
}: {
  companyName: string
  clientEmail: string
  requestType: string
  title: string
  details: string
}) => {
  const resendApiKey = process.env.RESEND_API_KEY

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is missing.')
  }

  const from =
    process.env.REQUEST_NOTIFICATION_FROM_EMAIL?.trim() ||
    'Recepta Requests <onboarding@resend.dev>'

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [NOTIFICATION_EMAIL],
      reply_to: clientEmail,
      subject: `New Recepta request: ${title}`,
      text: [
        'A customer submitted a new Recepta request.',
        '',
        `Company: ${companyName}`,
        `Customer email: ${clientEmail}`,
        `Request type: ${REQUEST_TYPE_LABELS[requestType] || requestType}`,
        `Title: ${title}`,
        '',
        'Details:',
        details,
        '',
        'Open the Recepta Admin Customer Requests page to manage it.',
      ].join('\n'),
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    throw new Error(
      `Email provider rejected the notification (${response.status})${
        errorBody ? `: ${errorBody.slice(0, 300)}` : '.'
      }`
    )
  }
}

export default async (request: Request) => {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const authHeader = request.headers.get('authorization')

  if (!supabaseUrl || !supabaseSecretKey) {
    return json(500, { error: 'Server configuration is missing.' })
  }

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, { error: 'Unauthorized.' })
  }

  const supabaseAdmin = createClient(
    supabaseUrl,
    supabaseSecretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )

  const {
    data: { user },
    error: userError,
  } = await supabaseAdmin.auth.getUser(
    authHeader.slice('Bearer '.length)
  )

  if (userError || !user) {
    return json(401, { error: 'Unauthorized.' })
  }

  if (request.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('customer_requests')
      .select(
        'id, request_type, title, details, status, email_sent_at, created_at, updated_at'
      )
      .eq('client_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      return json(400, { error: error.message })
    }

    return json(200, { requests: data ?? [] })
  }

  let body: {
    requestType?: string
    title?: string
    details?: string
  }

  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid request body.' })
  }

  const requestType = body.requestType?.trim() || 'other'
  const title = body.title?.trim() || ''
  const details = body.details?.trim() || ''

  if (!REQUEST_TYPES.has(requestType)) {
    return json(400, { error: 'Choose a valid request type.' })
  }

  if (title.length < 3 || title.length > 160) {
    return json(400, {
      error: 'The request title must be between 3 and 160 characters.',
    })
  }

  if (details.length < 10 || details.length > 5000) {
    return json(400, {
      error: 'Request details must be between 10 and 5,000 characters.',
    })
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('company_name, contact_email')
    .eq('id', user.id)
    .maybeSingle()

  if (clientError || !client) {
    return json(404, { error: 'Customer account not found.' })
  }

  const { data: createdRequest, error: insertError } =
    await supabaseAdmin
      .from('customer_requests')
      .insert({
        client_id: user.id,
        request_type: requestType,
        title,
        details,
        status: 'new',
      })
      .select(
        'id, request_type, title, details, status, email_sent_at, created_at, updated_at'
      )
      .single()

  if (insertError || !createdRequest) {
    return json(400, {
      error: insertError?.message || 'Could not save the request.',
    })
  }

  let notificationSent = false
  let notificationWarning: string | null = null

  try {
    await sendRequestNotification({
      companyName: client.company_name || 'Recepta customer',
      clientEmail:
        client.contact_email || user.email || 'No customer email available',
      requestType,
      title,
      details,
    })
    notificationSent = true

    const emailSentAt = new Date().toISOString()
    createdRequest.email_sent_at = emailSentAt

    await supabaseAdmin
      .from('customer_requests')
      .update({ email_sent_at: emailSentAt })
      .eq('id', createdRequest.id)
  } catch (error) {
    notificationWarning =
      error instanceof Error
        ? error.message
        : 'The email notification could not be sent.'
    console.error('Customer request notification failed:', error)
  }

  return json(201, {
    request: createdRequest,
    notificationSent,
    notificationWarning,
  })
}
