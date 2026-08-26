

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

    const {
      clientId,
      retellAgentId,
    } = await request.json()

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

    const normalizedRetellId =
      typeof retellAgentId === 'string' &&
      retellAgentId.trim()
        ? retellAgentId.trim()
        : null

    if (
      normalizedRetellId &&
      !normalizedRetellId.startsWith(
        'agent_'
      )
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Retell Agent ID must start with agent_.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { error } =
      await supabaseAdmin
        .from('agents')
        .update({
          retell_agent_id:
            normalizedRetellId,
        })
        .eq('client_id', clientId)

    if (error) throw error

    return new Response(
      JSON.stringify({
        success: true,
        retellAgentId:
          normalizedRetellId,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not save Retell Agent ID.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
