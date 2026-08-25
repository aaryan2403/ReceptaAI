import { createClient } from '@supabase/supabase-js'

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Method not allowed',
      }),
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

    // Same admin check used by create-client.ts
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

    const clientId = body.clientId

    if (!clientId) {
      return new Response(
        JSON.stringify({
          error: 'Client ID is required',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (clientId === user.id) {
      return new Response(
        JSON.stringify({
          error:
            'You cannot delete your own admin account.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    /*
     * Delete client database record.
     * Related tables should use ON DELETE CASCADE.
     */
    const {
      error: clientDeleteError,
    } = await adminSupabase
      .from('clients')
      .delete()
      .eq('id', clientId)

    if (clientDeleteError) {
      return new Response(
        JSON.stringify({
          error: clientDeleteError.message,
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    /*
     * Delete their Supabase Auth login.
     */
    const {
      error: authDeleteError,
    } =
      await adminSupabase.auth.admin.deleteUser(
        clientId
      )

    if (authDeleteError) {
      return new Response(
        JSON.stringify({
          error:
            'Client record was deleted, but their login could not be deleted: ' +
            authDeleteError.message,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
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
            : 'Could not delete client.',
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
