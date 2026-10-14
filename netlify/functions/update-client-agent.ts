import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertRetellAgentAvailable, syncRetellSubscription } from '../lib/retell'

const ADMIN_EMAIL =
  (
    process.env.ADMIN_EMAIL ||
    'aaryansmg24@gmail.com'
  ).toLowerCase()

const isAdminUser = async (
  supabaseAdmin: SupabaseClient,
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

    if (normalizedRetellId) {
      const retellApiKey =
        process.env.RETELL_API_KEY

      if (!retellApiKey) {
        return new Response(
          JSON.stringify({
            error: 'RETELL_API_KEY is missing.',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      try {
        await assertRetellAgentAvailable({
          apiKey: retellApiKey,
          agentId: normalizedRetellId,
        })
      } catch (error) {
        return new Response(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : 'Could not verify the Retell agent.',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }
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

    if (normalizedRetellId && process.env.RETELL_API_KEY) {
      const [agentResult, subscriptionResult] = await Promise.all([
        supabaseAdmin.from('agents').select('demo_mode').eq('client_id', clientId).maybeSingle(),
        supabaseAdmin.from('subscriptions').select('pii_redaction_enabled, safety_guardrails_enabled, ai_model_id').eq('client_id', clientId).maybeSingle(),
      ])
      if (agentResult.error) throw agentResult.error
      if (subscriptionResult.error) throw subscriptionResult.error
      await syncRetellSubscription({
        apiKey: process.env.RETELL_API_KEY, agentId: normalizedRetellId, active: true,
        demoMode: agentResult.data?.demo_mode === true,
        piiRedactionEnabled: subscriptionResult.data?.pii_redaction_enabled === true,
        safetyGuardrailsEnabled: subscriptionResult.data?.safety_guardrails_enabled === true,
        aiModelId: subscriptionResult.data?.ai_model_id,
      })
    }

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
