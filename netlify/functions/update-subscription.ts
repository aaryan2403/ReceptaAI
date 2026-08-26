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
    const supabaseUrl =
      process.env.SUPABASE_URL
    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY
    const stripeSecretKey =
      process.env.STRIPE_SECRET_KEY

    if (
      !supabaseUrl ||
      !supabaseSecretKey
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

    const supabaseAdmin =
      createClient(
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

    const { action } =
      await request.json()

    if (action !== 'cancel') {
      return new Response(
        JSON.stringify({
          error:
            'Only cancellation is allowed from the customer billing page.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const {
      data: subscription,
      error: subscriptionError,
    } = await supabaseAdmin
      .from('subscriptions')
      .select(
        'status, stripe_subscription_id'
      )
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

    if (!subscription) {
      return new Response(
        JSON.stringify({
          error: 'No subscription found.',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (
      subscription.status ===
      'cancelled'
    ) {
      return new Response(
        JSON.stringify({
          success: true,
          status: 'cancelled',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (
      subscription.stripe_subscription_id &&
      stripeSecretKey
    ) {
      const stripe =
        new Stripe(stripeSecretKey)

      await stripe.subscriptions.cancel(
        subscription.stripe_subscription_id
      )
    }

    const { error: cancelError } =
      await supabaseAdmin
        .from('subscriptions')
        .update({
          status: 'cancelled',
        })
        .eq('client_id', user.id)

    if (cancelError) {
      return new Response(
        JSON.stringify({
          error: cancelError.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    await supabaseAdmin
      .from('agents')
      .update({
        status: 'paused',
      })
      .eq('client_id', user.id)

    await supabaseAdmin
      .from('clients')
      .update({
        status: 'paused',
      })
      .eq('id', user.id)

    return new Response(
      JSON.stringify({
        success: true,
        status: 'cancelled',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Update subscription error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected server error.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
