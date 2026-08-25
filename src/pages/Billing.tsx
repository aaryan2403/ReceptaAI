import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'cancelled'

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  monthly_minutes: number | null
  ai_model_id: string | null
  status: SubscriptionStatus
  next_billing_date: string | null
}

type CallRecord = {
  duration_seconds: number
}

type AIModel = {
  id: string
  display_name: string
  provider: string
  tier_name: string
}

export default function Billing() {
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)

  const [calls, setCalls] =
    useState<CallRecord[]>([])

  const [models, setModels] =
    useState<AIModel[]>([])

  const [loading, setLoading] =
    useState(true)

  const [cancelling, setCancelling] =
    useState(false)

  const [billingError, setBillingError] =
    useState('')

  useEffect(() => {
    const loadBilling = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        subscriptionResult,
        callsResult,
        modelsResult,
      ] = await Promise.all([
        supabase
          .from('subscriptions')
          .select(
            `
            plan_name,
            monthly_price,
            monthly_minutes,
            ai_model_id,
            status,
            next_billing_date
            `
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('calls')
          .select('duration_seconds')
          .eq('client_id', user.id),

        supabase
          .from('ai_models')
          .select(
            `
            id,
            display_name,
            provider,
            tier_name
            `
          )
          .eq('is_active', true)
          .order('sort_order', {
            ascending: true,
          }),
      ])

      if (subscriptionResult.data) {
        setSubscription(
          subscriptionResult.data as Subscription
        )
      }

      if (callsResult.data) {
        setCalls(
          callsResult.data as CallRecord[]
        )
      }

      if (modelsResult.data) {
        setModels(
          modelsResult.data as AIModel[]
        )
      }

      if (subscriptionResult.error) {
        console.error(
          'Subscription error:',
          subscriptionResult.error
        )
      }

      if (callsResult.error) {
        console.error(
          'Calls error:',
          callsResult.error
        )
      }

      if (modelsResult.error) {
        console.error(
          'AI models error:',
          modelsResult.error
        )
      }

      setLoading(false)
    }

    loadBilling()
  }, [])

  const subscriptionIsActive =
    subscription?.status === 'active'

  const subscriptionIsCancelled =
    subscription?.status === 'cancelled'

  const subscriptionIsPending =
    !subscription ||
    subscription.status === 'pending'

  const currentIsPro =
    subscriptionIsActive &&
    subscription?.plan_name === 'Recepta Pro'

  const currentModel = useMemo(() => {
    if (!subscription?.ai_model_id) {
      return null
    }

    return (
      models.find(
        (model) =>
          model.id === subscription.ai_model_id
      ) ?? null
    )
  }, [models, subscription])

  const statusInfo = useMemo(() => {
    switch (subscription?.status) {
      case 'active':
        return {
          label: 'Active',
          className: 'billingStatus--active',
        }

      case 'past_due':
        return {
          label: 'Payment Due',
          className: 'billingStatus--past_due',
        }

      case 'cancelled':
        return {
          label: 'Cancelled',
          className: 'billingStatus--cancelled',
        }

      default:
        return {
          label: 'Setup Pending',
          className: 'billingStatus--pending',
        }
    }
  }, [subscription])

  const minutesUsed = useMemo(() => {
    const totalSeconds = calls.reduce(
      (total, call) =>
        total + (call.duration_seconds || 0),
      0
    )

    return Math.round(totalSeconds / 60)
  }, [calls])

  const minuteAllowance =
    subscription?.monthly_minutes ?? 0

  const minutesRemaining = Math.max(
    minuteAllowance - minutesUsed,
    0
  )

  const usagePercentage =
    minuteAllowance > 0
      ? Math.min(
          (minutesUsed / minuteAllowance) * 100,
          100
        )
      : 0

  const getProviderLogo = (
    provider: string
  ) => {
    const normalized =
      provider.toLowerCase()

    if (
      normalized.includes('anthropic') ||
      normalized.includes('claude')
    ) {
      return '/claude.png'
    }

    return '/openai.png'
  }

  const handleCancelSubscription =
    async () => {
      if (
        !window.confirm(
          'Cancel your Recepta subscription? Your paid dashboard features will be locked.'
        )
      ) {
        return
      }

      setCancelling(true)
      setBillingError('')

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        if (!session?.access_token) {
          throw new Error(
            'Your session has expired. Please sign in again.'
          )
        }

        const response = await fetch(
          '/.netlify/functions/update-subscription',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',

              Authorization:
                `Bearer ${session.access_token}`,
            },

            body: JSON.stringify({
              action: 'cancel',
            }),
          }
        )

        const result =
          await response
            .json()
            .catch(() => ({}))

        if (!response.ok) {
          throw new Error(
            result?.error ||
              'Unable to cancel your subscription.'
          )
        }

        window.location.assign(
          '/dashboard'
        )
      } catch (error) {
        console.error(
          'Cancel subscription error:',
          error
        )

        setBillingError(
          error instanceof Error
            ? error.message
            : 'Unable to cancel your subscription.'
        )
      } finally {
        setCancelling(false)
      }
    }

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>Loading billing...</p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a
          href="/"
          className="dashboardBrand"
        >
          <img
            src="/components/logoR.png"
            alt="Recepta"
          />
        </a>

        <nav className="dashboardNav">
          <a
            href="/dashboard"
            className="dashboardNavItem"
          >
            Overview
          </a>

          {subscriptionIsActive && (
            <>
              <a
                href="/dashboard/calls"
                className="dashboardNavItem"
              >
                Calls
              </a>

              {currentIsPro && (
                <>
                  <a
                    href="/dashboard/appointments"
                    className="dashboardNavItem"
                  >
                    Appointments
                  </a>

                  <a
                    href="/dashboard/employees"
                    className="dashboardNavItem"
                  >
                    Employees
                  </a>
                </>
              )}

              <a
                href="/dashboard/agent"
                className="dashboardNavItem"
              >
                Agent
              </a>
            </>
          )}

          {!subscriptionIsPending && (
            <a
              href="/dashboard/billing"
              className="dashboardNavItem dashboardNavItemActive"
            >
              Billing
            </a>
          )}

          <a
            href="/dashboard/settings"
            className="dashboardNavItem"
          >
            Settings
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              BILLING
            </p>

            <h1>
              Your Recepta subscription
            </h1>

            <p>
              View your current plan,
              AI receptionist and usage.
            </p>
          </div>
        </div>

        {/* PENDING */}

        {subscriptionIsPending && (
          <div className="dashboardEmptyState">
            <h2>
              Billing setup pending
            </h2>

            <p>
              Your Recepta subscription has
              not been activated yet. Your
              account is currently being
              prepared by Recepta.
            </p>
          </div>
        )}

        {/* ACTIVE / PAST DUE / CANCELLED */}

        {!subscriptionIsPending &&
          subscription && (
            <>
              <section className="billingConfigCurrent">
                <div className="billingConfigCurrentTop">
                  <div>
                    <span className="billingPremiumEyebrow">
                      CURRENT SUBSCRIPTION
                    </span>

                    <h2>
                      {subscription.plan_name ||
                        'Recepta'}
                    </h2>

                    <p>
                      Your current Recepta
                      subscription configuration.
                    </p>
                  </div>

                  <span
                    className={`billingStatus ${statusInfo.className}`}
                  >
                    {statusInfo.label}
                  </span>
                </div>

                <div className="billingCurrentStats">
                  <div>
                    <span>
                      Monthly Platform
                    </span>

                    <strong>
                      {subscription.monthly_price !==
                      null
                        ? `C$${Number(
                            subscription.monthly_price
                          ).toFixed(2)}`
                        : '—'}
                    </strong>
                  </div>

                  <div>
                    <span>
                      AI Model
                    </span>

                    <strong>
                      {currentModel?.display_name ||
                        'Not assigned'}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Monthly Minutes
                    </span>

                    <strong>
                      {minuteAllowance.toLocaleString()}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Next Billing
                    </span>

                    <strong>
                      {subscription.next_billing_date
                        ? new Date(
                            subscription.next_billing_date
                          ).toLocaleDateString()
                        : 'Not scheduled'}
                    </strong>
                  </div>
                </div>

                {/* AI MODEL */}

                {currentModel && (
                  <div
                    className="billingModelCard billingModelCard--selected"
                    style={{
                      marginTop: '24px',
                    }}
                  >
                    <div className="billingModelTop">
                      <div className="billingProviderLogo">
                        <img
                          src={getProviderLogo(
                            currentModel.provider
                          )}
                          alt={`${currentModel.provider} logo`}
                        />
                      </div>

                      <span className="billingStatus billingStatus--active">
                        Current
                      </span>
                    </div>

                    <div className="billingModelTier">
                      {currentModel.tier_name}
                    </div>

                    <h3>
                      {currentModel.display_name}
                    </h3>

                    <p>
                      This AI model is currently
                      assigned to your Recepta
                      receptionist.
                    </p>
                  </div>
                )}

                {/* USAGE */}

                <div className="billingCurrentUsage">
                  <div className="billingCurrentUsageTop">
                    <span>
                      Minutes used
                    </span>

                    <strong>
                      {minutesUsed.toLocaleString()}
                      {' / '}
                      {minuteAllowance.toLocaleString()}
                    </strong>
                  </div>

                  <div className="billingUsageTrack">
                    <div
                      className="billingUsageFill"
                      style={{
                        width:
                          `${usagePercentage}%`,
                      }}
                    />
                  </div>

                  <small>
                    {minutesRemaining.toLocaleString()}{' '}
                    minutes remaining
                  </small>
                </div>
              </section>

              {/* CANCEL */}

              {subscriptionIsActive && (
                <section
                  className="billingCheckoutSummary"
                  style={{
                    marginTop: '24px',
                  }}
                >
                  <div className="billingCheckoutSummaryHead">
                    <div>
                      <span className="billingPremiumEyebrow">
                        SUBSCRIPTION
                      </span>

                      <h2>
                        Manage subscription
                      </h2>
                    </div>
                  </div>

                  <p>
                    Your plan, AI model and
                    monthly minute allowance
                    are currently locked while
                    this subscription is active.
                  </p>

                  <button
                    type="button"
                    className="btn btnOutline billingUpdateSubscription"
                    onClick={
                      handleCancelSubscription
                    }
                    disabled={cancelling}
                    style={{
                      marginTop: '20px',
                    }}
                  >
                    {cancelling
                      ? 'Cancelling...'
                      : 'Cancel Subscription'}
                  </button>

                  {billingError && (
                    <p
                      className="billingCheckoutDisclaimer"
                      role="alert"
                    >
                      {billingError}
                    </p>
                  )}
                </section>
              )}

              {/* CANCELLED */}

              {subscriptionIsCancelled && (
                <section
                  className="billingCheckoutSummary"
                  style={{
                    marginTop: '24px',
                  }}
                >
                  <span className="billingPremiumEyebrow">
                    SUBSCRIPTION CANCELLED
                  </span>

                  <h2>
                    Your subscription is no
                    longer active
                  </h2>

                  <p>
                    Your previous subscription
                    information has been
                    preserved. Paid dashboard
                    features are currently
                    locked.
                  </p>

                  <p className="billingCheckoutDisclaimer">
                    A new subscription will be
                    available through the secure
                    purchase flow once Recepta
                    billing is connected to
                    Stripe.
                  </p>
                </section>
              )}

              {/* PAST DUE */}

              {subscription.status ===
                'past_due' && (
                <section
                  className="billingCheckoutSummary"
                  style={{
                    marginTop: '24px',
                  }}
                >
                  <span className="billingPremiumEyebrow">
                    PAYMENT REQUIRED
                  </span>

                  <h2>
                    There is a problem with
                    your payment
                  </h2>

                  <p>
                    Your billing status is
                    currently past due. Once
                    Stripe is connected, payment
                    recovery will be handled
                    through the secure billing
                    flow.
                  </p>
                </section>
              )}
            </>
          )}
      </section>
    </main>
  )
}
