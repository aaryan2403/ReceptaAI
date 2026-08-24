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
    } = await adminSupabase.auth.getUser(
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

    const body = await request.json()

    const {
      action,
      planName,
      aiModel,
      includedMinutes,
    } = body

    const allowedPlans = [
      'Recepta Standard',
      'Recepta Pro',
    ]

    const allowedModels = [
      'gpt-4.1-mini',
      'gpt-4.1',
      'claude-sonnet-4',
      'gemini-2.5-flash',
    ]

    const allowedMinutes = [
      100,
      250,
      500,
      1000,
    ]

    /*
     * CANCEL SUBSCRIPTION
     */
    if (action === 'cancel') {
      const { error } = await adminSupabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
        })
        .eq('client_id', user.id)

      if (error) {
        return new Response(
          JSON.stringify({
            error: error.message,
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

    /*
     * CREATE / CHANGE SUBSCRIPTION
     */
    if (!allowedPlans.includes(planName)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid plan.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (!allowedModels.includes(aiModel)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid AI model.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (!allowedMinutes.includes(includedMinutes)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid minute package.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const monthlyPrice =
      planName === 'Recepta Pro'
        ? 300
        : 200

    const {
      data: existingSubscription,
      error: existingError,
    } = await adminSupabase
      .from('subscriptions')
      .select('client_id')
      .eq('client_id', user.id)
      .maybeSingle()

    if (existingError) {
      return new Response(
        JSON.stringify({
          error: existingError.message,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (existingSubscription) {
      const { error } = await adminSupabase
        .from('subscriptions')
        .update({
          plan_name: planName,
          monthly_price: monthlyPrice,
          ai_model: aiModel,
          included_minutes: includedMinutes,
          status: 'active',
        })
        .eq('client_id', user.id)

      if (error) {
        return new Response(
          JSON.stringify({
            error: error.message,
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
      const { error } = await adminSupabase
        .from('subscriptions')
        .insert({
          client_id: user.id,
          plan_name: planName,
          monthly_price: monthlyPrice,
          ai_model: aiModel,
          included_minutes: includedMinutes,
          status: 'active',
        })

      if (error) {
        return new Response(
          JSON.stringify({
            error: error.message,
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
        planName,
        monthlyPrice,
        aiModel,
        includedMinutes,
        status: 'active',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
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
