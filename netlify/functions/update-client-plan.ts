import { createClient } from '@supabase/supabase-js'

type PlanName =
  | 'Recepta Standard'
  | 'Recepta Pro'

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
    const supabaseUrl =
      process.env.SUPABASE_URL
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
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const {
      data: requester,
      error: roleError,
    } = await supabaseAdmin
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

    const {
      clientId,
      planName,
      monthlyMinutes,
      aiModelId,
    } = await request.json()

    if (!clientId) {
      return new Response(
        JSON.stringify({
          error: 'Client ID is required.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const validPlans: PlanName[] = [
      'Recepta Standard',
      'Recepta Pro',
    ]

    if (
      !validPlans.includes(
        planName as PlanName
      )
    ) {
      return new Response(
        JSON.stringify({
          error: 'Invalid Recepta plan.',
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
          error:
            'Monthly minutes must be at least 1.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (!aiModelId) {
      return new Response(
        JSON.stringify({
          error: 'AI model is required.',
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
    } = await supabaseAdmin
      .from('ai_models')
      .select('id, display_name, is_active')
      .eq('id', aiModelId)
      .eq('is_active', true)
      .maybeSingle()

    if (modelError || !model) {
      return new Response(
        JSON.stringify({
          error:
            'The selected AI model is not available.',
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

    const subscriptionValues = {
      client_id: clientId,
      plan_name: planName,
      monthly_price: monthlyPrice,
      monthly_minutes: Math.floor(minutes),
      ai_model_id: aiModelId,
      status: 'active',
    }

    /*
      Do NOT use upsert(... onConflict: 'client_id') here.
      Older Recepta databases may not yet have a UNIQUE
      constraint on subscriptions.client_id.

      We check first, then UPDATE or INSERT. This removes
      the "no unique or exclusion constraint matching the
      ON CONFLICT specification" failure entirely.
    */
    const {
      data: existingRows,
      error: existingError,
    } = await supabaseAdmin
      .from('subscriptions')
      .select('client_id')
      .eq('client_id', clientId)
      .limit(1)

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

    if (
      existingRows &&
      existingRows.length > 0
    ) {
      const { error: updateError } =
        await supabaseAdmin
          .from('subscriptions')
          .update(subscriptionValues)
          .eq('client_id', clientId)

      if (updateError) {
        return new Response(
          JSON.stringify({
            error: updateError.message,
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }
    } else {
      const { error: insertError } =
        await supabaseAdmin
          .from('subscriptions')
          .insert(subscriptionValues)

      if (insertError) {
        return new Response(
          JSON.stringify({
            error: insertError.message,
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }
    }

    /*
      The account itself is ready immediately after the
      admin assigns plan/model/minutes. The AI agent stays
      in setup until Retell is actually connected/configured.
    */
    await supabaseAdmin
      .from('clients')
      .update({
        status: 'setup',
      })
      .eq('id', clientId)

    await supabaseAdmin
      .from('agents')
      .update({
        status: 'setup',
      })
      .eq('client_id', clientId)

    return new Response(
      JSON.stringify({
        success: true,
        subscription: {
          planName,
          monthlyPrice,
          monthlyMinutes: Math.floor(minutes),
          aiModelId,
          status: 'active',
        },
        aiConfigurationStatus:
          'pending',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    )
  } catch (error) {
    console.error(
      'Update client plan error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not update client.',
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
