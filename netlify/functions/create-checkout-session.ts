import { searchTwilioNumbers, selectedNumbersConfigured } from '../lib/twilioNumbers'
import { getRetellApiKey } from '../lib/retellEnvironment'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { stripeTestModeRequired, stripeSecretKey as configuredStripeSecretKey } from '../lib/stripeEnvironment'
import { createHash } from 'node:crypto'
import { automaticReceptionConfigured } from '../lib/phoneProvisioning'
import { phoneFeatureEnabled } from '../lib/phoneSetup'
import { normalizePhonePurchase } from '../lib/phoneNumbers'

const MAX_MONTHLY_MINUTES = 100_000_000

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY
    const stripeSecretKey =
      configuredStripeSecretKey()
    const retellApiKey =
      getRetellApiKey()

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !stripeSecretKey ||
      (!retellApiKey && !stripeTestModeRequired())
    ) {
      return new Response(
        JSON.stringify({
          error: 'Server configuration is missing.',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const authHeader =
      request.headers.get('authorization')

    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const accessToken =
      authHeader.replace('Bearer ', '')

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
      accessToken
    )

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { monthlyMinutes, phonePreferences } = await request.json()

    const minutes = Number(monthlyMinutes)

    if (
      !Number.isFinite(minutes) ||
      minutes < 1 ||
      minutes > MAX_MONTHLY_MINUTES
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Monthly minutes must be between 1 and 100,000,000.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const {
      data: currentSubscription,
      error: subscriptionError,
    } = await supabaseAdmin
      .from('subscriptions')
      .select('status, stripe_subscription_id, stripe_customer_id, plan_name, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, pending_configuration, configuration_revision')
      .eq('client_id', user.id)
      .maybeSingle()

    if (subscriptionError) {
      return new Response(
        JSON.stringify({
          error: subscriptionError.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (!currentSubscription) {
      return new Response(
        JSON.stringify({
          error: 'Recepta must configure your subscription before checkout.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (currentSubscription.status === 'past_due') {
      return new Response(
        JSON.stringify({
          error:
            'Resolve the outstanding payment before changing monthly minutes.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const clientAvailability = await supabaseAdmin.from('clients').select('deletion_pending').eq('id', user.id).maybeSingle()
    if (clientAvailability.error) throw clientAvailability.error
    if (clientAvailability.data?.deletion_pending) return new Response(JSON.stringify({ error: 'This account is awaiting deletion.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })

    const replacingSubscriptionId =
      currentSubscription.status === 'active'
        ? currentSubscription.stripe_subscription_id
        : null

    if (
      replacingSubscriptionId &&
      !currentSubscription.pending_configuration &&
      (!phoneFeatureEnabled() || phonePreferences?.extraNumbers === undefined || phonePreferences.extraNumbers === currentSubscription.extra_phone_numbers) &&
      Number(currentSubscription.monthly_minutes) === Math.floor(minutes)
    ) {
      return new Response(
        JSON.stringify({ error: 'This is already your current minute allowance.' }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const configuration = { ...currentSubscription, ...(currentSubscription.pending_configuration ?? {}) }
    const planName = configuration.plan_name
    const aiModelId = configuration.ai_model_id

    if (
      (planName !== 'Recepta Standard' && planName !== 'Recepta Pro') ||
      !aiModelId
    ) {
      return new Response(
        JSON.stringify({
          error: 'Recepta must finish assigning your plan and AI configuration.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { data: assignedAgent, error: agentError } =
      await supabaseAdmin
        .from('agents')
        .select('retell_agent_id,phone_number')
        .eq('client_id', user.id)
        .maybeSingle()

    if (agentError) {
      return new Response(
        JSON.stringify({ error: agentError.message }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (!assignedAgent?.retell_agent_id && !automaticReceptionConfigured() && !stripeTestModeRequired()) {
      return new Response(
        JSON.stringify({
          error:
            'Your Retell agent must be connected before buying a subscription and phone numbers.',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const {
      data: model,
      error: modelError,
    } = await supabaseAdmin
      .from('ai_models')
      .select(
        'id, display_name, customer_price_per_minute_cad, is_active'
      )
      .eq('id', aiModelId)
      .eq('is_active', true)
      .maybeSingle()

    if (modelError || !model) {
      return new Response(
        JSON.stringify({
          error: 'Invalid AI model.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const basePrice =
      planName === 'Recepta Pro'
        ? 299
        : 199

    const perMinutePrice =
      Number(
        model.customer_price_per_minute_cad
      )

    if (
      !Number.isFinite(perMinutePrice) ||
      perMinutePrice < 0
    ) {
      return new Response(
        JSON.stringify({
          error: 'Invalid AI model pricing.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const minuteCost =
      Math.floor(minutes) *
      perMinutePrice

    const piiRedaction =
      configuration.pii_redaction_enabled === true

    const safetyGuardrails =
      configuration.safety_guardrails_enabled === true

    const existingExtraNumbers = Number(configuration.extra_phone_numbers ?? 0)
    const preferences = phoneFeatureEnabled() ? phonePreferences : undefined
    if (preferences && (!['CA', 'US'].includes(preferences.country) ||
      !Number.isInteger(preferences.extraNumbers) || preferences.extraNumbers < existingExtraNumbers)) {
      return new Response(JSON.stringify({ error: 'Choose a supported country and keep your existing numbers.' }), { status: 400 })
    }
    const extraPhoneNumbers = preferences?.extraNumbers ?? existingExtraNumbers
    const selectedNumber = typeof preferences?.selectedNumber === 'string' ? preferences.selectedNumber : ''
    if (selectedNumber) {
      if (preferences.purchaseConfirmed !== true || !selectedNumbersConfigured() ||
        !/^\+1[2-9]\d{9}$/.test(selectedNumber)) {
        return new Response(JSON.stringify({ error: 'Confirm the selected-number purchase and its charges before Checkout.' }), { status: 400 })
      }
      const { data: owned, error: ownedError } = await supabaseAdmin.from('agent_phone_numbers').select('phone_number').eq('client_id', user.id)
      if (ownedError) throw ownedError
      const ownedNumbers = new Set([...(owned ?? []).map(row => row.phone_number), assignedAgent?.phone_number].filter(Boolean))
      const newCount = extraPhoneNumbers + 1 - ownedNumbers.size
      if (newCount !== 1) return new Response(JSON.stringify({ error: 'Select one new number per Checkout. Keep your existing number quantity and add one when ordering another.' }), { status: 400 })
      const assignedNumbers = await Promise.all([
        supabaseAdmin.from('agent_phone_numbers').select('client_id').eq('phone_number', selectedNumber).limit(1),
        supabaseAdmin.from('agents').select('client_id').eq('phone_number', selectedNumber).limit(1),
      ])
      if (assignedNumbers.some(result => result.error || result.data?.length)) return new Response(JSON.stringify({ error: 'That number is already assigned or its ownership could not be verified.' }), { status: 409 })
      const available = await searchTwilioNumbers(preferences.country, '', selectedNumber)
      if (!available.some(row => row.number === selectedNumber)) return new Response(JSON.stringify({ error: 'That number is no longer available. Search again before paying.' }), { status: 409 })
    }


    if (
      !Number.isInteger(extraPhoneNumbers) ||
      extraPhoneNumbers < 0 ||
      extraPhoneNumbers > 20
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Extra phone numbers must be between 0 and 20.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    let phonePurchase: ReturnType<typeof normalizePhonePurchase>

    try {
      phonePurchase = normalizePhonePurchase({
        count: extraPhoneNumbers + 1,
        countryCode: preferences?.country ?? configuration.phone_number_country ?? 'CA',
        areaCode: preferences?.areaCode ?? configuration.phone_number_area_code ?? null,
      })
    } catch (error) {
      return new Response(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : 'Invalid phone-number request.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const piiRedactionRateCad = 0.014
    const safetyGuardrailsRateCad = 0.007
    const extraPhoneNumberMonthlyCad = 20

    const piiRedactionCost =
      piiRedaction
        ? Math.floor(minutes) *
          piiRedactionRateCad
        : 0

    const safetyGuardrailsCost =
      safetyGuardrails
        ? Math.floor(minutes) *
          safetyGuardrailsRateCad
        : 0

    const extraPhoneNumbersCost =
      extraPhoneNumbers *
      extraPhoneNumberMonthlyCad

    const addOnsMonthlyCost =
      piiRedactionCost +
      safetyGuardrailsCost +
      extraPhoneNumbersCost

    const monthlyTotal =
      basePrice +
      minuteCost +
      addOnsMonthlyCost

    const monthlyTotalCents =
      Math.round(monthlyTotal * 100)

    if (monthlyTotalCents < 50) {
      return new Response(
        JSON.stringify({
          error: 'Invalid subscription total.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const stripe =
      new Stripe(stripeSecretKey)

    const origin =
      new URL(process.env.RECEPTA_APP_URL || process.env.URL || request.url).origin

    const metadata = {
      selected_phone_number: selectedNumber,
      quote_revision: String(currentSubscription.configuration_revision ?? 0),
      client_id: user.id,
      plan_name: planName,
      base_price_cad: String(basePrice),
      ai_model_id: model.id,
      ai_model_name: model.display_name,
      monthly_minutes:
        String(Math.floor(minutes)),
      per_minute_cad:
        String(perMinutePrice),
      pii_redaction_enabled:
        String(piiRedaction),
      pii_redaction_rate_cad:
        String(piiRedactionRateCad),
      safety_guardrails_enabled:
        String(safetyGuardrails),
      safety_guardrails_rate_cad:
        String(safetyGuardrailsRateCad),
      extra_phone_numbers:
        String(extraPhoneNumbers),
      extra_phone_number_monthly_cad:
        String(extraPhoneNumberMonthlyCad),
      phone_number_country:
        phonePurchase.countryCode,
      phone_number_area_code:
        phonePurchase.areaCode === null
          ? ''
          : String(phonePurchase.areaCode),
      add_ons_monthly_cad:
        addOnsMonthlyCost.toFixed(2),
      monthly_total_cad:
        monthlyTotal.toFixed(2),
      change_type:
        replacingSubscriptionId
          ? 'replace_active_subscription'
          : 'activate_subscription',
      replaces_subscription_id:
        replacingSubscriptionId || '',
    }

    const selectedAddOns = [
      piiRedaction
        ? 'PII Redaction'
        : null,
      safetyGuardrails
        ? 'Safety Guardrails'
        : null,
      extraPhoneNumbers > 0
        ? `${extraPhoneNumbers} additional phone ${
            extraPhoneNumbers === 1
              ? 'number'
              : 'numbers'
          }`
        : null,
    ].filter(Boolean)

    const checkoutKey = createHash('sha256').update(JSON.stringify([metadata, origin, currentSubscription.stripe_customer_id ?? user.email])).digest('hex')
    const checkoutSession =
      await stripe.checkout.sessions.create({
        mode: 'subscription',
        integration_identifier: `recepta_checkout_${checkoutKey.slice(0, 8).replace(/[0-9]/g, digit => String.fromCharCode(97 + Number(digit)))}`,
        customer:
          currentSubscription.stripe_customer_id || undefined,
        customer_email:
          currentSubscription.stripe_customer_id
            ? undefined
            : user.email || undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'cad',
              unit_amount:
                monthlyTotalCents,
              recurring: {
                interval: 'month',
              },
              product_data: {
                name:
                  `${planName} — ${model.display_name}`,
                description:
                  `${Math.floor(minutes)} AI call minutes per month${
                    selectedAddOns.length > 0
                      ? `; add-ons: ${selectedAddOns.join(', ')}`
                      : ''
                  }`,
              },
            },
          },
        ],
        success_url:
          `${origin}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:
          `${origin}/dashboard/billing?checkout=cancelled`,
        metadata,
        subscription_data: {
          metadata,
        },
      }, { idempotencyKey: 'recepta-checkout-' + checkoutKey })

    if (!checkoutSession.url) {
      return new Response(
        JSON.stringify({
          error:
            'Stripe did not return a Checkout URL.',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        url: checkoutSession.url,
        monthlyTotal:
          Number(monthlyTotal.toFixed(2)),
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Create checkout session error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not create Stripe Checkout session.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
