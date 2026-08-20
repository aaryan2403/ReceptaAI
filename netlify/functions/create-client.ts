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

    const authHeader = request.headers.get('authorization')

    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const accessToken = authHeader.replace('Bearer ', '')

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
    } = await adminSupabase.auth.getUser(accessToken)

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { data: requester, error: roleError } =
      await adminSupabase
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
        JSON.stringify({ error: 'Admin access required' }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

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

    const {
      data: { user: newUser },
      error: createUserError,
    } = await adminSupabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (createUserError || !newUser) {
      return new Response(
        JSON.stringify({
          error:
            createUserError?.message ||
            'Could not create user.',
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
        id: newUser.id,
        company_name: companyName,
        contact_email: email,
        status: 'setup',
        role: 'client',
      })

    if (clientError) {
      await adminSupabase.auth.admin.deleteUser(newUser.id)

      return new Response(
        JSON.stringify({ error: clientError.message }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { error: agentError } = await adminSupabase
      .from('agents')
      .insert({
        client_id: newUser.id,
        agent_name: `${companyName} Receptionist`,
        business_hours: 'Not configured',
        status: 'setup',
      })

    if (agentError) {
      return new Response(
        JSON.stringify({ error: agentError.message }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (planName && monthlyPrice) {
      const { error: subscriptionError } =
        await adminSupabase
          .from('subscriptions')
          .insert({
            client_id: newUser.id,
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
        userId: newUser.id,
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
