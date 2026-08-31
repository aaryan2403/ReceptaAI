
import { createClient } from '@supabase/supabase-js'
import {
  normalizeE164,
  syncRetellSubscription,
} from '../lib/retell'
import {
  calculateMonthlyPriceCad,
  MAX_MONTHLY_MINUTES,
} from '../lib/pricing'

type PlanName = 'Recepta Standard' | 'Recepta Pro'

const json = (
  status: number,
  body: Record<string, unknown>
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })

export default async (request: Request) => {
  if (request.method !== 'POST') {
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
  const retellApiKey =
    process.env.RETELL_API_KEY

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
    request.headers.get('authorization')

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
    phoneNumber?: string | null
    newPassword?: string | null
    reactivateSubscription?: boolean
    piiRedactionEnabled?: boolean
    safetyGuardrailsEnabled?: boolean
  }

  try {
    body = await request.json()
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
  const rawPhoneNumber =
    body.phoneNumber?.trim() || null
  const phoneNumber =
    normalizeE164(rawPhoneNumber)
  const newPassword =
    body.newPassword || null
  const reactivateSubscription =
    body.reactivateSubscription === true
  const piiRedactionEnabled =
    body.piiRedactionEnabled === true
  const safetyGuardrailsEnabled =
    body.safetyGuardrailsEnabled === true

  if (
    !clientId ||
    !companyName ||
    !email ||
    !aiModelId ||
    !Number.isFinite(monthlyMinutes) ||
    monthlyMinutes < 1 ||
    monthlyMinutes > MAX_MONTHLY_MINUTES
  ) {
    return json(400, {
      error: 'Missing or invalid client fields.',
    })
  }

  if (rawPhoneNumber && !phoneNumber) {
    return json(400, {
      error:
        'Phone number must include the country code, for example +14165550123.',
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
    data: selectedModel,
    error: selectedModelError,
  } = await supabaseAdmin
    .from('ai_models')
    .select(
      'id, customer_price_per_minute_cad'
    )
    .eq('id', aiModelId)
    .eq('is_active', true)
    .maybeSingle()

  const modelMinutePrice = Number(
    selectedModel?.customer_price_per_minute_cad
  )

  if (
    selectedModelError ||
    !selectedModel ||
    !Number.isFinite(modelMinutePrice) ||
    modelMinutePrice < 0
  ) {
    return json(400, {
      error:
        'Choose an active AI model with valid pricing.',
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

  const {
    data: existingSubscription,
    error: subscriptionLookupError,
  } = await supabaseAdmin
    .from('subscriptions')
    .select(
      'client_id, status, extra_phone_numbers'
    )
    .eq('client_id', clientId)
    .maybeSingle()

  if (subscriptionLookupError) {
    return json(400, {
      error:
        subscriptionLookupError.message,
    })
  }

  if (
    reactivateSubscription &&
    existingSubscription?.status !== 'cancelled'
  ) {
    return json(409, {
      error:
        'Only a cancelled subscription can be reactivated.',
    })
  }

  const subscriptionIsActive =
    reactivateSubscription ||
    !existingSubscription ||
    existingSubscription.status === 'active'

  const nextAgentStatus =
    subscriptionIsActive
      ? retellAgentId
        ? 'live'
        : 'setup'
      : 'paused'

  const monthlyPrice =
    calculateMonthlyPriceCad({
      planName,
      monthlyMinutes,
      modelPricePerMinuteCad:
        modelMinutePrice,
      piiRedactionEnabled,
      safetyGuardrailsEnabled,
      extraPhoneNumbers: Math.max(
        0,
        Number(
          existingSubscription?.extra_phone_numbers ??
            0
        ) || 0
      ),
    })

  const periodStart = new Date()
  const periodEnd = new Date(periodStart)
  periodEnd.setUTCMonth(
    periodEnd.getUTCMonth() + 1
  )

  if (existingSubscription) {
    const { error } = await supabaseAdmin
      .from('subscriptions')
      .update({
        plan_name: planName,
        monthly_price: monthlyPrice,
        monthly_minutes:
          Math.floor(monthlyMinutes),
        ai_model_id: aiModelId,
        pii_redaction_enabled:
          piiRedactionEnabled,
        safety_guardrails_enabled:
          safetyGuardrailsEnabled,
        ...(reactivateSubscription
          ? {
              status: 'active',
              stripe_subscription_id: null,
              current_period_start:
                periodStart.toISOString(),
              current_period_end:
                periodEnd.toISOString(),
              next_billing_date:
                periodEnd.toISOString(),
            }
          : {}),
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
        pii_redaction_enabled:
          piiRedactionEnabled,
        safety_guardrails_enabled:
          safetyGuardrailsEnabled,
        status: 'active',
        current_period_start:
          periodStart.toISOString(),
        current_period_end:
          periodEnd.toISOString(),
        next_billing_date:
          periodEnd.toISOString(),
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
        phone_number: phoneNumber,
        status: nextAgentStatus,
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
        phone_number: phoneNumber,
        status: nextAgentStatus,
      })

    if (error) {
      return json(400, {
        error: error.message,
      })
    }
  }


  const { error: clientStatusError } =
    await supabaseAdmin
      .from('clients')
      .update({
        status: nextAgentStatus,
      })
      .eq('id', clientId)

  if (clientStatusError) {
    return json(400, {
      error: clientStatusError.message,
    })
  }

  if (retellAgentId) {
    if (!retellApiKey) {
      return json(500, {
        error: 'RETELL_API_KEY is missing.',
      })
    }

    try {
      await syncRetellSubscription({
        apiKey: retellApiKey,
        agentId: retellAgentId,
        phoneNumber,
        active: subscriptionIsActive,
        piiRedactionEnabled,
        safetyGuardrailsEnabled,
      })
    } catch (error) {
      return json(502, {
        error:
          error instanceof Error
            ? `Client saved, but Retell sync failed: ${error.message}`
            : 'Client saved, but Retell sync failed.',
      })
    }
  }

  return json(200, {
    success: true,
    monthlyPrice,
  })
}
