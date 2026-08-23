import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase server environment variables')
}

const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey
)

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({
        error: 'Method not allowed',
      }),
    }
  }

  try {
    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization

    if (!authHeader?.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          error: 'Unauthorized',
        }),
      }
    }

    const accessToken =
      authHeader.replace('Bearer ', '')

    const {
      data: { user: requestingUser },
      error: userError,
    } = await supabaseAdmin.auth.getUser(accessToken)

    if (userError || !requestingUser) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          error: 'Invalid session',
        }),
      }
    }

    const { data: adminRecord } =
      await supabaseAdmin
        .from('admins')
        .select('id')
        .eq('id', requestingUser.id)
        .maybeSingle()

    if (!adminRecord) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: 'Admin access required',
        }),
      }
    }

    const body = JSON.parse(event.body || '{}')
    const clientId = body.clientId

    if (!clientId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Client ID is required',
        }),
      }
    }

    if (clientId === requestingUser.id) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'You cannot delete your own admin account',
        }),
      }
    }

    /*
      Your foreign keys should cascade from clients
      into related records such as:
      agents
      subscriptions
      onboarding
      calls
      appointments
      employees
      schedules
      overrides
    */

    const { error: clientDeleteError } =
      await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', clientId)

    if (clientDeleteError) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: clientDeleteError.message,
        }),
      }
    }

    const { error: authDeleteError } =
      await supabaseAdmin.auth.admin.deleteUser(
        clientId
      )

    if (authDeleteError) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error:
            'Client data deleted, but auth user could not be deleted: ' +
            authDeleteError.message,
        }),
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
      }),
    }
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not delete client',
      }),
    }
  }
}
