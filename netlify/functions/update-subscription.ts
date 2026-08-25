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

  const supabaseUrl =
    process.env.SUPABASE_URL
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY
  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY
  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !stripeSecretKey ||
    !webhookSecret
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

  const signature =
    request.headers.get('stripe-signature')

  if (!signature) {
    return new Response(
      JSON.stringify({
        error: 'Missing Stripe signature.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  try {
    const stripe =
      new Stripe(stripeSecretKey)

    const rawBody =
      await request.text()

    const event =
      stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret
      )

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

    if (
      event.type ===
      'checkout.session.completed'
    ) {
      const session =
        event.data.object as
          Stripe.Checkout.Session

      if (session.mode === 'subscription') {
        const clientId =
          session.metadata?.client_id
        const planName =
          session.metadata?.plan_name
        const aiModelId =
          session.metadata?.ai_model_id
        const monthlyMinutes =
          Number(
            session.metadata
              ?.monthly_minutes
          )
        const basePrice =
          Number(
            session.metadata
              ?.base_price_cad
          )

        const subscriptionId =
          typeof session.subscription ===
          'string'
            ? session.subscription
            : session.subscription?.id

        const customerId =
          typeof session.customer ===
          'string'
            ? session.customer
            : session.customer?.id

        if (
          clientId &&
          planName &&
          aiModelId &&
          Number.isFinite(monthlyMinutes) &&
          monthlyMinutes > 0 &&
          Number.isFinite(basePrice)
        ) {
          const {
            error: updateError,
          } = await supabaseAdmin
            .from('subscriptions')
            .update({
              plan_name: planName,
              monthly_price: basePrice,
              monthly_minutes:
                Math.floor(
                  monthlyMinutes
                ),
              ai_model_id: aiModelId,
              status: 'active',
              stripe_subscription_id:
                subscriptionId || null,
              stripe_customer_id:
                customerId || null,
            })
            .eq(
              'client_id',
              clientId
            )

          if (updateError) {
            throw updateError
          }
        }
      }
    }

    if (
      event.type ===
      'customer.subscription.deleted'
    ) {
      const subscription =
        event.data.object as
          Stripe.Subscription

      const { error } =
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: 'cancelled',
          })
          .eq(
            'stripe_subscription_id',
            subscription.id
          )

      if (error) {
        throw error
      }
    }

    if (
      event.type ===
      'invoice.payment_failed'
    ) {
      const invoice =
        event.data.object as unknown as {
          subscription?:
            | string
            | { id?: string }
            | null
        }

      const subscriptionId =
        typeof invoice.subscription ===
        'string'
          ? invoice.subscription
          : invoice.subscription?.id

      if (subscriptionId) {
        const { error } =
          await supabaseAdmin
            .from('subscriptions')
            .update({
              status: 'past_due',
            })
            .eq(
              'stripe_subscription_id',
              subscriptionId
            )

        if (error) {
          throw error
        }
      }
    }

    return new Response(
      JSON.stringify({ received: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Stripe webhook error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Webhook processing failed.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
