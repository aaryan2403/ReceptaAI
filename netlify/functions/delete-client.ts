import { createClient } from '@supabase/supabase-js'

const ADMIN_EMAIL =
  (
    process.env.ADMIN_EMAIL ||
    'aaryansmg24@gmail.com'
  ).toLowerCase()

const isAdminUser = async (
  supabaseAdmin: any,
  user: { id: string; email?: string | null }
) => {
  const emailMatches =
    user.email?.toLowerCase() ===
    ADMIN_EMAIL

  const { data: requester } =
    await supabaseAdmin
      .from('clients')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

  return (
    emailMatches ||
    requester?.role === 'admin'
  )
}


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
          headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

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

    const accessToken =
      authHeader.replace('Bearer ', '')

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
      !(await isAdminUser(
        supabaseAdmin,
        user
      ))
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

    const { clientId } =
      await request.json()

    if (!clientId) {
      return new Response(
        JSON.stringify({
          error: 'Client ID is required.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Best-effort cleanup of known child rows.
    const childTables = [
      'appointments',
      'calls',
      'employees',
      'onboarding',
      'subscriptions',
      'agents',
    ]

    for (const table of childTables) {
      try {
        await supabaseAdmin
          .from(table)
          .delete()
          .eq('client_id', clientId)
      } catch {
        // Some installations may not use every table.
      }
    }

    const { error: clientError } =
      await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', clientId)

    if (clientError) throw clientError

    const { error: authError } =
      await supabaseAdmin.auth.admin
        .deleteUser(clientId)

    if (authError) throw authError

    return new Response(
      JSON.stringify({ success: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
