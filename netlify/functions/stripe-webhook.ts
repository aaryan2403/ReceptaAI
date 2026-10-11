
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import {
  purchaseRetellPhoneNumber,
  releaseRetellPhoneNumber,
  syncRetellPhoneBindings,
  syncRetellSubscription,
} from '../lib/retell'
import { normalizePhonePurchase } from '../lib/phoneNumbers'
import { getInvoicePeriod, getInvoiceSubscriptionId } from '../lib/billingPeriods'
import { deliverBillingNotices, getBillingUsage, queueBillingNotice } from '../lib/billingNotifications'

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

  const supabaseUrl =
    process.env.SUPABASE_URL
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY
  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY
  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET
  const retellApiKey =
    process.env.RETELL_API_KEY

  if (
    !supabaseUrl ||
    !supabaseSecretKey ||
    !stripeSecretKey ||
    !webhookSecret
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

  const signature =
    request.headers.get('stripe-signature')

  if (!signature) {
    return new Response(
      JSON.stringify({
        error: 'Missing Stripe signature.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }

  try {
    const stripe =
      new Stripe(stripeSecretKey)

    const rawBody =
      await request.text()

    const event =
      stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret
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

    const loadPhoneRows = async (
      clientId: string,
      legacyPhoneNumber?: string | null
    ) => {
      const { data, error } = await supabaseAdmin
        .from('agent_phone_numbers')
        .select('phone_number, is_primary, source, created_at')
        .eq('client_id', clientId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })

      if (error) throw error

      const rows = data ?? []

      if (rows.length === 0 && legacyPhoneNumber) {
        const { error: backfillError } = await supabaseAdmin
          .from('agent_phone_numbers')
          .insert({
            client_id: clientId,
            phone_number: legacyPhoneNumber,
            is_primary: true,
            source: 'manual',
          })

        if (backfillError) throw backfillError

        return [
          {
            phone_number: legacyPhoneNumber,
            is_primary: true,
            source: 'manual',
            created_at: new Date().toISOString(),
          },
        ]
      }

      return rows
    }

    if (
      event.type ===
      'checkout.session.completed'
    ) {
      const session =
        event.data.object as
          Stripe.Checkout.Session

      if (session.mode === 'subscription') {
        // Never provision minutes from a Checkout session until Stripe has
        // confirmed that money was collected.
        if (session.payment_status !== 'paid') {
          return new Response(
            JSON.stringify({ received: true }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        const clientId =
          session.metadata?.client_id
        const planName =
          session.metadata?.plan_name
        const aiModelId =
          session.metadata?.ai_model_id
        const monthlyMinutes =
          Number(
            session.metadata
              ?.monthly_minutes
          )
        const basePrice =
          Number(
            session.metadata
              ?.base_price_cad
          )
        const monthlyTotal =
          Number(
            session.metadata
              ?.monthly_total_cad
          )
        const piiRedactionEnabled =
          session.metadata
            ?.pii_redaction_enabled ===
          'true'
        const safetyGuardrailsEnabled =
          session.metadata
            ?.safety_guardrails_enabled ===
          'true'
        const extraPhoneNumbers =
          Number(
            session.metadata
              ?.extra_phone_numbers ?? 0
          )
        const phoneNumberCountry =
          session.metadata?.phone_number_country === 'US'
            ? 'US'
            : 'CA'
        const phoneNumberAreaCode =
          session.metadata?.phone_number_area_code || null
        const replacingSubscriptionId =
          session.metadata?.replaces_subscription_id || null

        const subscriptionId =
          typeof session.subscription ===
          'string'
            ? session.subscription
            : session.subscription?.id

        const customerId =
          typeof session.customer ===
          'string'
            ? session.customer
            : session.customer?.id

        if (
          clientId &&
          planName &&
          aiModelId &&
          Number.isFinite(monthlyMinutes) &&
          monthlyMinutes > 0 &&
          Number.isFinite(basePrice) &&
          Number.isFinite(monthlyTotal) &&
          monthlyTotal >= basePrice &&
          Number.isInteger(
            extraPhoneNumbers
          ) &&
          extraPhoneNumbers >= 0 &&
          extraPhoneNumbers <= 20
        ) {
          if (!subscriptionId) throw new Error('Paid Checkout has no subscription ID.')
          const remoteSubscription = await stripe.subscriptions.retrieve(subscriptionId)
          if (remoteSubscription.status !== 'active') return new Response(null, { status: 200 })
          const invoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice?.id
          if (!invoiceId) throw new Error('Paid Checkout has no invoice.')
          const paidInvoice = await stripe.invoices.retrieve(invoiceId)
          if (paidInvoice.status !== 'paid') throw new Error('Checkout invoice is not paid.')
          const invoiceLines = await stripe.invoices.listLineItems(invoiceId, { limit: 100 })
          const period = getInvoicePeriod(invoiceLines.data, subscriptionId)
          if (new Date(period.end).getTime() <= Date.now()) return new Response(null, { status: 200 })
          const { data: activatedRows, error: updateError } = await supabaseAdmin.rpc('activate_recepta_checkout', {
            p_client_id: clientId,
            p_stripe_subscription_id: subscriptionId,
            p_customer_id: customerId || null,
            p_period_start: period.start,
            p_period_end: period.end,
            p_replaces_subscription_id: replacingSubscriptionId,
            p_configuration: {
              plan_name: planName, monthly_price: monthlyTotal,
              monthly_minutes: Math.floor(monthlyMinutes), ai_model_id: aiModelId,
              pii_redaction_enabled: piiRedactionEnabled,
              safety_guardrails_enabled: safetyGuardrailsEnabled,
              extra_phone_numbers: extraPhoneNumbers,
            },
          })
          if (updateError) throw updateError
          const activatedSubscription = activatedRows?.[0]
          if (!activatedSubscription) return new Response(null, { status: 200 })
          await queueBillingNotice(supabaseAdmin, `paid:${invoiceId}`, 'payment_success',
            activatedSubscription, await getBillingUsage(supabaseAdmin, activatedSubscription), paidInvoice.hosted_invoice_url)

          if (
            replacingSubscriptionId &&
            replacingSubscriptionId !== subscriptionId
          ) {
            const previousSubscription =
              await stripe.subscriptions.retrieve(replacingSubscriptionId)

            if (previousSubscription.status !== 'canceled') {
              await stripe.subscriptions.cancel(replacingSubscriptionId)
            }
          }

          const { data: assignedAgent } =
            await supabaseAdmin
              .from('agents')
              .select(
                'retell_agent_id, phone_number'
              )
              .eq('client_id', clientId)
              .maybeSingle()

          if (
            assignedAgent?.retell_agent_id
          ) {
            if (!retellApiKey) {
              throw new Error(
                'RETELL_API_KEY is missing.'
              )
            }

            const phonePurchase = normalizePhonePurchase({
              count: extraPhoneNumbers + 1,
              countryCode: phoneNumberCountry,
              areaCode: phoneNumberAreaCode,
            })
            const phoneRows = await loadPhoneRows(
              clientId,
              assignedAgent.phone_number
            )
            const phoneNumbers = phoneRows.map(
              (row) => row.phone_number
            )
            const numbersToPurchase = Math.max(
              0,
              phonePurchase.purchaseCount - phoneNumbers.length
            )

            for (let index = 0; index < numbersToPurchase; index += 1) {
              const purchasedPhoneNumber =
                await purchaseRetellPhoneNumber({
                  apiKey: retellApiKey,
                  agentId: assignedAgent.retell_agent_id,
                  countryCode: phonePurchase.countryCode,
                  areaCode: phonePurchase.areaCode,
                  nickname: `Recepta ${clientId.slice(0, 8)} ${
                    phoneNumbers.length + 1
                  }`,
                })

              const { error: saveNumberError } = await supabaseAdmin
                .from('agent_phone_numbers')
                .insert({
                  client_id: clientId,
                  phone_number: purchasedPhoneNumber,
                  is_primary: phoneNumbers.length === 0,
                  source: 'retell',
                })

              if (saveNumberError) {
                try {
                  await releaseRetellPhoneNumber({
                    apiKey: retellApiKey,
                    phoneNumber: purchasedPhoneNumber,
                  })
                } catch (releaseError) {
                  console.error(
                    'Could not roll back an untracked Retell number:',
                    releaseError
                  )
                }

                throw saveNumberError
              }

              phoneNumbers.push(purchasedPhoneNumber)
            }

            const primaryPhoneNumber = phoneNumbers[0] ?? null

            const { error: primaryPhoneError } = await supabaseAdmin
              .from('agents')
              .update({ phone_number: primaryPhoneNumber })
              .eq('client_id', clientId)

            if (primaryPhoneError) throw primaryPhoneError

            await syncRetellSubscription({
              apiKey: retellApiKey,
              agentId:
                assignedAgent.retell_agent_id,
              phoneNumber: primaryPhoneNumber,
              phoneNumbers,
              active: true,
              piiRedactionEnabled,
              safetyGuardrailsEnabled,
              aiModelId,
            })
          }

          const restoredStatus =
            assignedAgent?.retell_agent_id
              ? 'live'
              : 'setup'

          const [
            clientRestore,
            agentRestore,
          ] = await Promise.all([
            supabaseAdmin
              .from('clients')
              .update({
                status: restoredStatus,
              })
              .eq('id', clientId),
            supabaseAdmin
              .from('agents')
              .update({
                status: restoredStatus,
              })
              .eq('client_id', clientId),
          ])

          if (clientRestore.error) {
            throw clientRestore.error
          }

          if (agentRestore.error) {
            throw agentRestore.error
          }
        }
      }
    }

    if (
      event.type === 'invoice.paid'
    ) {
      const invoice = event.data.object as Stripe.Invoice
      const stripeSubscriptionId = getInvoiceSubscriptionId(invoice)
      if (stripeSubscriptionId && ['subscription_cycle', 'subscription_create'].includes(invoice.billing_reason ?? '')) {
        // Use the period on THIS paid invoice. Reading only the live subscription
        // would grant a later, unpaid month when an older event is retried.
        const remoteSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId)
        if (remoteSubscription.status === 'active' && invoice.status === 'paid') {
          const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 })
          const period = getInvoicePeriod(lines.data, stripeSubscriptionId)
          if (new Date(period.end).getTime() <= Date.now()) return new Response(null, { status: 200 })
          const { data: renewedRows, error: renewalError } = await supabaseAdmin.rpc('renew_recepta_subscription', {
            p_stripe_subscription_id: stripeSubscriptionId,
            p_period_start: period.start,
            p_period_end: period.end,
          })
          if (renewalError) throw renewalError
          const renewedSubscription = renewedRows?.[0]
          // An older or replaced subscription invoice grants nothing.
          if (!renewedSubscription) return new Response(null, { status: 200 })
          if (renewedSubscription) {
            await queueBillingNotice(supabaseAdmin, `paid:${invoice.id}`, 'payment_success',
              renewedSubscription, await getBillingUsage(supabaseAdmin, renewedSubscription), invoice.hosted_invoice_url)
          }

          if (renewedSubscription?.client_id) {
            const { data: assignedAgent } =
              await supabaseAdmin
                .from('agents')
                .select(
                  'retell_agent_id, phone_number'
                )
                .eq(
                  'client_id',
                  renewedSubscription.client_id
                )
                .maybeSingle()

            const restoredStatus =
              assignedAgent?.retell_agent_id
                ? 'live'
                : 'setup'

            const [clientRestore, agentRestore] =
              await Promise.all([
                supabaseAdmin
                  .from('clients')
                  .update({
                    status: restoredStatus,
                  })
                  .eq(
                    'id',
                    renewedSubscription.client_id
                  ),
                supabaseAdmin
                  .from('agents')
                  .update({
                    status: restoredStatus,
                  })
                  .eq(
                    'client_id',
                    renewedSubscription.client_id
                  ),
              ])

            if (clientRestore.error) {
              throw clientRestore.error
            }

            if (agentRestore.error) {
              throw agentRestore.error
            }

            if (assignedAgent?.retell_agent_id) {
              if (!retellApiKey) {
                throw new Error(
                  'RETELL_API_KEY is missing.'
                )
              }

              const phoneRows = await loadPhoneRows(
                renewedSubscription.client_id,
                assignedAgent.phone_number
              )

              await syncRetellPhoneBindings({
                apiKey: retellApiKey,
                agentId:
                  assignedAgent.retell_agent_id,
                phoneNumbers: phoneRows.map(
                  (row) => row.phone_number
                ),
                active: true,
              })
            }
          }
        }
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const changedSubscription = event.data.object as Stripe.Subscription
      const latest = await stripe.subscriptions.retrieve(changedSubscription.id)
      const { error } = await supabaseAdmin.from('subscriptions')
        .update({ cancel_at_period_end: Boolean(latest.cancel_at_period_end || latest.cancel_at) })
        .eq('stripe_subscription_id', latest.id)
      if (error) throw error
    }

    if (
      event.type ===
      'customer.subscription.deleted'
    ) {
      const subscription =
        event.data.object as
          Stripe.Subscription

      const {
        data: cancelledSubscription,
        error,
      } =
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: 'cancelled',
            rollover_seconds: 0,
          })
          .eq(
            'stripe_subscription_id',
            subscription.id
          )
          .select('client_id')
          .maybeSingle()

      if (error) {
        throw error
      }

      if (cancelledSubscription?.client_id) {
        const clientId =
          cancelledSubscription.client_id

        const [clientPause, agentPause] =
          await Promise.all([
            supabaseAdmin
              .from('clients')
              .update({ status: 'paused' })
              .eq('id', clientId),
            supabaseAdmin
              .from('agents')
              .update({ status: 'paused' })
              .eq('client_id', clientId),
          ])

        if (clientPause.error) {
          throw clientPause.error
        }

        if (agentPause.error) {
          throw agentPause.error
        }

        const { data: assignedAgent } =
          await supabaseAdmin
            .from('agents')
            .select(
              'retell_agent_id, phone_number'
            )
            .eq('client_id', clientId)
            .maybeSingle()

        const phoneRows = await loadPhoneRows(
          clientId,
          assignedAgent?.phone_number
        )
        const allPhoneNumbers = phoneRows.map(
          (row) => row.phone_number
        )

        if (assignedAgent?.retell_agent_id) {
          if (!retellApiKey) {
            throw new Error(
              'RETELL_API_KEY is missing.'
            )
          }

          await syncRetellSubscription({
            apiKey: retellApiKey,
            agentId:
              assignedAgent.retell_agent_id,
            phoneNumber: allPhoneNumbers[0] ?? null,
            phoneNumbers: allPhoneNumbers,
            active: false,
            piiRedactionEnabled: false,
            safetyGuardrailsEnabled: false,
          })
        }

        const purchasedRows = phoneRows.filter(
          (row) => row.source === 'retell'
        )

        if (purchasedRows.length > 0) {
          if (!retellApiKey) {
            throw new Error('RETELL_API_KEY is missing.')
          }

          for (const row of purchasedRows) {
            await releaseRetellPhoneNumber({
              apiKey: retellApiKey,
              phoneNumber: row.phone_number,
            })

            const { error: deleteNumberError } = await supabaseAdmin
              .from('agent_phone_numbers')
              .delete()
              .eq('client_id', clientId)
              .eq('phone_number', row.phone_number)

            if (deleteNumberError) throw deleteNumberError
          }
        }

        const remainingNumbers = phoneRows
          .filter((row) => row.source !== 'retell')
          .map((row) => row.phone_number)

        if (remainingNumbers[0]) {
          const { error: primaryRowError } = await supabaseAdmin
            .from('agent_phone_numbers')
            .update({ is_primary: true })
            .eq('client_id', clientId)
            .eq('phone_number', remainingNumbers[0])

          if (primaryRowError) throw primaryRowError
        }

        const { error: primaryPhoneError } = await supabaseAdmin
          .from('agents')
          .update({ phone_number: remainingNumbers[0] ?? null })
          .eq('client_id', clientId)

        if (primaryPhoneError) throw primaryPhoneError
      }
    }

    if (
      event.type ===
      'invoice.payment_failed'
    ) {
      const invoiceEvent = event.data.object as Stripe.Invoice
      const subscriptionId = getInvoiceSubscriptionId(invoiceEvent)
      if (subscriptionId) {
        // Ignore a failure delivered after the same invoice was paid, or after
        // the subscription was renewed/cancelled. Keep failed-cycle rollover
        // frozen so a successful retry can perform the normal paid renewal.
        const invoice = await stripe.invoices.retrieve(invoiceEvent.id)
        const remote = await stripe.subscriptions.retrieve(subscriptionId)
        if (invoice.status !== 'paid' && ['past_due', 'unpaid', 'incomplete'].includes(remote.status)) {
          const { data: failedSubscription, error } = await supabaseAdmin.from('subscriptions')
            .update({ status: 'past_due' }).eq('stripe_subscription_id', subscriptionId).select('*').maybeSingle()
          if (error) throw error
          if (failedSubscription) {
            await queueBillingNotice(supabaseAdmin, `failed:${invoice.id}`, 'payment_failed', failedSubscription,
              await getBillingUsage(supabaseAdmin, failedSubscription), invoice.hosted_invoice_url)
          }
        }
      }
    }

    // Email outages do not undo a verified payment. Notices stay in the outbox.
    try { await deliverBillingNotices(supabaseAdmin, 1) }
    catch (notificationError) { console.error('Billing notice delivery deferred:', notificationError) }

    return new Response(
      JSON.stringify({ received: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error(
      'Stripe webhook error:',
      error
    )

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : 'Webhook processing failed.',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
