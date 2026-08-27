import { createClient } from '@supabase/supabase-js'

type PlanName =
  | 'Recepta Standard'
  | 'Recepta Pro'

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
      planName,
      monthlyMinutes,
      aiModelId,
    } = await request.json()

    const validPlans: PlanName[] = [
      'Recepta Standard',
      'Recepta Pro',
    ]

    if (
      !clientId ||
      !validPlans.includes(
        planName as PlanName
      )
    ) {
      return new Response(
        JSON.stringify({
          error: 'Client and valid plan are required.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const minutes = Number(monthlyMinutes)

    if (
      !Number.isFinite(minutes) ||
      minutes < 1
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Monthly minutes must be at least 1.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (!aiModelId) {
      return new Response(
        JSON.stringify({
          error: 'AI model is required.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const {
      data: model,
      error: modelError,
    } =
      await supabaseAdmin
        .from('ai_models')
        .select('id')
        .eq('id', aiModelId)
        .eq('is_active', true)
        .maybeSingle()

    if (modelError) throw modelError

    if (!model) {
      return new Response(
        JSON.stringify({
          error:
            'The selected AI model is not available.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const monthlyPrice =
      planName === 'Recepta Pro'
        ? 300
        : 200

    const values = {
      client_id: clientId,
      plan_name: planName,
      monthly_price: monthlyPrice,
      monthly_minutes:
        Math.floor(minutes),
      ai_model_id: aiModelId,
      status: 'active',
    }

    const {
      data: existing,
      error: existingError,
    } =
      await supabaseAdmin
        .from('subscriptions')
        .select('client_id')
        .eq('client_id', clientId)
        .limit(1)

    if (existingError) throw existingError

    if (existing?.length) {
      const { error } =
        await supabaseAdmin
          .from('subscriptions')
          .update(values)
          .eq('client_id', clientId)

      if (error) throw error
    } else {
      const { error } =
        await supabaseAdmin
          .from('subscriptions')
          .insert(values)

      if (error) throw error
    }

    const { error: clientError } =
      await supabaseAdmin
        .from('clients')
        .update({ status: 'setup' })
        .eq('id', clientId)

    if (clientError) throw clientError

    const { error: agentError } =
      await supabaseAdmin
        .from('agents')
        .update({ status: 'setup' })
        .eq('client_id', clientId)

    if (agentError) throw agentError

    return new Response(
      JSON.stringify({
        success: true,
        status: 'active',
        planName,
        monthlyPrice,
        monthlyMinutes:
          Math.floor(minutes),
        aiModelId,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Update client plan error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Could not update client.',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
