import { createClient } from '@supabase/supabase-js'

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
  if (request.method !== 'GET') {
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

    const [
      clientsResult,
      subscriptionsResult,
      agentsResult,
      modelsResult,
    ] = await Promise.all([
      supabaseAdmin
        .from('clients')
        .select(
          'id, company_name, contact_email, created_at'
        )
        .order('created_at', {
          ascending: false,
        }),

      supabaseAdmin
        .from('subscriptions')
        .select(
          `
          client_id,
          plan_name,
          monthly_price,
          monthly_minutes,
          ai_model_id,
          pii_redaction_enabled,
          safety_guardrails_enabled,
          extra_phone_numbers,
          current_period_start,
          current_period_end,
          status
          `
        ),

      supabaseAdmin
        .from('agents')
        .select(
          'client_id, retell_agent_id, phone_number, status'
        ),

      supabaseAdmin
        .from('ai_models')
        .select(
          'id, display_name, provider, tier_name, sort_order, customer_price_per_minute_cad'
        )
        .eq('is_active', true),
    ])

    const queryError =
      clientsResult.error ||
      subscriptionsResult.error ||
      agentsResult.error ||
      modelsResult.error

    if (queryError) {
      return new Response(
        JSON.stringify({
          error: queryError.message,
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
        clients:
          (clientsResult.data || [])
            .filter(
              (client) =>
                client.contact_email
                  ?.trim()
                  .toLowerCase() !==
                ADMIN_EMAIL
            ),
        subscriptions:
          subscriptionsResult.data || [],
        agents:
          agentsResult.data || [],
        models:
          modelsResult.data || [],
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
      'Admin clients error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not load clients.',
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
