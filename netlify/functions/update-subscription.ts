import { createClient } from '@supabase/supabase-js'

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Method not allowed',
      }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  }

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY

    if (
      !supabaseUrl ||
      !supabaseSecretKey
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

    const adminSupabase =
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
      await adminSupabase.auth.getUser(
        accessToken
      )

    if (
      userError ||
      !user
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

    const body =
      await request.json()

    const { action } = body

    /*
     * CUSTOMER MAY ONLY CANCEL
     *
     * Plan changes, AI-model changes,
     * minute changes and activation
     * are NOT allowed through this
     * endpoint anymore.
     */

    if (
      action !== 'cancel'
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Subscription changes must be completed through Recepta billing.',
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

    /*
     * Find current subscription first.
     */

    const {
      data: subscription,
      error: subscriptionError,
    } =
      await adminSupabase
        .from('subscriptions')
        .select(
          `
          client_id,
          status,
          stripe_subscription_id
          `
        )
        .eq(
          'client_id',
          user.id
        )
        .maybeSingle()

    if (
      subscriptionError
    ) {
      return new Response(
        JSON.stringify({
          error:
            subscriptionError.message,
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

    if (!subscription) {
      return new Response(
        JSON.stringify({
          error:
            'No subscription found.',
        }),
        {
          status: 404,
          headers: {
            'Content-Type':
              'application/json',
          },
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
          message:
            'Subscription is already cancelled.',
        }),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    /*
     * IMPORTANT:
     *
     * Until Stripe is connected,
     * cancellation is stored directly
     * in Supabase.
     *
     * Once Stripe is live, we will
     * cancel the Stripe subscription
     * first and let the Stripe webhook
     * update this database status.
     */

    const { error: cancelError } =
      await adminSupabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
        })
        .eq(
          'client_id',
          user.id
        )

    if (cancelError) {
      return new Response(
        JSON.stringify({
          error:
            cancelError.message,
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

    /*
     * Also pause the client's
     * receptionist so a cancelled
     * customer is not left with a
     * live agent.
     */

    const { error: agentError } =
      await adminSupabase
        .from('agents')
        .update({
          status: 'paused',
        })
        .eq(
          'client_id',
          user.id
        )

    if (agentError) {
      console.error(
        'Could not pause agent:',
        agentError
      )
    }

    const { error: clientError } =
      await adminSupabase
        .from('clients')
        .update({
          status: 'paused',
        })
        .eq(
          'id',
          user.id
        )

    if (clientError) {
      console.error(
        'Could not pause client:',
        clientError
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: 'cancelled',
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
      'Update subscription error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          'Unexpected server error.',
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
