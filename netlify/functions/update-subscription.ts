import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { calculateMonthlyPriceCad, MAX_MONTHLY_MINUTES } from '../lib/pricing'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY

    if (!supabaseUrl || !supabaseSecretKey) {
      return json(500, { error: 'Server configuration is missing.' })
    }

    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) return json(401, { error: 'Unauthorized.' })

    const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: { user }, error: userError } =
      await supabaseAdmin.auth.getUser(authHeader.slice('Bearer '.length))

    if (userError || !user) return json(401, { error: 'Unauthorized.' })

    const body = (await request.json()) as {
      action?: string
      monthlyMinutes?: number
    }

    if (body.action !== 'change_minutes') {
      return json(403, {
        error: 'Customers can only change monthly minutes. Contact Recepta for all other configuration changes.',
      })
    }

    const monthlyMinutes = Math.floor(Number(body.monthlyMinutes))
    if (
      !Number.isFinite(monthlyMinutes) ||
      monthlyMinutes < 1 ||
      monthlyMinutes > MAX_MONTHLY_MINUTES
    ) {
      return json(400, {
        error: `Monthly minutes must be between 1 and ${MAX_MONTHLY_MINUTES.toLocaleString()}.`,
      })
    }

    const { data: subscription, error: subscriptionError } = await supabaseAdmin
      .from('subscriptions')
      .select('status, stripe_subscription_id, plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers')
      .eq('client_id', user.id)
      .maybeSingle()

    if (subscriptionError) return json(400, { error: subscriptionError.message })
    if (!subscription) return json(404, { error: 'No subscription found.' })
    if (subscription.status !== 'active') {
      return json(409, { error: 'Only an active subscription can change monthly minutes.' })
    }
    if (
      subscription.plan_name !== 'Recepta Standard' &&
      subscription.plan_name !== 'Recepta Pro'
    ) {
      return json(400, { error: 'The current Recepta plan is invalid.' })
    }
    if (!subscription.ai_model_id) {
      return json(409, { error: 'Recepta must assign an AI model before minutes can be changed.' })
    }

    if (Number(subscription.monthly_minutes) === monthlyMinutes) {
      return json(200, {
        success: true,
        unchanged: true,
        monthlyMinutes,
        monthlyPrice: subscription.monthly_price,
      })
    }

    const { data: model, error: modelError } = await supabaseAdmin
      .from('ai_models')
      .select('customer_price_per_minute_cad')
      .eq('id', subscription.ai_model_id)
      .maybeSingle()

    const modelPricePerMinuteCad = Number(model?.customer_price_per_minute_cad)
    if (modelError || !model || !Number.isFinite(modelPricePerMinuteCad) || modelPricePerMinuteCad < 0) {
      return json(400, { error: 'The assigned AI configuration has invalid pricing.' })
    }

    const monthlyPrice = calculateMonthlyPriceCad({
      planName: subscription.plan_name,
      monthlyMinutes,
      modelPricePerMinuteCad,
      piiRedactionEnabled: subscription.pii_redaction_enabled === true,
      safetyGuardrailsEnabled: subscription.safety_guardrails_enabled === true,
      extraPhoneNumbers: Math.max(0, Number(subscription.extra_phone_numbers ?? 0) || 0),
    })

    let stripeRollback: {
      subscriptionId: string
      itemId: string
      oldPriceId: string
    } | null = null

    if (subscription.stripe_subscription_id) {
      if (!stripeSecretKey) return json(500, { error: 'STRIPE_SECRET_KEY is missing.' })

      try {
        const stripe = new Stripe(stripeSecretKey)
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripe_subscription_id,
          { expand: ['items.data.price.product'] }
        )
        const subscriptionItem = stripeSubscription.items.data[0]
        if (!subscriptionItem) throw new Error('The Stripe subscription has no billing item.')

        const productReference = subscriptionItem.price.product
        const productId = typeof productReference === 'string'
          ? productReference
          : productReference.id
        const newPrice = await stripe.prices.create({
          currency: 'cad',
          unit_amount: Math.round(monthlyPrice * 100),
          recurring: { interval: 'month' },
          product: productId,
          nickname: `${monthlyMinutes} minutes — Recepta monthly subscription`,
          metadata: {
            recepta_monthly_minutes: String(monthlyMinutes),
            recepta_monthly_total_cad: monthlyPrice.toFixed(2),
          },
        })

        await stripe.subscriptions.update(stripeSubscription.id, {
          items: [{ id: subscriptionItem.id, price: newPrice.id }],
          proration_behavior: 'none',
          metadata: {
            ...stripeSubscription.metadata,
            monthly_minutes: String(monthlyMinutes),
            monthly_total_cad: monthlyPrice.toFixed(2),
          },
        })

        stripeRollback = {
          subscriptionId: stripeSubscription.id,
          itemId: subscriptionItem.id,
          oldPriceId: subscriptionItem.price.id,
        }
      } catch (error) {
        return json(502, {
          error: error instanceof Error
            ? `Could not update Stripe billing: ${error.message}`
            : 'Could not update Stripe billing.',
        })
      }
    }

    const { error: updateError } = await supabaseAdmin
      .from('subscriptions')
      .update({ monthly_minutes: monthlyMinutes, monthly_price: monthlyPrice })
      .eq('client_id', user.id)

    if (updateError) {
      if (stripeRollback && stripeSecretKey) {
        try {
          const stripe = new Stripe(stripeSecretKey)
          await stripe.subscriptions.update(stripeRollback.subscriptionId, {
            items: [{ id: stripeRollback.itemId, price: stripeRollback.oldPriceId }],
            proration_behavior: 'none',
          })
        } catch (rollbackError) {
          console.error('Stripe minute-change rollback failed:', rollbackError)
        }
      }
      return json(400, { error: updateError.message })
    }

    return json(200, {
      success: true,
      monthlyMinutes,
      monthlyPrice,
      stripeSubscriptionUpdated: Boolean(stripeRollback),
    })
  } catch (error) {
    console.error('Update subscription error:', error)
    return json(500, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  }
}
