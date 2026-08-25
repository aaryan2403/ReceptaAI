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
        JSON.stringify({ error: 'Unauthorized' }),
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
        JSON.stringify({ error: 'Unauthorized' }),
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
      planName,
      monthlyMinutes,
      aiModelId,
    } = body

    if (
      !clientId ||
      !planName ||
      !monthlyMinutes ||
      !aiModelId
    ) {
      return new Response(
        JSON.stringify({
          error: 'Missing subscription information.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (
      planName !== 'Recepta Standard' &&
      planName !== 'Recepta Pro'
    ) {
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
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const {
      data: model,
      error: modelError,
    } = await adminSupabase
      .from('ai_models')
      .select('id')
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
      error: subscriptionError,
    } = await adminSupabase
      .from('subscriptions')
      .upsert(
        {
          client_id: clientId,
          plan_name: planName,
          monthly_price: monthlyPrice,
          monthly_minutes: Math.floor(minutes),
          ai_model_id: aiModelId,
          status: 'active',
        },
        {
          onConflict: 'client_id',
        }
      )

    if (subscriptionError) {
      return new Response(
        JSON.stringify({
          error: subscriptionError.message,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        planName,
        monthlyPrice,
        monthlyMinutes: Math.floor(minutes),
        aiModelId,
        status: 'active',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected server error.',
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
