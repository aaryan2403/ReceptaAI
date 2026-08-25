import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

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
      process.env.STRIPE_SECRET_KEY

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !stripeSecretKey
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

    const {
      planName,
      aiModelId,
      monthlyMinutes,
    } = await request.json()

    if (
      planName !== 'Recepta Standard' &&
      planName !== 'Recepta Pro'
    ) {
      return new Response(
        JSON.stringify({ error: 'Invalid plan.' }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const minutes = Number(monthlyMinutes)

    if (
      !Number.isFinite(minutes) ||
      minutes < 1
    ) {
      return new Response(
        JSON.stringify({
          error: 'Invalid monthly minutes.',
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
      .select('status')
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

    // Customers can only self-purchase AFTER cancelling
    // a subscription that was initially activated by Admin.
    if (
      !currentSubscription ||
      currentSubscription.status !== 'cancelled'
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Your current subscription must be cancelled before purchasing a new one.',
        }),
        {
          status: 403,
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
        ? 300
        : 200

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

    const monthlyTotal =
      basePrice + minuteCost

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
      request.headers.get('origin') ||
      process.env.URL ||
      'http://localhost:5173'

    const metadata = {
      client_id: user.id,
      plan_name: planName,
      base_price_cad: String(basePrice),
      ai_model_id: model.id,
      ai_model_name: model.display_name,
      monthly_minutes:
        String(Math.floor(minutes)),
      per_minute_cad:
        String(perMinutePrice),
      monthly_total_cad:
        monthlyTotal.toFixed(2),
    }

    const checkoutSession =
      await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email:
          user.email || undefined,
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
                  `${Math.floor(minutes)} AI call minutes per month`,
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
      })

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
