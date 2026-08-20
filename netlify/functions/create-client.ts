import { createClient } from '@supabase/supabase-js'

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
    const body = await request.json()

    const {
      companyName,
      email,
      password,
      planName,
      monthlyPrice,
    } = body

    if (!companyName || !email || !password) {
      return new Response(
        JSON.stringify({
          error: 'Company name, email, and password are required.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY

    if (!supabaseUrl || !supabaseSecretKey) {
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
    } = await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (userError || !user) {
      return new Response(
        JSON.stringify({
          error: userError?.message || 'Could not create user.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { error: clientError } = await adminSupabase
      .from('clients')
      .insert({
        id: user.id,
        company_name: companyName,
        contact_email: email,
        status: 'setup',
        role: 'client',
      })

    if (clientError) {
      await adminSupabase.auth.admin.deleteUser(user.id)

      return new Response(
        JSON.stringify({
          error: clientError.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { error: agentError } = await adminSupabase
      .from('agents')
      .insert({
        client_id: user.id,
        agent_name: `${companyName} Receptionist`,
        business_hours: 'Not configured',
        status: 'setup',
      })

    if (agentError) {
      return new Response(
        JSON.stringify({
          error: agentError.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (planName && monthlyPrice) {
      const { error: subscriptionError } = await adminSupabase
        .from('subscriptions')
        .insert({
          client_id: user.id,
          plan_name: planName,
          monthly_price: monthlyPrice,
          status: 'pending',
        })

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
    }

    return new Response(
      JSON.stringify({
        success: true,
        userId: user.id,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch {
    return new Response(
      JSON.stringify({
        error: 'Unexpected server error.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
