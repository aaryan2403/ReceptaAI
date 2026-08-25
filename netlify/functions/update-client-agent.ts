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
          headers: {
            'Content-Type': 'application/json',
          },
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
      !normalizedRetellId.startsWith('agent_')
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Retell Agent ID must start with agent_.',
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
      data: existingAgent,
      error: existingError,
    } = await adminSupabase
      .from('agents')
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
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (!existingAgent) {
      return new Response(
        JSON.stringify({
          error:
            'This client does not have an agent record.',
        }),
        {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    const { error: updateError } =
      await adminSupabase
        .from('agents')
        .update({
          retell_agent_id:
            normalizedRetellId,
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
            'Content-Type': 'application/json',
          },
        }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        retellAgentId:
          normalizedRetellId,
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
            : 'Could not save Retell Agent ID.',
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
