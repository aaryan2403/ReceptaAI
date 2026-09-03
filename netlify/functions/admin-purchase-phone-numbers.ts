import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import {
  purchaseRetellPhoneNumber,
  releaseRetellPhoneNumber,
} from '../lib/retell'
import {
  MAX_TOTAL_PHONE_NUMBERS,
  normalizePhonePurchase,
} from '../lib/phoneNumbers'
import { calculateMonthlyPriceCad } from '../lib/pricing'

const json = (
  status: number,
  body: Record<string, unknown>
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
  const adminEmail = process.env.ADMIN_EMAIL
  const retellApiKey = process.env.RETELL_API_KEY
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !adminEmail ||
    !retellApiKey
  ) {
    return json(500, {
      error: 'Server configuration is incomplete.',
    })
  }

  const authHeader = request.headers.get('authorization')

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

  let body: {
    clientId?: string
    quantity?: number
    countryCode?: string
    areaCode?: string | null
  }

  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'Invalid request body.' })
  }

  const clientId = body.clientId?.trim()

  if (!clientId) {
    return json(400, { error: 'Client ID is required.' })
  }

  let purchase: ReturnType<typeof normalizePhonePurchase>

  try {
    purchase = normalizePhonePurchase({
      count: body.quantity,
      countryCode: body.countryCode,
      areaCode: body.areaCode,
    })
  } catch (error) {
    return json(400, {
      error:
        error instanceof Error
          ? error.message
          : 'Invalid phone-number purchase request.',
    })
  }

  if (purchase.purchaseCount < 1) {
    return json(400, {
      error: 'Choose at least one phone number to purchase.',
    })
  }

  const [clientResult, agentResult, subscriptionResult, phoneRowsResult] =
    await Promise.all([
      supabaseAdmin
        .from('clients')
        .select('company_name')
        .eq('id', clientId)
        .maybeSingle(),
      supabaseAdmin
        .from('agents')
        .select('retell_agent_id, phone_number')
        .eq('client_id', clientId)
        .maybeSingle(),
      supabaseAdmin
        .from('subscriptions')
        .select(
          'plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, stripe_subscription_id, status'
        )
        .eq('client_id', clientId)
        .maybeSingle(),
      supabaseAdmin
        .from('agent_phone_numbers')
        .select('phone_number, is_primary, created_at')
        .eq('client_id', clientId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true }),
    ])

  const lookupError =
    clientResult.error ||
    agentResult.error ||
    subscriptionResult.error ||
    phoneRowsResult.error

  if (lookupError) {
    return json(400, { error: lookupError.message })
  }

  const client = clientResult.data
  const agent = agentResult.data
  const subscription = subscriptionResult.data
  const existingPhoneNumbers = (phoneRowsResult.data ?? []).map(
    (row) => row.phone_number
  )

  if (!client || !agent?.retell_agent_id || !subscription) {
    return json(409, {
      error:
        'The client must have an active subscription and connected Retell agent.',
    })
  }

  if (subscription.status !== 'active') {
    return json(409, {
      error: 'Phone numbers can only be purchased for an active client.',
    })
  }

  if (
    subscription.plan_name !== 'Recepta Standard' &&
    subscription.plan_name !== 'Recepta Pro'
  ) {
    return json(400, { error: 'The client plan is invalid.' })
  }

  if (
    existingPhoneNumbers.length + purchase.purchaseCount >
    MAX_TOTAL_PHONE_NUMBERS
  ) {
    return json(400, {
      error: `This purchase would exceed the ${MAX_TOTAL_PHONE_NUMBERS}-number account limit.`,
    })
  }

  const { data: model, error: modelError } = await supabaseAdmin
    .from('ai_models')
    .select('customer_price_per_minute_cad')
    .eq('id', subscription.ai_model_id)
    .maybeSingle()

  const modelRate = Number(model?.customer_price_per_minute_cad)
  const monthlyMinutes = Number(subscription.monthly_minutes)

  if (
    modelError ||
    !model ||
    !Number.isFinite(modelRate) ||
    modelRate < 0 ||
    !Number.isFinite(monthlyMinutes) ||
    monthlyMinutes < 1
  ) {
    return json(400, {
      error: 'The client subscription pricing is invalid.',
    })
  }

  const newTotalCount =
    existingPhoneNumbers.length + purchase.purchaseCount
  const newMonthlyPrice = calculateMonthlyPriceCad({
    planName: subscription.plan_name,
    monthlyMinutes,
    modelPricePerMinuteCad: modelRate,
    piiRedactionEnabled:
      subscription.pii_redaction_enabled === true,
    safetyGuardrailsEnabled:
      subscription.safety_guardrails_enabled === true,
    extraPhoneNumbers: Math.max(0, newTotalCount - 1),
  })
  const purchasedPhoneNumbers: string[] = []
  let stripeRollback:
    | {
        subscriptionId: string
        itemId: string
        oldPriceId: string
      }
    | null = null

  try {
    for (let index = 0; index < purchase.purchaseCount; index += 1) {
      const phoneNumber = await purchaseRetellPhoneNumber({
        apiKey: retellApiKey,
        agentId: agent.retell_agent_id,
        countryCode: purchase.countryCode,
        areaCode: purchase.areaCode,
        nickname: `${client.company_name || 'Recepta client'} ${
          existingPhoneNumbers.length + index + 1
        }`,
      })

      const { error: saveNumberError } = await supabaseAdmin
        .from('agent_phone_numbers')
        .insert({
          client_id: clientId,
          phone_number: phoneNumber,
          is_primary:
            existingPhoneNumbers.length === 0 && index === 0,
          source: 'retell',
        })

      if (saveNumberError) {
        await releaseRetellPhoneNumber({
          apiKey: retellApiKey,
          phoneNumber,
        })
        throw saveNumberError
      }

      purchasedPhoneNumbers.push(phoneNumber)
    }

    if (subscription.stripe_subscription_id) {
      if (!stripeSecretKey) {
        throw new Error('STRIPE_SECRET_KEY is missing.')
      }

      const stripe = new Stripe(stripeSecretKey)
      const stripeSubscription = await stripe.subscriptions.retrieve(
        subscription.stripe_subscription_id,
        { expand: ['items.data.price.product'] }
      )
      const item = stripeSubscription.items.data[0]

      if (!item) {
        throw new Error('The Stripe subscription has no billing item.')
      }

      const productReference = item.price.product
      const productId =
        typeof productReference === 'string'
          ? productReference
          : productReference.id
      const newPrice = await stripe.prices.create({
        currency: 'cad',
        unit_amount: Math.round(newMonthlyPrice * 100),
        recurring: { interval: 'month' },
        product: productId,
        nickname: 'Recepta subscription with additional phone numbers',
      })

      await stripe.subscriptions.update(stripeSubscription.id, {
        items: [{ id: item.id, price: newPrice.id }],
        proration_behavior: 'none',
        metadata: {
          ...stripeSubscription.metadata,
          extra_phone_numbers: String(Math.max(0, newTotalCount - 1)),
          monthly_total_cad: newMonthlyPrice.toFixed(2),
        },
      })

      stripeRollback = {
        subscriptionId: stripeSubscription.id,
        itemId: item.id,
        oldPriceId: item.price.id,
      }
    }

    const primaryPhoneNumber =
      existingPhoneNumbers[0] ?? purchasedPhoneNumbers[0] ?? null
    const [subscriptionUpdate, agentUpdate] = await Promise.all([
      supabaseAdmin
        .from('subscriptions')
        .update({
          monthly_price: newMonthlyPrice,
          extra_phone_numbers: Math.max(0, newTotalCount - 1),
        })
        .eq('client_id', clientId),
      supabaseAdmin
        .from('agents')
        .update({ phone_number: primaryPhoneNumber })
        .eq('client_id', clientId),
    ])

    if (subscriptionUpdate.error) throw subscriptionUpdate.error
    if (agentUpdate.error) throw agentUpdate.error

    return json(200, {
      success: true,
      purchasedPhoneNumbers,
      phoneNumbers: [
        ...existingPhoneNumbers,
        ...purchasedPhoneNumbers,
      ],
      monthlyPrice: newMonthlyPrice,
      extraPhoneNumbers: Math.max(0, newTotalCount - 1),
    })
  } catch (error) {
    if (stripeRollback && stripeSecretKey) {
      try {
        const stripe = new Stripe(stripeSecretKey)
        await stripe.subscriptions.update(
          stripeRollback.subscriptionId,
          {
            items: [
              {
                id: stripeRollback.itemId,
                price: stripeRollback.oldPriceId,
              },
            ],
            proration_behavior: 'none',
          }
        )
      } catch (rollbackError) {
        console.error('Stripe phone-number rollback failed:', rollbackError)
      }
    }

    await supabaseAdmin
      .from('subscriptions')
      .update({
        monthly_price: subscription.monthly_price,
        extra_phone_numbers: subscription.extra_phone_numbers,
      })
      .eq('client_id', clientId)

    await supabaseAdmin
      .from('agents')
      .update({ phone_number: agent.phone_number })
      .eq('client_id', clientId)

    for (const phoneNumber of purchasedPhoneNumbers) {
      try {
        await releaseRetellPhoneNumber({
          apiKey: retellApiKey,
          phoneNumber,
        })
        await supabaseAdmin
          .from('agent_phone_numbers')
          .delete()
          .eq('client_id', clientId)
          .eq('phone_number', phoneNumber)
      } catch (rollbackError) {
        console.error('Retell phone-number rollback failed:', rollbackError)
      }
    }

    return json(502, {
      error:
        error instanceof Error
          ? `Phone-number purchase failed: ${error.message}`
          : 'Phone-number purchase failed.',
    })
  }
}
