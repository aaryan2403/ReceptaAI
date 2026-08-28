import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

const ADMIN_EMAIL =
  (process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase()

const isAdminUser = (
  user: { email?: string | null }
) => {
  if (!ADMIN_EMAIL) {
    return false
  }

  return (
    user.email
      ?.trim()
      .toLowerCase() ===
    ADMIN_EMAIL
  )
}

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Method not allowed',
      }),
      {
        status: 405,
        headers: {
          'Content-Type':
            'application/json',
        },
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
      !supabaseSecretKey ||
      !ADMIN_EMAIL
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Server configuration is missing.',
        }),
        {
          status: 500,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const authHeader =
      request.headers.get(
        'authorization'
      )

    if (
      !authHeader?.startsWith(
        'Bearer '
      )
    ) {
      return new Response(
        JSON.stringify({
          error: 'Unauthorized',
        }),
        {
          status: 401,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const accessToken =
      authHeader.replace(
        'Bearer ',
        ''
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

    const {
      data: { user },
      error: userError,
    } =
      await supabaseAdmin.auth.getUser(
        accessToken
      )

    if (
      userError ||
      !user ||
      !isAdminUser(user)
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Admin access required',
        }),
        {
          status: 403,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const { clientId } =
      await request.json()

    if (!clientId) {
      return new Response(
        JSON.stringify({
          error:
            'Client ID is required.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const {
      data: subscription,
    } =
      await supabaseAdmin
        .from('subscriptions')
        .select(
          'stripe_subscription_id, stripe_customer_id'
        )
        .eq(
          'client_id',
          clientId
        )
        .maybeSingle()

    if (
      stripeSecretKey &&
      subscription
    ) {
      const stripe =
        new Stripe(
          stripeSecretKey
        )

      if (
        subscription
          .stripe_subscription_id
      ) {
        try {
          await stripe
            .subscriptions
            .cancel(
              subscription
                .stripe_subscription_id
            )
        } catch (error) {
          console.error(
            'Stripe subscription cleanup:',
            error
          )
        }
      }

      if (
        subscription
          .stripe_customer_id
      ) {
        try {
          await stripe
            .customers
            .del(
              subscription
                .stripe_customer_id
            )
        } catch (error) {
          console.error(
            'Stripe customer cleanup:',
            error
          )
        }
      }
    }

    const childTables = [
      'appointments',
      'calls',
      'employees',
      'onboarding',
      'subscriptions',
      'agents',
    ]

    for (
      const table of childTables
    ) {
      const { error } =
        await supabaseAdmin
          .from(table)
          .delete()
          .eq(
            'client_id',
            clientId
          )

      if (error) {
        console.error(
          `Could not clear ${table}:`,
          error.message
        )
      }
    }

    const {
      error: clientError,
    } =
      await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', clientId)

    if (clientError) {
      throw clientError
    }

    const {
      error: authError,
    } =
      await supabaseAdmin
        .auth.admin
        .deleteUser(clientId)

    if (authError) {
      throw authError
    }

    return new Response(
      JSON.stringify({
        success: true,
      }),
      {
        status: 200,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  } catch (error) {
    console.error(
      'Delete client error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not delete client.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  }
}
