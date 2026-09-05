import { createClient } from '@supabase/supabase-js'

const ALLOWED_STATUSES = new Set([
  'new',
  'in_progress',
  'resolved',
])

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (request: Request) => {
  if (request.method !== 'GET' && request.method !== 'PATCH') {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const adminEmail = process.env.ADMIN_EMAIL
  const authHeader = request.headers.get('authorization')

  if (!supabaseUrl || !supabaseSecretKey || !adminEmail) {
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

  if (
    userError ||
    !user ||
    user.email?.trim().toLowerCase() !==
      adminEmail.trim().toLowerCase()
  ) {
    return json(403, { error: 'Admin access required.' })
  }

  if (request.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('customer_requests')
      .select(
        `
        id,
        client_id,
        request_type,
        title,
        details,
        status,
        email_sent_at,
        created_at,
        updated_at,
        clients (
          company_name,
          contact_email
        )
        `
      )
      .order('created_at', { ascending: false })

    if (error) {
      return json(400, { error: error.message })
    }

    const requests = data ?? []

    return json(200, {
      requests,
      newCount: requests.filter((item) => item.status === 'new').length,
    })
  }

  let body: { requestId?: string; status?: string }

  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid request body.' })
  }

  const requestId = body.requestId?.trim()
  const status = body.status?.trim()

  if (!requestId || !status || !ALLOWED_STATUSES.has(status)) {
    return json(400, { error: 'Choose a valid request and status.' })
  }

  const { data, error } = await supabaseAdmin
    .from('customer_requests')
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select(
      'id, client_id, request_type, title, details, status, email_sent_at, created_at, updated_at'
    )
    .maybeSingle()

  if (error) {
    return json(400, { error: error.message })
  }

  if (!data) {
    return json(404, { error: 'Customer request not found.' })
  }

  return json(200, { request: data })
}
