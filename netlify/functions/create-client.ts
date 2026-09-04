import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import {
  purchaseRetellPhoneNumber,
  releaseRetellPhoneNumber,
  syncRetellSchedule,
  syncRetellSubscription,
} from '../lib/retell'
import { loadClientScheduleContext } from '../lib/employeeSchedule'
import {
  MAX_TOTAL_PHONE_NUMBERS,
  normalizePhoneNumberList,
  normalizePhonePurchase,
} from '../lib/phoneNumbers'
import {
  calculateMonthlyPriceCad,
  MAX_MONTHLY_MINUTES,
} from '../lib/pricing'

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
    const retellApiKey =
      process.env.RETELL_API_KEY

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
      phoneNumber,
      phoneNumbers,
      purchasePhoneNumbers,
      phoneCountryCode,
      phoneAreaCode,
      piiRedactionEnabled,
      safetyGuardrailsEnabled,
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
      minutes < 1 ||
      minutes > MAX_MONTHLY_MINUTES
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Monthly minutes must be between 1 and 100,000,000.',
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
        .select(
          'id, customer_price_per_minute_cad'
        )
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

    const normalizedPhoneList = normalizePhoneNumberList(
      phoneNumbers ?? phoneNumber
    )

    if (normalizedPhoneList.invalid.length > 0) {
      return new Response(
        JSON.stringify({
          error:
            `Every phone number must include its country code, for example +14165550123. Invalid: ${normalizedPhoneList.invalid.join(', ')}`,
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

    let phonePurchase: ReturnType<typeof normalizePhonePurchase>

    try {
      phonePurchase = normalizePhonePurchase({
        count: purchasePhoneNumbers,
        countryCode: phoneCountryCode,
        areaCode: phoneAreaCode,
      })
    } catch (error) {
      return new Response(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : 'Invalid phone-number purchase request.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const requestedPhoneNumberTotal =
      normalizedPhoneList.phoneNumbers.length +
      phonePurchase.purchaseCount

    if (requestedPhoneNumberTotal > MAX_TOTAL_PHONE_NUMBERS) {
      return new Response(
        JSON.stringify({
          error: `A client can have at most ${MAX_TOTAL_PHONE_NUMBERS} phone numbers, including the primary number.`,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

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

    if (
      phonePurchase.purchaseCount > 0 &&
      (!normalizedRetellId || !retellApiKey)
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Assign a valid Retell Agent ID and configure RETELL_API_KEY before purchasing phone numbers.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (
      normalizedRetellId &&
      !retellApiKey
    ) {
      return new Response(
        JSON.stringify({
          error: 'RETELL_API_KEY is missing.',
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
    const purchasedPhoneNumbers: string[] = []

    const rollback = async () => {
      if (retellApiKey) {
        for (const purchasedPhoneNumber of purchasedPhoneNumbers) {
          try {
            await releaseRetellPhoneNumber({
              apiKey: retellApiKey,
              phoneNumber: purchasedPhoneNumber,
            })
          } catch {
            // Best effort rollback for externally purchased numbers.
          }
        }
      }

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
          status: normalizedRetellId
            ? 'live'
            : 'setup',
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
          phone_number:
            normalizedPhoneList.phoneNumbers[0] ?? null,
          status: normalizedRetellId
            ? 'live'
            : 'setup',
          retell_agent_id:
            normalizedRetellId,
        })

    if (agentError) {
      await rollback()
      throw agentError
    }

    const piiEnabled =
      piiRedactionEnabled === true
    const guardrailsEnabled =
      safetyGuardrailsEnabled === true
    const modelMinutePrice = Number(
      model.customer_price_per_minute_cad
    )

    if (
      !Number.isFinite(modelMinutePrice) ||
      modelMinutePrice < 0
    ) {
      await rollback()
      throw new Error(
        'The selected AI model has invalid pricing.'
      )
    }

    const monthlyPrice =
      calculateMonthlyPriceCad({
        planName,
        monthlyMinutes: minutes,
        modelPricePerMinuteCad:
          modelMinutePrice,
        piiRedactionEnabled: piiEnabled,
        safetyGuardrailsEnabled:
          guardrailsEnabled,
        extraPhoneNumbers: Math.max(
          0,
          requestedPhoneNumberTotal - 1
        ),
      })

    const periodStart = new Date()
    const periodEnd = new Date(periodStart)
    periodEnd.setUTCMonth(
      periodEnd.getUTCMonth() + 1
    )

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
          pii_redaction_enabled:
            piiEnabled,
          safety_guardrails_enabled:
            guardrailsEnabled,
          extra_phone_numbers: Math.max(
            0,
            requestedPhoneNumberTotal - 1
          ),
          status: 'active',
          current_period_start:
            periodStart.toISOString(),
          current_period_end:
            periodEnd.toISOString(),
          next_billing_date:
            periodEnd.toISOString(),
          stripe_customer_id:
            stripeCustomerId,
          stripe_subscription_id:
            null,
        })

    if (subscriptionError) {
      await rollback()
      throw subscriptionError
    }

    if (
      phonePurchase.purchaseCount > 0 &&
      normalizedRetellId &&
      retellApiKey
    ) {
      try {
        for (
          let index = 0;
          index < phonePurchase.purchaseCount;
          index += 1
        ) {
          const purchasedPhoneNumber =
            await purchaseRetellPhoneNumber({
              apiKey: retellApiKey,
              agentId: normalizedRetellId,
              countryCode: phonePurchase.countryCode,
              areaCode: phonePurchase.areaCode,
              nickname: `${normalizedCompany} ${
                normalizedPhoneList.phoneNumbers.length + index + 1
              }`,
            })

          purchasedPhoneNumbers.push(purchasedPhoneNumber)
        }
      } catch (error) {
        await rollback()
        throw new Error(
          error instanceof Error
            ? `Retell phone-number purchase failed: ${error.message}`
            : 'Retell phone-number purchase failed.'
        )
      }
    }

    const allPhoneNumbers = Array.from(
      new Set([
        ...normalizedPhoneList.phoneNumbers,
        ...purchasedPhoneNumbers,
      ])
    )

    if (allPhoneNumbers.length > 0) {
      const { error: phoneNumbersError } = await supabaseAdmin
        .from('agent_phone_numbers')
        .insert(
          allPhoneNumbers.map((assignedPhoneNumber, index) => ({
            client_id: newUser.id,
            phone_number: assignedPhoneNumber,
            is_primary: index === 0,
            source: purchasedPhoneNumbers.includes(assignedPhoneNumber)
              ? 'retell'
              : 'manual',
          }))
        )

      if (phoneNumbersError) {
        await rollback()
        throw phoneNumbersError
      }

      const { error: primaryPhoneError } = await supabaseAdmin
        .from('agents')
        .update({ phone_number: allPhoneNumbers[0] })
        .eq('client_id', newUser.id)

      if (primaryPhoneError) {
        await rollback()
        throw primaryPhoneError
      }
    }

    if (
      normalizedRetellId &&
      retellApiKey
    ) {
      try {
        await syncRetellSubscription({
          apiKey: retellApiKey,
          agentId: normalizedRetellId,
          phoneNumber:
            allPhoneNumbers[0] ?? null,
          phoneNumbers: allPhoneNumbers,
          active: true,
          piiRedactionEnabled: piiEnabled,
          safetyGuardrailsEnabled:
            guardrailsEnabled,
          aiModelId,
        })

        const scheduleContext = await loadClientScheduleContext({
          supabase: supabaseAdmin,
          clientId: newUser.id,
          businessHours: 'Not configured',
        })

        await syncRetellSchedule({
          apiKey: retellApiKey,
          agentId: normalizedRetellId,
          ...scheduleContext,
        })
      } catch (error) {
        await rollback()

        throw new Error(
          error instanceof Error
            ? `Retell setup failed: ${error.message}`
            : 'Retell setup failed.'
        )
      }
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
          piiRedactionEnabled: piiEnabled,
          safetyGuardrailsEnabled:
            guardrailsEnabled,
          phoneNumbers: allPhoneNumbers,
        },
        aiConfigurationStatus:
          normalizedRetellId
            ? 'live'
            : 'pending',
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
