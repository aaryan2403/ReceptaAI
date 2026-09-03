import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import {
  releaseRetellPhoneNumber,
  syncRetellSubscription,
} from '../lib/retell'
import { calculateMonthlyPriceCad } from '../lib/pricing'

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
    const stripeSecretKey =
      process.env.STRIPE_SECRET_KEY
    const retellApiKey =
      process.env.RETELL_API_KEY

    if (
      !supabaseUrl ||
      !supabaseSecretKey
    ) {
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
    } = await supabaseAdmin.auth.getUser(
      accessToken
    )

    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const { action, aiModelId } =
      await request.json()

    if (
      action !== 'cancel' &&
      action !== 'change_model'
    ) {
      return new Response(
        JSON.stringify({
          error:
            'Unsupported subscription action.',
        }),
        {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const {
      data: subscription,
      error: subscriptionError,
    } = await supabaseAdmin
      .from('subscriptions')
      .select(
        `
        status,
        stripe_subscription_id,
        plan_name,
        monthly_price,
        monthly_minutes,
        ai_model_id,
        pii_redaction_enabled,
        safety_guardrails_enabled,
        extra_phone_numbers
        `
      )
      .eq('client_id', user.id)
      .maybeSingle()

    if (subscriptionError) {
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

    if (!subscription) {
      return new Response(
        JSON.stringify({
          error: 'No subscription found.',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (action === 'change_model') {
      if (subscription.status !== 'active') {
        return new Response(
          JSON.stringify({
            error:
              'Only an active subscription can change its AI model.',
          }),
          {
            status: 409,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      if (
        typeof aiModelId !== 'string' ||
        !aiModelId.trim()
      ) {
        return new Response(
          JSON.stringify({
            error: 'Choose an AI model.',
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const normalizedModelId =
        aiModelId.trim()

      const {
        data: selectedModel,
        error: modelError,
      } = await supabaseAdmin
        .from('ai_models')
        .select(
          'id, display_name, customer_price_per_minute_cad'
        )
        .eq('id', normalizedModelId)
        .eq('is_active', true)
        .maybeSingle()

      if (modelError || !selectedModel) {
        return new Response(
          JSON.stringify({
            error: 'Choose a valid active AI model.',
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const currentModelId =
        subscription.ai_model_id

      if (currentModelId === normalizedModelId) {
        return new Response(
          JSON.stringify({
            success: true,
            unchanged: true,
            aiModelId: normalizedModelId,
            monthlyPrice:
              subscription.monthly_price,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      if (
        subscription.plan_name !==
          'Recepta Standard' &&
        subscription.plan_name !== 'Recepta Pro'
      ) {
        return new Response(
          JSON.stringify({
            error:
              'The current Recepta plan is invalid.',
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const monthlyMinutes = Number(
        subscription.monthly_minutes
      )
      const modelPricePerMinuteCad = Number(
        selectedModel.customer_price_per_minute_cad
      )
      const extraPhoneNumbers = Math.max(
        0,
        Number(
          subscription.extra_phone_numbers ?? 0
        ) || 0
      )

      if (
        !Number.isFinite(monthlyMinutes) ||
        monthlyMinutes < 1 ||
        !Number.isFinite(
          modelPricePerMinuteCad
        ) ||
        modelPricePerMinuteCad < 0
      ) {
        return new Response(
          JSON.stringify({
            error:
              'The subscription or AI model pricing is invalid.',
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const monthlyPrice =
        calculateMonthlyPriceCad({
          planName: subscription.plan_name,
          monthlyMinutes,
          modelPricePerMinuteCad,
          piiRedactionEnabled:
            subscription.pii_redaction_enabled ===
            true,
          safetyGuardrailsEnabled:
            subscription.safety_guardrails_enabled ===
            true,
          extraPhoneNumbers,
        })

      const {
        data: assignedAgent,
        error: agentError,
      } = await supabaseAdmin
        .from('agents')
        .select(
          'retell_agent_id, phone_number'
        )
        .eq('client_id', user.id)
        .maybeSingle()

      if (agentError) {
        return new Response(
          JSON.stringify({
            error: agentError.message,
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      if (!assignedAgent?.retell_agent_id) {
        return new Response(
          JSON.stringify({
            error:
              'Your Retell agent has not been assigned yet.',
          }),
          {
            status: 409,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const { data: phoneRows, error: phoneRowsError } =
        await supabaseAdmin
          .from('agent_phone_numbers')
          .select('phone_number')
          .eq('client_id', user.id)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true })

      if (phoneRowsError) {
        return new Response(
          JSON.stringify({ error: phoneRowsError.message }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      const phoneNumbers = (phoneRows ?? []).map(
        (row) => row.phone_number
      )

      if (
        phoneNumbers.length === 0 &&
        assignedAgent.phone_number
      ) {
        phoneNumbers.push(assignedAgent.phone_number)
      }

      if (!retellApiKey) {
        return new Response(
          JSON.stringify({
            error: 'RETELL_API_KEY is missing.',
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const syncModel = async (
        modelId: string
      ) =>
        syncRetellSubscription({
          apiKey: retellApiKey,
          agentId:
            assignedAgent.retell_agent_id,
          phoneNumber:
            assignedAgent.phone_number,
          phoneNumbers,
          active: true,
          piiRedactionEnabled:
            subscription.pii_redaction_enabled ===
            true,
          safetyGuardrailsEnabled:
            subscription.safety_guardrails_enabled ===
            true,
          aiModelId: modelId,
        })

      try {
        await syncModel(normalizedModelId)
      } catch (error) {
        return new Response(
          JSON.stringify({
            error:
              error instanceof Error
                ? `Retell model change failed: ${error.message}`
                : 'Retell model change failed.',
          }),
          {
            status: 502,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      let stripeRollback:
        | {
            subscriptionId: string
            itemId: string
            oldPriceId: string
          }
        | null = null

      try {
        if (subscription.stripe_subscription_id) {
          if (!stripeSecretKey) {
            throw new Error(
              'STRIPE_SECRET_KEY is missing.'
            )
          }

          const stripe =
            new Stripe(stripeSecretKey)
          const stripeSubscription =
            await stripe.subscriptions.retrieve(
              subscription.stripe_subscription_id,
              {
                expand: [
                  'items.data.price.product',
                ],
              }
            )
          const subscriptionItem =
            stripeSubscription.items.data[0]

          if (!subscriptionItem) {
            throw new Error(
              'The Stripe subscription has no billing item.'
            )
          }

          const productReference =
            subscriptionItem.price.product
          const productId =
            typeof productReference === 'string'
              ? productReference
              : productReference.id

          const newPrice =
            await stripe.prices.create({
              currency: 'cad',
              unit_amount: Math.round(
                monthlyPrice * 100
              ),
              recurring: {
                interval: 'month',
              },
              product: productId,
              nickname:
                `${selectedModel.display_name} — Recepta monthly subscription`,
              metadata: {
                recepta_ai_model_id:
                  normalizedModelId,
                recepta_monthly_total_cad:
                  monthlyPrice.toFixed(2),
              },
            })

          await stripe.subscriptions.update(
            stripeSubscription.id,
            {
              items: [
                {
                  id: subscriptionItem.id,
                  price: newPrice.id,
                },
              ],
              proration_behavior: 'none',
              metadata: {
                ...stripeSubscription.metadata,
                ai_model_id:
                  normalizedModelId,
                ai_model_name:
                  selectedModel.display_name,
                monthly_total_cad:
                  monthlyPrice.toFixed(2),
              },
            }
          )

          stripeRollback = {
            subscriptionId:
              stripeSubscription.id,
            itemId: subscriptionItem.id,
            oldPriceId:
              subscriptionItem.price.id,
          }
        }
      } catch (error) {
        if (typeof currentModelId === 'string') {
          try {
            await syncModel(currentModelId)
          } catch (rollbackError) {
            console.error(
              'Retell model rollback failed:',
              rollbackError
            )
          }
        }

        return new Response(
          JSON.stringify({
            error:
              error instanceof Error
                ? `Billing update failed; the Retell model was restored: ${error.message}`
                : 'Billing update failed; the Retell model was restored.',
          }),
          {
            status: 502,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      }

      const { error: updateError } =
        await supabaseAdmin
          .from('subscriptions')
          .update({
            ai_model_id: normalizedModelId,
            monthly_price: monthlyPrice,
          })
          .eq('client_id', user.id)

      if (updateError) {
        if (typeof currentModelId === 'string') {
          try {
            await syncModel(currentModelId)
          } catch (rollbackError) {
            console.error(
              'Retell model rollback failed:',
              rollbackError
            )
          }
        }

        if (stripeRollback && stripeSecretKey) {
          try {
            const stripe =
              new Stripe(stripeSecretKey)

            await stripe.subscriptions.update(
              stripeRollback.subscriptionId,
              {
                items: [
                  {
                    id: stripeRollback.itemId,
                    price:
                      stripeRollback.oldPriceId,
                  },
                ],
                proration_behavior: 'none',
              }
            )
          } catch (rollbackError) {
            console.error(
              'Stripe model rollback failed:',
              rollbackError
            )
          }
        }

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
          aiModelId: normalizedModelId,
          aiModelName:
            selectedModel.display_name,
          monthlyPrice,
          stripeSubscriptionUpdated:
            Boolean(stripeRollback),
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    }

    if (
      subscription.status ===
      'cancelled'
    ) {
      return new Response(
        JSON.stringify({
          success: true,
          status: 'cancelled',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    if (
      subscription.stripe_subscription_id &&
      stripeSecretKey
    ) {
      const stripe =
        new Stripe(stripeSecretKey)

      await stripe.subscriptions.cancel(
        subscription.stripe_subscription_id
      )
    }

    const { error: cancelError } =
      await supabaseAdmin
        .from('subscriptions')
        .update({
          status: 'cancelled',
        })
        .eq('client_id', user.id)

    if (cancelError) {
      return new Response(
        JSON.stringify({
          error: cancelError.message,
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    const [agentPause, clientPause] =
      await Promise.all([
        supabaseAdmin
          .from('agents')
          .update({
            status: 'paused',
          })
          .eq('client_id', user.id),
        supabaseAdmin
          .from('clients')
          .update({
            status: 'paused',
          })
          .eq('id', user.id),
      ])

    if (agentPause.error) {
      throw agentPause.error
    }

    if (clientPause.error) {
      throw clientPause.error
    }

    const { data: assignedAgent } =
      await supabaseAdmin
        .from('agents')
        .select(
          'retell_agent_id, phone_number'
        )
        .eq('client_id', user.id)
        .maybeSingle()

    const { data: phoneRows, error: phoneRowsError } =
      await supabaseAdmin
        .from('agent_phone_numbers')
        .select('phone_number, source')
        .eq('client_id', user.id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })

    if (phoneRowsError) {
      throw phoneRowsError
    }

    const phoneNumbers = (phoneRows ?? []).map(
      (row) => row.phone_number
    )

    if (
      phoneNumbers.length === 0 &&
      assignedAgent?.phone_number
    ) {
      phoneNumbers.push(assignedAgent.phone_number)
    }

    let retellSyncWarning: string | null = null

    if (assignedAgent?.retell_agent_id) {
      if (!retellApiKey) {
        retellSyncWarning =
          'RETELL_API_KEY is missing.'
      } else {
        try {
          await syncRetellSubscription({
            apiKey: retellApiKey,
            agentId:
              assignedAgent.retell_agent_id,
            phoneNumber:
              assignedAgent.phone_number,
            phoneNumbers,
            active: false,
            piiRedactionEnabled: false,
            safetyGuardrailsEnabled: false,
          })
        } catch (error) {
          retellSyncWarning =
            error instanceof Error
              ? error.message
              : 'Retell cancellation sync failed.'

          console.error(
            'Retell cancellation sync error:',
            error
          )
        }
      }
    }

    if (
      !subscription.stripe_subscription_id &&
      retellApiKey
    ) {
      const purchasedRows = (phoneRows ?? []).filter(
        (row) => row.source === 'retell'
      )

      for (const row of purchasedRows) {
        try {
          await releaseRetellPhoneNumber({
            apiKey: retellApiKey,
            phoneNumber: row.phone_number,
          })

          const { error: deleteNumberError } = await supabaseAdmin
            .from('agent_phone_numbers')
            .delete()
            .eq('client_id', user.id)
            .eq('phone_number', row.phone_number)

          if (deleteNumberError) throw deleteNumberError
        } catch (error) {
          retellSyncWarning =
            error instanceof Error
              ? `Retell number release failed: ${error.message}`
              : 'Retell number release failed.'
          console.error('Retell number release error:', error)
          break
        }
      }

      const remainingNumbers = (phoneRows ?? [])
        .filter((row) => row.source !== 'retell')
        .map((row) => row.phone_number)

      if (remainingNumbers[0]) {
        const { error: primaryRowError } = await supabaseAdmin
          .from('agent_phone_numbers')
          .update({ is_primary: true })
          .eq('client_id', user.id)
          .eq('phone_number', remainingNumbers[0])

        if (primaryRowError) throw primaryRowError
      }

      const { error: primaryPhoneError } = await supabaseAdmin
        .from('agents')
        .update({ phone_number: remainingNumbers[0] ?? null })
        .eq('client_id', user.id)

      if (primaryPhoneError) throw primaryPhoneError
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: 'cancelled',
        retellSyncWarning,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Update subscription error:',
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
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
