import { createClient } from '@supabase/supabase-js'

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY

    if (!supabaseUrl || !supabaseSecretKey) {
      return new Response(
        JSON.stringify({
          error: 'Server configuration is missing.',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const authHeader =
      request.headers.get('authorization')

    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({
          error: 'Unauthorized',
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const accessToken =
      authHeader.replace('Bearer ', '')

    const adminSupabase = createClient(
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

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          error: 'Unauthorized',
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const {
      data: requester,
      error: roleError,
    } = await adminSupabase
      .from('clients')
      .select('role')
      .eq('id', user.id)
      .single()

    if (
      roleError ||
      !requester ||
      requester.role !== 'admin'
    ) {
      return new Response(
        JSON.stringify({
          error: 'Admin access required',
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const body = await request.json()

    const {
      clientId,
      action,
    } = body

    if (!clientId || !action) {
      return new Response(
        JSON.stringify({
          error:
            'Client ID and action are required.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const allowedActions = [
      'standard',
      'pro',
      'cancel',
    ]

    if (!allowedActions.includes(action)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid subscription action.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (action === 'cancel') {
      const {
        error: cancelError,
      } = await adminSupabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
        })
        .eq('client_id', clientId)

      if (cancelError) {
        return new Response(
          JSON.stringify({
            error: cancelError.message,
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
    }

    const plan =
      action === 'pro'
        ? {
            name: 'Recepta Pro',
            price: 300,
          }
        : {
            name: 'Recepta Standard',
            price: 200,
          }

    const {
      data: existingSubscription,
      error: existingError,
    } = await adminSupabase
      .from('subscriptions')
      .select('client_id')
      .eq('client_id', clientId)
      .maybeSingle()

    if (existingError) {
      return new Response(
        JSON.stringify({
          error: existingError.message,
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

    if (existingSubscription) {
      const {
        error: updateError,
      } = await adminSupabase
        .from('subscriptions')
        .update({
          plan_name: plan.name,
          monthly_price: plan.price,
          status: 'active',
        })
        .eq('client_id', clientId)

      if (updateError) {
        return new Response(
          JSON.stringify({
            error: updateError.message,
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
    } else {
      const {
        error: insertError,
      } = await adminSupabase
        .from('subscriptions')
        .insert({
          client_id: clientId,
          plan_name: plan.name,
          monthly_price: plan.price,
          status: 'active',
        })

      if (insertError) {
        return new Response(
          JSON.stringify({
            error: insertError.message,
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
    }

    return new Response(
      JSON.stringify({
        success: true,
        planName: plan.name,
        monthlyPrice: plan.price,
        status: 'active',
      }),
      {
        status: 200,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  } catch {
    return new Response(
      JSON.stringify({
        error: 'Unexpected server error.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  }
}
