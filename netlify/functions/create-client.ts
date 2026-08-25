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

    /*
      Verify the person calling this function
      is actually logged in.
    */

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

    /*
      Verify the logged-in user is a Recepta admin.
    */

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
        JSON.stringify({
          error: 'Admin access required',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    /*
      A new client ONLY needs:
      - company name
      - email
      - temporary password

      No plan is chosen here.
      No AI model is chosen here.
      No minutes are chosen here.
    */

    const body = await request.json()

    const {
      companyName,
      email,
      password,
    } = body

    if (!companyName || !email || !password) {
      return new Response(
        JSON.stringify({
          error:
            'Company name, email, and password are required.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    /*
      Create Supabase Auth account.
    */

    const {
      data: { user: newUser },
      error: createUserError,
    } = await adminSupabase.auth.admin.createUser({
      email: email.trim().toLowerCase(),
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

    /*
      Create the client record.

      "setup" means they exist but have
      not been activated yet.
    */

    const { error: clientError } = await adminSupabase
      .from('clients')
      .insert({
        id: newUser.id,
        company_name: companyName.trim(),
        contact_email: email.trim().toLowerCase(),
        status: 'setup',
        role: 'client',
      })

    if (clientError) {
      await adminSupabase.auth.admin.deleteUser(newUser.id)

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

    /*
      Create the agent shell.

      The real AI receptionist will be
      configured later during onboarding.
    */

    const { error: agentError } = await adminSupabase
      .from('agents')
      .insert({
        client_id: newUser.id,
        agent_name: `${companyName.trim()} Receptionist`,
        business_hours: 'Not configured',
        status: 'setup',
      })

    if (agentError) {
      /*
        Roll everything back so we don't
        leave a half-created customer.
      */

      await adminSupabase
        .from('clients')
        .delete()
        .eq('id', newUser.id)

      await adminSupabase.auth.admin.deleteUser(newUser.id)

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

    /*
      Create a BLANK subscription.

      Important:
      - pending
      - no plan
      - no price
      - no AI model
      - no monthly minutes

      Admin activates this later.
    */

    const { error: subscriptionError } =
      await adminSupabase
        .from('subscriptions')
        .insert({
          client_id: newUser.id,
          plan_name: null,
          monthly_price: null,
          monthly_minutes: null,
          ai_model_id: null,
          status: 'pending',
        })

    if (subscriptionError) {
      /*
        Roll back everything if subscription
        creation fails.
      */

      await adminSupabase
        .from('agents')
        .delete()
        .eq('client_id', newUser.id)

      await adminSupabase
        .from('clients')
        .delete()
        .eq('id', newUser.id)

      await adminSupabase.auth.admin.deleteUser(newUser.id)

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

    return new Response(
      JSON.stringify({
        success: true,
        userId: newUser.id,
        subscriptionStatus: 'pending',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Create client error:', error)

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
