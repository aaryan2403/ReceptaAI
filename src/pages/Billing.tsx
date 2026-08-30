import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type PlanName = 'Recepta Standard' | 'Recepta Pro'

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
  pii_redaction_enabled: boolean
  safety_guardrails_enabled: boolean
  extra_phone_numbers: number
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
  customer_price_per_minute_cad: number | null
}

const ADD_ON_PRICES = {
  piiRedactionPerMinuteCad: 0.014,
  safetyGuardrailsPerMinuteCad: 0.007,
  extraPhoneNumberMonthlyCad: 20,
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

  const [selectedPlan, setSelectedPlan] =
    useState<PlanName>('Recepta Standard')

  const [selectedModelId, setSelectedModelId] =
    useState('')

  const [selectedMinutes, setSelectedMinutes] =
    useState('300')

  const [checkoutLoading, setCheckoutLoading] =
    useState(false)

  const [checkoutError, setCheckoutError] =
    useState('')

  const [piiRedaction, setPiiRedaction] =
    useState(false)

  const [
    safetyGuardrails,
    setSafetyGuardrails,
  ] = useState(false)

  const [
    extraPhoneNumbers,
    setExtraPhoneNumbers,
  ] = useState(0)

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
            pii_redaction_enabled,
            safety_guardrails_enabled,
            extra_phone_numbers,
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
            tier_name,
            customer_price_per_minute_cad
            `
          )
          .eq('is_active', true)
          .order('sort_order', {
            ascending: true,
          }),
      ])

      if (subscriptionResult.data) {
        const loadedSubscription =
          subscriptionResult.data as Subscription

        setSubscription(loadedSubscription)
        setPiiRedaction(
          Boolean(
            loadedSubscription.pii_redaction_enabled
          )
        )
        setSafetyGuardrails(
          Boolean(
            loadedSubscription.safety_guardrails_enabled
          )
        )
        setExtraPhoneNumbers(
          Math.max(
            0,
            Number(
              loadedSubscription.extra_phone_numbers ??
                0
            )
          )
        )
      }

      if (callsResult.data) {
        setCalls(
          callsResult.data as CallRecord[]
        )
      }

      if (modelsResult.data) {
        const loadedModels =
          modelsResult.data as AIModel[]

        setModels(loadedModels)

        const subscriptionData =
          subscriptionResult.data as
            | Subscription
            | null

        if (subscriptionData) {
          setSelectedPlan(
            subscriptionData.plan_name ===
              'Recepta Pro'
              ? 'Recepta Pro'
              : 'Recepta Standard'
          )

          setSelectedMinutes(
            String(
              subscriptionData.monthly_minutes ??
                300
            )
          )

          setSelectedModelId(
            subscriptionData.ai_model_id ||
              loadedModels[0]?.id ||
              ''
          )
        } else {
          setSelectedModelId(
            loadedModels[0]?.id || ''
          )
        }
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

  const currentAddOnLabels = useMemo(() => {
    if (!subscription) {
      return []
    }

    const labels: string[] = []

    if (subscription.pii_redaction_enabled) {
      labels.push('PII Redaction')
    }

    if (subscription.safety_guardrails_enabled) {
      labels.push('Safety Guardrails')
    }

    if (subscription.extra_phone_numbers > 0) {
      labels.push(
        `${subscription.extra_phone_numbers} extra ${
          subscription.extra_phone_numbers === 1
            ? 'number'
            : 'numbers'
        }`
      )
    }

    return labels
  }, [subscription])


  const selectedModel = useMemo(() => {
    return (
      models.find(
        (model) =>
          model.id === selectedModelId
      ) ?? null
    )
  }, [models, selectedModelId])

  const selectedMinutesNumber =
    Number(selectedMinutes)

  const selectedBasePrice =
    selectedPlan === 'Recepta Pro'
      ? 300
      : 200

  const selectedMinutePrice =
    Number(
      selectedModel
        ?.customer_price_per_minute_cad ??
        0
    )

  const selectedBillableMinutes =
    Number.isFinite(selectedMinutesNumber)
      ? Math.max(
          0,
          Math.floor(selectedMinutesNumber)
        )
      : 0

  const selectedPiiRedactionCost =
    piiRedaction
      ? selectedBillableMinutes *
        ADD_ON_PRICES.piiRedactionPerMinuteCad
      : 0

  const selectedSafetyGuardrailsCost =
    safetyGuardrails
      ? selectedBillableMinutes *
        ADD_ON_PRICES.safetyGuardrailsPerMinuteCad
      : 0

  const selectedExtraPhoneNumbersCost =
    extraPhoneNumbers *
    ADD_ON_PRICES.extraPhoneNumberMonthlyCad

  const selectedAddOnsTotal =
    selectedPiiRedactionCost +
    selectedSafetyGuardrailsCost +
    selectedExtraPhoneNumbersCost

  const selectedMonthlyTotal =
    selectedBasePrice +
    selectedBillableMinutes *
      selectedMinutePrice +
    selectedAddOnsTotal

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

  const updateExtraPhoneNumbers = (
    value: string
  ) => {
    const parsed = Number(value)

    if (Number.isFinite(parsed)) {
      setExtraPhoneNumbers(
        Math.min(
          20,
          Math.max(0, Math.floor(parsed))
        )
      )
    }
  }

  const handleStartNewSubscription =
    async () => {
      setCheckoutError('')

      const minutes =
        Number(selectedMinutes)

      if (
        !Number.isFinite(minutes) ||
        minutes < 1
      ) {
        setCheckoutError(
          'Monthly minutes must be at least 1.'
        )
        return
      }

      if (!selectedModelId) {
        setCheckoutError(
          'Choose an AI model.'
        )
        return
      }

      setCheckoutLoading(true)

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
          '/.netlify/functions/create-checkout-session',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
              Authorization:
                `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              planName: selectedPlan,
              aiModelId: selectedModelId,
              monthlyMinutes:
                Math.floor(minutes),
              addOns: {
                piiRedaction,
                safetyGuardrails,
                extraPhoneNumbers,
              },
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
              'Could not start Stripe checkout.'
          )
        }

        if (!result?.url) {
          throw new Error(
            'Stripe checkout URL was not returned.'
          )
        }

        window.location.assign(
          result.url
        )
      } catch (error) {
        setCheckoutError(
          error instanceof Error
            ? error.message
            : 'Could not start Stripe checkout.'
        )
      } finally {
        setCheckoutLoading(false)
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

          {!subscriptionIsPending && (
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

                  <div>
                    <span>
                      Add-ons
                    </span>

                    <strong>
                      {currentAddOnLabels.length > 0
                        ? currentAddOnLabels.join(', ')
                        : 'None'}
                    </strong>
                  </div>
                </div>

                {/* AI MODEL */}

                {currentModel && (
                  <div
                    className={
                      subscriptionIsCancelled
                        ? 'billingModelCard'
                        : 'billingModelCard billingModelCard--selected'
                    }
                    style={{
                      marginTop: '24px',
                      ...(subscriptionIsCancelled
                        ? {
                            borderColor:
                              'rgba(255,255,255,0.12)',
                            background:
                              'rgba(255,255,255,0.035)',
                            boxShadow: 'none',
                          }
                        : {}),
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

                      <span
                        className={
                          subscriptionIsCancelled
                            ? 'billingStatus'
                            : 'billingStatus billingStatus--active'
                        }
                        style={
                          subscriptionIsCancelled
                            ? {
                                color:
                                  'rgba(255,255,255,0.66)',
                                borderColor:
                                  'rgba(255,255,255,0.14)',
                                background:
                                  'rgba(255,255,255,0.06)',
                              }
                            : undefined
                        }
                      >
                        {subscriptionIsCancelled
                          ? 'Previous'
                          : 'Current'}
                      </span>
                    </div>

                    <div className="billingModelTier">
                      {currentModel.tier_name}
                    </div>

                    <h3>
                      {currentModel.display_name}
                    </h3>

                    <p>
                      {subscriptionIsCancelled
                        ? 'This was the AI model assigned to your previous Recepta subscription.'
                        : 'This AI model is currently assigned to your Recepta receptionist.'}
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
                  style={{
                    marginTop: '28px',
                    padding: '34px',
                    border:
                      '1px solid rgba(0,230,118,0.20)',
                    borderRadius: '26px',
                    background:
                      'linear-gradient(180deg, rgba(5,22,13,0.98), rgba(3,14,8,0.98))',
                    boxShadow:
                      '0 24px 70px rgba(0,0,0,0.24)',
                  }}
                >
                  <span className="billingPremiumEyebrow">
                    START A NEW SUBSCRIPTION
                  </span>

                  <h2
                    style={{
                      margin: '10px 0 8px',
                      fontSize:
                        'clamp(28px, 3vw, 40px)',
                    }}
                  >
                    Choose your new Recepta plan
                  </h2>

                  <p
                    style={{
                      margin: 0,
                      maxWidth: '820px',
                      opacity: 0.76,
                      fontSize: '16px',
                    }}
                  >
                    Pick your plan, choose the AI model powering your receptionist,
                    set your monthly minutes, then continue to secure Stripe checkout.
                  </p>

                  <div
                    style={{
                      marginTop: '30px',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        marginBottom: '12px',
                        fontSize: '12px',
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        opacity: 0.6,
                      }}
                    >
                      Choose your plan
                    </span>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(260px, 1fr))',
                        gap: '14px',
                      }}
                    >
                      {(['Recepta Standard', 'Recepta Pro'] as PlanName[]).map(
                        (plan) => {
                          const selected = selectedPlan === plan
                          const isProPlan = plan === 'Recepta Pro'

                          return (
                            <button
                              key={plan}
                              type="button"
                              onClick={() => setSelectedPlan(plan)}
                              style={{
                                width: '100%',
                                padding: '22px',
                                textAlign: 'left',
                                color: '#fff',
                                borderRadius: '20px',
                                border: selected
                                  ? '1px solid rgba(0,230,118,0.72)'
                                  : '1px solid rgba(255,255,255,0.10)',
                                background: selected
                                  ? 'rgba(0,230,118,0.075)'
                                  : 'rgba(255,255,255,0.025)',
                                boxShadow: selected
                                  ? '0 0 0 1px rgba(0,230,118,0.05), 0 18px 45px rgba(0,0,0,0.18)'
                                  : 'none',
                                cursor: 'pointer',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  gap: '20px',
                                  alignItems: 'flex-start',
                                }}
                              >
                                <div>
                                  <span
                                    style={{
                                      display: 'block',
                                      fontSize: '11px',
                                      fontWeight: 800,
                                      letterSpacing: '0.08em',
                                      opacity: 0.58,
                                      textTransform: 'uppercase',
                                    }}
                                  >
                                    {isProPlan ? 'PRO' : 'STANDARD'}
                                  </span>

                                  <strong
                                    style={{
                                      display: 'block',
                                      marginTop: '7px',
                                      fontSize: '22px',
                                    }}
                                  >
                                    {plan}
                                  </strong>
                                </div>

                                <span
                                  style={{
                                    width: '24px',
                                    height: '24px',
                                    display: 'grid',
                                    placeItems: 'center',
                                    flex: '0 0 auto',
                                    borderRadius: '999px',
                                    border: selected
                                      ? '1px solid rgba(0,230,118,0.65)'
                                      : '1px solid rgba(255,255,255,0.18)',
                                  }}
                                >
                                  {selected && (
                                    <span
                                      style={{
                                        width: '10px',
                                        height: '10px',
                                        borderRadius: '999px',
                                        background: '#00e676',
                                        boxShadow: '0 0 12px rgba(0,230,118,0.75)',
                                      }}
                                    />
                                  )}
                                </span>
                              </div>

                              <div
                                style={{
                                  marginTop: '20px',
                                  display: 'flex',
                                  alignItems: 'baseline',
                                  gap: '5px',
                                }}
                              >
                                <strong
                                  style={{
                                    fontSize: '29px',
                                  }}
                                >
                                  C${isProPlan ? '300' : '200'}
                                </strong>
                                <span style={{ opacity: 0.55 }}>/ month</span>
                              </div>

                              <p
                                style={{
                                  margin: '12px 0 0',
                                  opacity: 0.67,
                                  lineHeight: 1.55,
                                }}
                              >
                                {isProPlan
                                  ? 'Everything in Standard, plus appointments and employee availability.'
                                  : 'Core AI receptionist with calls, agent, billing and settings.'}
                              </p>
                            </button>
                          )
                        }
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: '34px',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontSize: '12px',
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        opacity: 0.6,
                      }}
                    >
                      Choose your AI model
                    </span>

                    <p
                      style={{
                        margin: '0 0 16px',
                        opacity: 0.66,
                      }}
                    >
                      Select the AI model powering your Recepta receptionist.
                      All displayed model rates include advanced background-noise
                      removal.
                    </p>

                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(230px, 1fr))',
                        gap: '14px',
                      }}
                    >
                      {models.map((model) => {
                        const selected = selectedModelId === model.id
                        const normalized = `${model.id} ${model.display_name}`.toLowerCase()
                        const isLuna = normalized.includes('luna')
                        const isTerra = normalized.includes('terra')
                        const isClaude = normalized.includes('claude')
                        const isRecommended = normalized.includes('4.1') || normalized.includes('4-1')

                        const description = isLuna
                          ? 'Fast and cost-efficient AI for straightforward receptionist conversations.'
                          : isTerra
                            ? 'Advanced AI for more complicated conversations and business workflows.'
                            : isClaude
                              ? 'Premium conversational AI for nuanced and complex customer interactions.'
                              : 'A strong balance of conversation quality, reliability and cost.'

                        const bestFor = isLuna
                          ? 'Straightforward calls, FAQs and information requests'
                          : isTerra
                            ? 'Businesses with detailed call handling requirements'
                            : isClaude
                              ? 'Complex customer conversations and premium deployments'
                              : 'Most businesses and everyday receptionist workflows'

                        return (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => setSelectedModelId(model.id)}
                            style={{
                              minHeight: '350px',
                              padding: '22px',
                              display: 'flex',
                              flexDirection: 'column',
                              textAlign: 'left',
                              color: '#fff',
                              borderRadius: '20px',
                              border: selected
                                ? '1px solid rgba(0,230,118,0.76)'
                                : '1px solid rgba(255,255,255,0.10)',
                              background: selected
                                ? 'rgba(0,230,118,0.065)'
                                : 'rgba(255,255,255,0.025)',
                              cursor: 'pointer',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                justifyContent: 'space-between',
                                gap: '14px',
                              }}
                            >
                              <div
                                style={{
                                  width: '52px',
                                  height: '52px',
                                  display: 'grid',
                                  placeItems: 'center',
                                  borderRadius: '14px',
                                  background: '#fff',
                                  overflow: 'hidden',
                                }}
                              >
                                <img
                                  src={getProviderLogo(model.provider)}
                                  alt={`${model.provider} logo`}
                                  style={{
                                    width: '32px',
                                    height: '32px',
                                    objectFit: 'contain',
                                  }}
                                />
                              </div>

                              <span
                                style={{
                                  width: '24px',
                                  height: '24px',
                                  display: 'grid',
                                  placeItems: 'center',
                                  borderRadius: '999px',
                                  border: selected
                                    ? '1px solid rgba(0,230,118,0.65)'
                                    : '1px solid rgba(255,255,255,0.18)',
                                }}
                              >
                                {selected && (
                                  <span
                                    style={{
                                      width: '10px',
                                      height: '10px',
                                      borderRadius: '999px',
                                      background: '#00e676',
                                      boxShadow: '0 0 12px rgba(0,230,118,0.75)',
                                    }}
                                  />
                                )}
                              </span>
                            </div>

                            <div
                              style={{
                                marginTop: '22px',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: '11px',
                                    fontWeight: 800,
                                    letterSpacing: '0.08em',
                                    opacity: 0.6,
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  {model.tier_name}
                                </span>

                                {isRecommended && (
                                  <span
                                    style={{
                                      padding: '4px 8px',
                                      borderRadius: '999px',
                                      fontSize: '9px',
                                      fontWeight: 800,
                                      letterSpacing: '0.08em',
                                      color: '#00e676',
                                      border: '1px solid rgba(0,230,118,0.28)',
                                      background: 'rgba(0,230,118,0.08)',
                                    }}
                                  >
                                    RECOMMENDED
                                  </span>
                                )}
                              </div>

                              <h3
                                style={{
                                  margin: '9px 0 10px',
                                  fontSize: '22px',
                                }}
                              >
                                {model.display_name}
                              </h3>

                              <p
                                style={{
                                  margin: 0,
                                  opacity: 0.66,
                                  lineHeight: 1.55,
                                }}
                              >
                                {description}
                              </p>
                            </div>

                            <div
                              style={{
                                marginTop: 'auto',
                                paddingTop: '22px',
                                borderTop: '1px solid rgba(255,255,255,0.08)',
                              }}
                            >
                              <span
                                style={{
                                  display: 'block',
                                  marginBottom: '7px',
                                  fontSize: '10px',
                                  fontWeight: 800,
                                  letterSpacing: '0.08em',
                                  opacity: 0.55,
                                  textTransform: 'uppercase',
                                }}
                              >
                                Best for
                              </span>

                              <strong
                                style={{
                                  display: 'block',
                                  minHeight: '42px',
                                  fontSize: '14px',
                                  lineHeight: 1.4,
                                }}
                              >
                                {bestFor}
                              </strong>

                              <div
                                style={{
                                  marginTop: '18px',
                                  display: 'flex',
                                  alignItems: 'baseline',
                                  gap: '5px',
                                }}
                              >
                                <strong
                                  style={{
                                    fontSize: '28px',
                                  }}
                                >
                                  C${Number(
                                    model.customer_price_per_minute_cad ?? 0
                                  ).toFixed(2)}
                                </strong>
                                <span style={{ opacity: 0.55 }}>/ minute</span>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: '34px',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        marginBottom: '6px',
                        fontSize: '12px',
                        fontWeight: 800,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        opacity: 0.6,
                      }}
                    >
                      Optional add-ons
                    </span>

                    <p
                      style={{
                        margin: '0 0 16px',
                        opacity: 0.66,
                      }}
                    >
                      Available with both Recepta Standard and Recepta Pro.
                    </p>

                    <div className="billingPlanChoices">
                      <button
                        type="button"
                        aria-pressed={piiRedaction}
                        className={`billingPlanChoice ${
                          piiRedaction
                            ? 'billingPlanChoice--selected'
                            : ''
                        }`}
                        onClick={() =>
                          setPiiRedaction(
                            (enabled) => !enabled
                          )
                        }
                      >
                        <div className="billingPlanChoiceTop">
                          <div>
                            <span>OPTIONAL</span>
                            <h3>PII Redaction</h3>
                          </div>

                          <div className="billingChoiceRadio">
                            {piiRedaction && <span />}
                          </div>
                        </div>

                        <div className="billingChoicePrice">
                          <strong>C$0.014</strong>
                          <span>/ AI minute</span>
                        </div>

                        <p>
                          Redacts selected personal information from stored call
                          transcripts and recordings.
                        </p>
                      </button>

                      <button
                        type="button"
                        aria-pressed={safetyGuardrails}
                        className={`billingPlanChoice ${
                          safetyGuardrails
                            ? 'billingPlanChoice--selected'
                            : ''
                        }`}
                        onClick={() =>
                          setSafetyGuardrails(
                            (enabled) => !enabled
                          )
                        }
                      >
                        <div className="billingPlanChoiceTop">
                          <div>
                            <span>OPTIONAL</span>
                            <h3>Safety Guardrails</h3>
                          </div>

                          <div className="billingChoiceRadio">
                            {safetyGuardrails && <span />}
                          </div>
                        </div>

                        <div className="billingChoicePrice">
                          <strong>C$0.007</strong>
                          <span>/ AI minute</span>
                        </div>

                        <p>
                          Adds protection against unsafe, harmful or inappropriate
                          AI responses during calls.
                        </p>
                      </button>

                      <div className="billingPlanChoice">
                        <div className="billingPlanChoiceTop">
                          <div>
                            <span>OPTIONAL</span>
                            <h3>Additional Phone Numbers</h3>
                          </div>
                        </div>

                        <div className="billingChoicePrice">
                          <strong>C$20</strong>
                          <span>/ number / month</span>
                        </div>

                        <p>
                          Adds another dedicated business number connected to the
                          same Recepta account.
                        </p>

                        <div className="billingCustomMinutes">
                          <label>
                            Extra numbers

                            <input
                              type="number"
                              min="0"
                              max="20"
                              step="1"
                              value={extraPhoneNumbers}
                              onChange={(event) =>
                                updateExtraPhoneNumbers(
                                  event.target.value
                                )
                              }
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      marginTop: '34px',
                      display: 'grid',
                      gridTemplateColumns:
                        'minmax(220px, 0.55fr) minmax(0, 1.45fr)',
                      gap: '18px',
                      alignItems: 'stretch',
                    }}
                  >
                    <div
                      style={{
                        padding: '22px',
                        borderRadius: '20px',
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(255,255,255,0.025)',
                      }}
                    >
                      <label
                        style={{
                          display: 'grid',
                          gap: '10px',
                        }}
                      >
                        <span
                          style={{
                            fontSize: '12px',
                            fontWeight: 800,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            opacity: 0.6,
                          }}
                        >
                          Monthly minutes
                        </span>

                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={selectedMinutes}
                          onChange={(event) =>
                            setSelectedMinutes(event.target.value)
                          }
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            fontSize: '20px',
                          }}
                        />
                      </label>
                    </div>

                    <div
                      style={{
                        padding: '22px',
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: '14px',
                        borderRadius: '20px',
                        border: '1px solid rgba(255,255,255,0.10)',
                        background: 'rgba(255,255,255,0.025)',
                      }}
                    >
                      <div>
                        <span style={{ opacity: 0.55, fontSize: '12px' }}>
                          Platform
                        </span>
                        <strong
                          style={{
                            display: 'block',
                            marginTop: '8px',
                            fontSize: '20px',
                          }}
                        >
                          C${selectedBasePrice.toFixed(2)}
                        </strong>
                      </div>

                      <div>
                        <span style={{ opacity: 0.55, fontSize: '12px' }}>
                          AI model
                        </span>
                        <strong
                          style={{
                            display: 'block',
                            marginTop: '8px',
                            fontSize: '20px',
                          }}
                        >
                          {selectedModel?.display_name || 'Choose a model'}
                        </strong>
                      </div>

                      <div>
                        <span style={{ opacity: 0.55, fontSize: '12px' }}>
                          Add-ons
                        </span>
                        <strong
                          style={{
                            display: 'block',
                            marginTop: '8px',
                            fontSize: '20px',
                          }}
                        >
                          C${selectedAddOnsTotal.toFixed(2)}
                        </strong>
                      </div>

                      <div>
                        <span style={{ opacity: 0.55, fontSize: '12px' }}>
                          Monthly total
                        </span>
                        <strong
                          style={{
                            display: 'block',
                            marginTop: '8px',
                            fontSize: '20px',
                          }}
                        >
                          C${selectedMonthlyTotal.toFixed(2)}
                        </strong>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn btnPrimary billingUpdateSubscription"
                    onClick={handleStartNewSubscription}
                    disabled={
                      checkoutLoading ||
                      !selectedModelId
                    }
                    style={{
                      width: '100%',
                      marginTop: '24px',
                      minHeight: '58px',
                      fontSize: '17px',
                    }}
                  >
                    {checkoutLoading
                      ? 'Opening Stripe Checkout...'
                      : 'Continue to Secure Checkout'}
                  </button>

                  {checkoutError && (
                    <p
                      className="billingCheckoutDisclaimer"
                      role="alert"
                      style={{
                        marginTop: '14px',
                      }}
                    >
                      {checkoutError}
                    </p>
                  )}

                  <p
                    className="billingCheckoutDisclaimer"
                    style={{
                      marginTop: '14px',
                      textAlign: 'center',
                    }}
                  >
                    Your new subscription becomes active after Stripe confirms payment.
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
