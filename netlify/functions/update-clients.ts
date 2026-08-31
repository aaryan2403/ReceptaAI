
import { createClient } from '@supabase/supabase-js'

type PlanName = 'Recepta Standard' | 'Recepta Pro'

const json = (
  statusCode: number,
  body: Record<string, unknown>
) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, {
      error: 'Method not allowed.',
    })
  }

  const supabaseUrl =
    process.env.SUPABASE_URL
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY
  const adminEmail =
    process.env.ADMIN_EMAIL

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !adminEmail
  ) {
    return json(500, {
      error:
        'Server configuration is incomplete.',
    })
  }

  const authHeader =
    event.headers.authorization ||
    event.headers.Authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return json(401, {
      error: 'Unauthorized.',
    })
  }

  const token =
    authHeader.slice('Bearer '.length)

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
    data: { user: adminUser },
    error: adminUserError,
  } = await supabaseAdmin.auth.getUser(token)

  if (
    adminUserError ||
    !adminUser ||
    adminUser.email
      ?.trim()
      .toLowerCase() !==
      adminEmail.trim().toLowerCase()
  ) {
    return json(403, {
      error: 'Admin access required.',
    })
  }

  let body: {
    clientId?: string
    companyName?: string
    email?: string
    planName?: PlanName
    monthlyMinutes?: number
    aiModelId?: string
    retellAgentId?: string | null
    newPassword?: string | null
  }

  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return json(400, {
      error: 'Invalid request body.',
    })
  }

  const clientId =
    body.clientId?.trim()
  const companyName =
    body.companyName?.trim()
  const email =
    body.email?.trim().toLowerCase()
  const planName =
    body.planName
  const monthlyMinutes =
    Number(body.monthlyMinutes)
  const aiModelId =
    body.aiModelId?.trim()
  const retellAgentId =
    body.retellAgentId?.trim() || null
  const newPassword =
    body.newPassword || null

  if (
    !clientId ||
    !companyName ||
    !email ||
    !aiModelId ||
    !Number.isFinite(monthlyMinutes) ||
    monthlyMinutes < 1
  ) {
    return json(400, {
      error: 'Missing or invalid client fields.',
    })
  }

  if (
    planName !== 'Recepta Standard' &&
    planName !== 'Recepta Pro'
  ) {
    return json(400, {
      error: 'Invalid plan.',
    })
  }

  if (
    retellAgentId &&
    !retellAgentId.startsWith('agent_')
  ) {
    return json(400, {
      error:
        'Retell Agent ID must start with agent_.',
    })
  }

  if (
    newPassword &&
    newPassword.length < 8
  ) {
    return json(400, {
      error:
        'New temporary password must be at least 8 characters.',
    })
  }

  const {
    data: client,
    error: clientLookupError,
  } = await supabaseAdmin
    .from('clients')
    .select(
      'id, contact_email'
    )
    .eq('id', clientId)
    .maybeSingle()

  if (clientLookupError || !client) {
    return json(404, {
      error: 'Client not found.',
    })
  }

  const userId = client.id

  const authChanges: {
    email?: string
    password?: string
  } = {}

  if (
    email !==
    client.contact_email
      ?.trim()
      .toLowerCase()
  ) {
    authChanges.email = email
  }

  if (newPassword) {
    authChanges.password =
      newPassword
  }

  if (
    Object.keys(authChanges).length > 0
  ) {
    const { error: authUpdateError } =
      await supabaseAdmin.auth.admin.updateUserById(
        userId,
        authChanges
      )

    if (authUpdateError) {
      return json(400, {
        error: authUpdateError.message,
      })
    }
  }

  const { error: clientUpdateError } =
    await supabaseAdmin
      .from('clients')
      .update({
        company_name: companyName,
        contact_email: email,
      })
      .eq('id', clientId)

  if (clientUpdateError) {
    return json(400, {
      error: clientUpdateError.message,
    })
  }

  const monthlyPrice =
    planName === 'Recepta Pro'
      ? 300
      : 200

  const {
    data: existingSubscription,
    error: subscriptionLookupError,
  } = await supabaseAdmin
    .from('subscriptions')
    .select('client_id')
    .eq('client_id', clientId)
    .maybeSingle()

  if (subscriptionLookupError) {
    return json(400, {
      error:
        subscriptionLookupError.message,
    })
  }

  if (existingSubscription) {
    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        plan_name: planName,
        monthly_price: monthlyPrice,
        monthly_minutes:
          Math.floor(monthlyMinutes),
        ai_model_id: aiModelId,
      })
      .eq('client_id', clientId)

    if (error) {
      return json(400, {
        error: error.message,
      })
    }
  } else {
    const { error } = await supabaseAdmin
      .from('subscriptions')
      .insert({
        client_id: clientId,
        plan_name: planName,
        monthly_price: monthlyPrice,
        monthly_minutes:
          Math.floor(monthlyMinutes),
        ai_model_id: aiModelId,
        status: 'active',
      })

    if (error) {
      return json(400, {
        error: error.message,
      })
    }
  }

  const {
    data: existingAgent,
    error: agentLookupError,
  } = await supabaseAdmin
    .from('agents')
    .select('client_id')
    .eq('client_id', clientId)
    .maybeSingle()

  if (agentLookupError) {
    return json(400, {
      error: agentLookupError.message,
    })
  }

  if (existingAgent) {
    const { error } = await supabaseAdmin
      .from('agents')
      .update({
        retell_agent_id: retellAgentId,
        status: retellAgentId
          ? 'live'
          : 'setup',
      })
      .eq('client_id', clientId)

    if (error) {
      return json(400, {
        error: error.message,
      })
    }
  } else {
    const { error } = await supabaseAdmin
      .from('agents')
      .insert({
        client_id: clientId,
        retell_agent_id: retellAgentId,
        status: retellAgentId
          ? 'live'
          : 'setup',
      })

    if (error) {
      return json(400, {
        error: error.message,
      })
    }
  }

  return json(200, {
    success: true,
  })
}
