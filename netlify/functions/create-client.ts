import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

type PlanName =
  | 'Recepta Standard'
  | 'Recepta Pro'

const ADMIN_EMAIL =
  (process.env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase()

const isAdminUser = (
  user: { email?: string | null }
) => {
  if (!ADMIN_EMAIL) {
    return false
  }

  return (
    user.email
      ?.trim()
      .toLowerCase() ===
    ADMIN_EMAIL
  )
}

export default async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        error: 'Method not allowed',
      }),
      {
        status: 405,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  }

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL
    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY
    const stripeSecretKey =
      process.env.STRIPE_SECRET_KEY

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !stripeSecretKey ||
      !ADMIN_EMAIL
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Server configuration is missing.',
        }),
        {
          status: 500,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const authHeader =
      request.headers.get(
        'authorization'
      )

    if (
      !authHeader?.startsWith(
        'Bearer '
      )
    ) {
      return new Response(
        JSON.stringify({
          error: 'Unauthorized',
        }),
        {
          status: 401,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const accessToken =
      authHeader.replace(
        'Bearer ',
        ''
      )

    const supabaseAdmin =
      createClient(
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
      !isAdminUser(user)
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Admin access required',
        }),
        {
          status: 403,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const {
      companyName,
      email,
      password,
      planName,
      monthlyMinutes,
      aiModelId,
      retellAgentId,
    } = await request.json()

    if (
      !companyName ||
      !email ||
      !password
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Company name, email and password are required.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const validPlans: PlanName[] = [
      'Recepta Standard',
      'Recepta Pro',
    ]

    if (
      !validPlans.includes(
        planName as PlanName
      )
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Choose Standard or Pro.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const minutes =
      Number(monthlyMinutes)

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
          headers: {
            'Content-Type':
              'application/json',
          },
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

    if (
      modelError ||
      !model
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Choose a valid active AI model.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const normalizedRetellId =
      typeof retellAgentId ===
        'string' &&
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
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const normalizedEmail =
      String(email)
        .trim()
        .toLowerCase()

    const normalizedCompany =
      String(companyName).trim()

    const {
      data: { user: newUser },
      error: createUserError,
    } =
      await supabaseAdmin
        .auth.admin
        .createUser({
          email: normalizedEmail,
          password,
          email_confirm: true,
        })

    if (
      createUserError ||
      !newUser
    ) {
      return new Response(
        JSON.stringify({
          error:
            createUserError?.message ||
            'Could not create user.',
        }),
        {
          status: 400,
          headers: {
            'Content-Type':
              'application/json',
          },
        }
      )
    }

    const stripe =
      new Stripe(stripeSecretKey)

    let stripeCustomerId:
      | string
      | null = null

    const rollback = async () => {
      await supabaseAdmin
        .from('subscriptions')
        .delete()
        .eq(
          'client_id',
          newUser.id
        )

      await supabaseAdmin
        .from('agents')
        .delete()
        .eq(
          'client_id',
          newUser.id
        )

      await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', newUser.id)

      if (stripeCustomerId) {
        try {
          await stripe.customers.del(
            stripeCustomerId
          )
        } catch {
          // Best effort rollback.
        }
      }

      await supabaseAdmin
        .auth.admin
        .deleteUser(newUser.id)
    }

    try {
      const customer =
        await stripe.customers.create({
          email: normalizedEmail,
          name: normalizedCompany,
          metadata: {
            recepta_client_id:
              newUser.id,
            recepta_plan:
              String(planName),
          },
        })

      stripeCustomerId =
        customer.id
    } catch (error) {
      await rollback()

      throw new Error(
        error instanceof Error
          ? `Stripe customer creation failed: ${error.message}`
          : 'Stripe customer creation failed.'
      )
    }

    const {
      error: clientError,
    } =
      await supabaseAdmin
        .from('clients')
        .insert({
          id: newUser.id,
          company_name:
            normalizedCompany,
          contact_email:
            normalizedEmail,
          status: 'setup',
          role: 'client',
        })

    if (clientError) {
      await rollback()
      throw clientError
    }

    const {
      error: agentError,
    } =
      await supabaseAdmin
        .from('agents')
        .insert({
          client_id:
            newUser.id,
          agent_name:
            `${normalizedCompany} Receptionist`,
          business_hours:
            'Not configured',
          status: 'setup',
          retell_agent_id:
            normalizedRetellId,
        })

    if (agentError) {
      await rollback()
      throw agentError
    }

    const monthlyPrice =
      planName ===
      'Recepta Pro'
        ? 300
        : 200

    const {
      error:
        subscriptionError,
    } =
      await supabaseAdmin
        .from('subscriptions')
        .insert({
          client_id:
            newUser.id,
          plan_name: planName,
          monthly_price:
            monthlyPrice,
          monthly_minutes:
            Math.floor(minutes),
          ai_model_id:
            aiModelId,
          status: 'active',
          stripe_customer_id:
            stripeCustomerId,
          stripe_subscription_id:
            null,
        })

    if (subscriptionError) {
      await rollback()
      throw subscriptionError
    }

    return new Response(
      JSON.stringify({
        success: true,
        userId: newUser.id,
        stripeCustomerId,
        subscription: {
          status: 'active',
          planName,
          monthlyPrice,
          monthlyMinutes:
            Math.floor(minutes),
          aiModelId,
        },
        aiConfigurationStatus:
          'pending',
      }),
      {
        status: 200,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  } catch (error) {
    console.error(
      'Create client error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Unexpected server error.',
      }),
      {
        status: 500,
        headers: {
          'Content-Type':
            'application/json',
        },
      }
    )
  }
}
