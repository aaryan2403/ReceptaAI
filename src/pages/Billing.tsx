import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'cancelled'

type PlanName =
  | 'Recepta Standard'
  | 'Recepta Pro'

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
  description: string | null
  best_for: string | null
  customer_price_per_minute_cad: number | null
  is_recommended: boolean
  sort_order: number
}

const PLAN_PRICES: Record<PlanName, number> = {
  'Recepta Standard': 200,
  'Recepta Pro': 300,
}

const MINUTE_PRESETS = [
  300,
  500,
  750,
  1000,
  1500,
]

export default function Billing() {
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)

  const [calls, setCalls] =
    useState<CallRecord[]>([])

  const [models, setModels] =
    useState<AIModel[]>([])

  const [loading, setLoading] =
    useState(true)

  const [updating, setUpdating] =
    useState(false)

  const [billingError, setBillingError] =
    useState('')

  const [selectedPlan, setSelectedPlan] =
    useState<PlanName>('Recepta Standard')

  const [
    selectedModelId,
    setSelectedModelId,
  ] = useState('')

  const [
    selectedMinutes,
    setSelectedMinutes,
  ] = useState(300)

  const [
    customMinutes,
    setCustomMinutes,
  ] = useState('')

  const [
    usingCustomMinutes,
    setUsingCustomMinutes,
  ] = useState(false)

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
            tier_name,
            description,
            best_for,
            customer_price_per_minute_cad,
            is_recommended,
            sort_order
            `
          )
          .eq('is_active', true)
          .order('sort_order', {
            ascending: true,
          }),
      ])

      const subscriptionData =
        subscriptionResult.data as
          | Subscription
          | null

      const callsData =
        callsResult.data as
          | CallRecord[]
          | null

      const modelsData =
        modelsResult.data as
          | AIModel[]
          | null

      if (subscriptionData) {
        setSubscription(subscriptionData)

        if (
          subscriptionData.plan_name ===
          'Recepta Pro'
        ) {
          setSelectedPlan(
            'Recepta Pro'
          )
        } else {
          setSelectedPlan(
            'Recepta Standard'
          )
        }

        setSelectedMinutes(
          subscriptionData.monthly_minutes ??
            300
        )

        if (
          subscriptionData.ai_model_id
        ) {
          setSelectedModelId(
            subscriptionData.ai_model_id
          )
        }
      }

      if (callsData) {
        setCalls(callsData)
      }

      if (modelsData) {
        setModels(modelsData)

        if (
          !subscriptionData?.ai_model_id &&
          modelsData.length > 0
        ) {
          const recommended =
            modelsData.find(
              (model) =>
                model.is_recommended
            ) ?? modelsData[0]

          setSelectedModelId(
            recommended.id
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

  const currentIsPro =
    subscription?.status === 'active' &&
    subscription?.plan_name ===
      'Recepta Pro'

  const subscriptionIsActive =
    subscription?.status === 'active'

  const statusInfo = useMemo(() => {
    switch (subscription?.status) {
      case 'active':
        return {
          label: 'Active',
          className:
            'billingStatus--active',
        }

      case 'past_due':
        return {
          label: 'Payment Due',
          className:
            'billingStatus--past_due',
        }

      case 'cancelled':
        return {
          label: 'Cancelled',
          className:
            'billingStatus--cancelled',
        }

      default:
        return {
          label: 'Setup Pending',
          className:
            'billingStatus--pending',
        }
    }
  }, [subscription])

  const minutesUsed = useMemo(() => {
    const totalSeconds = calls.reduce(
      (total, call) =>
        total +
        (call.duration_seconds || 0),
      0
    )

    return Math.round(
      totalSeconds / 60
    )
  }, [calls])

  const selectedModel =
    useMemo(() => {
      return (
        models.find(
          (model) =>
            model.id ===
            selectedModelId
        ) ?? null
      )
    }, [
      models,
      selectedModelId,
    ])

  const planPrice =
    PLAN_PRICES[selectedPlan]

  const minutePrice =
    Number(
      selectedModel
        ?.customer_price_per_minute_cad ??
        0
    )

  const minutesCost =
    selectedMinutes *
    minutePrice

  const monthlyTotal =
    planPrice + minutesCost

  const currentMinuteAllowance =
    subscription?.monthly_minutes ??
    300

  const minutesRemaining = Math.max(
    currentMinuteAllowance -
      minutesUsed,
    0
  )

  const usagePercentage =
    currentMinuteAllowance > 0
      ? Math.min(
          (minutesUsed /
            currentMinuteAllowance) *
            100,
          100
        )
      : 0

  const currentPlan: PlanName =
    subscription?.plan_name ===
    'Recepta Pro'
      ? 'Recepta Pro'
      : 'Recepta Standard'

  const configurationChanged =
    selectedPlan !==
      currentPlan ||
    selectedModelId !==
      (subscription?.ai_model_id ??
        '') ||
    selectedMinutes !==
      currentMinuteAllowance

  const getProviderLogo = (
    provider: string
  ) => {
    const normalized =
      provider.toLowerCase()

    if (
      normalized.includes('anthropic') ||
      normalized.includes('claude')
    ) {
      return '/providers/claude.png'
    }

    if (
      normalized.includes('google') ||
      normalized.includes('gemini')
    ) {
      return '/providers/gemini.png'
    }

    if (
      normalized.includes('openai') ||
      normalized.includes('gpt')
    ) {
      return '/providers/openai.png'
    }

    return '/providers/ai.png'
  }

  const selectPresetMinutes = (
    minutes: number
  ) => {
    setUsingCustomMinutes(false)
    setCustomMinutes('')
    setSelectedMinutes(minutes)
  }

  const activateCustomMinutes =
    () => {
      setUsingCustomMinutes(true)

      if (!customMinutes) {
        setCustomMinutes(
          String(selectedMinutes)
        )
      }
    }

  const updateCustomMinutes = (
    value: string
  ) => {
    setCustomMinutes(value)

    const parsed =
      Number(value)

    if (
      Number.isFinite(parsed) &&
      parsed >= 1
    ) {
      setSelectedMinutes(
        Math.floor(parsed)
      )
    }
  }

  const handleUpdateSubscription =
    async () => {
      if (!selectedModel || selectedMinutes < 1) {
        return
      }

      setUpdating(true)
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
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              planName: selectedPlan,
              aiModel: selectedModelId,
              includedMinutes: selectedMinutes,
            }),
          }
        )

        const result = await response.json().catch(
          () => ({})
        )

        if (!response.ok) {
          throw new Error(
            result?.error ||
              'Unable to update your subscription.'
          )
        }

        if (result?.checkoutUrl) {
          window.location.assign(result.checkoutUrl)
          return
        }

        if (result?.url) {
          window.location.assign(result.url)
          return
        }

        window.location.reload()
      } catch (error) {
        console.error(
          'Update subscription error:',
          error
        )

        setBillingError(
          error instanceof Error
            ? error.message
            : 'Unable to update your subscription.'
        )
      } finally {
        setUpdating(false)
      }
    }

  const handleCancelSubscription =
    async () => {
      if (
        !window.confirm(
          'Cancel your current Recepta subscription? Your paid dashboard features will be locked until you activate a new plan.'
        )
      ) {
        return
      }

      setUpdating(true)
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
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              action: 'cancel',
            }),
          }
        )

        const result = await response.json().catch(
          () => ({})
        )

        if (!response.ok) {
          throw new Error(
            result?.error ||
              'Unable to cancel your subscription.'
          )
        }

        window.location.reload()
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
        setUpdating(false)
      }
    }

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>
              Loading billing...
            </p>
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

          <a
            href="/dashboard/billing"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Billing
          </a>

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
              Manage your plan,
              AI model, monthly minutes
              and billing.
            </p>
          </div>
        </div>

        <>
            {/* CURRENT SUBSCRIPTION */}

            {subscription && (

            <section className="billingConfigCurrent">
              <div className="billingConfigCurrentTop">
                <div>
                  <span className="billingPremiumEyebrow">
                    CURRENT SUBSCRIPTION
                  </span>

                  <h2>
                    {currentPlan}
                  </h2>

                  <p>
                    Your currently active
                    Recepta configuration.
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
                    Platform
                  </span>

                  <strong>
                    C$
                    {PLAN_PRICES[
                      currentPlan
                    ].toFixed(2)}
                  </strong>
                </div>

                <div>
                  <span>
                    AI Model
                  </span>

                  <strong>
                    {models.find(
                      (model) =>
                        model.id ===
                        subscription.ai_model_id
                    )?.display_name ??
                      'Not assigned'}
                  </strong>
                </div>

                <div>
                  <span>
                    Monthly Minutes
                  </span>

                  <strong>
                    {currentMinuteAllowance.toLocaleString()}
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

              <div className="billingCurrentUsage">
                <div className="billingCurrentUsageTop">
                  <span>
                    Minutes used
                  </span>

                  <strong>
                    {minutesUsed} /{' '}
                    {currentMinuteAllowance.toLocaleString()}
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
            )}

            {/* CONFIGURATOR */}

            <section className="billingConfigurator">
              <div className="billingConfiguratorHeading">
                <span className="billingPremiumEyebrow">
                  MANAGE SUBSCRIPTION
                </span>

                <h2>
                  {subscriptionIsActive
                    ? 'Build your monthly plan'
                    : 'Choose your new monthly plan'}
                </h2>

                <p>
                  Choose your Recepta
                  platform, AI model and
                  monthly call allowance.
                </p>
              </div>

              {/* PLAN */}

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">
                    1
                  </span>

                  <div>
                    <h3>
                      Choose your plan
                    </h3>

                    <p>
                      Upgrade or downgrade
                      as your business needs
                      change.
                    </p>
                  </div>
                </div>

                <div className="billingPlanChoices">
                  <button
                    type="button"
                    className={`billingPlanChoice ${
                      selectedPlan ===
                      'Recepta Standard'
                        ? 'billingPlanChoice--selected'
                        : ''
                    }`}
                    onClick={() =>
                      setSelectedPlan(
                        'Recepta Standard'
                      )
                    }
                  >
                    <div className="billingPlanChoiceTop">
                      <div>
                        <span>
                          STANDARD
                        </span>

                        <h3>
                          Recepta Standard
                        </h3>
                      </div>

                      <div className="billingChoiceRadio">
                        {selectedPlan ===
                          'Recepta Standard' && (
                          <span />
                        )}
                      </div>
                    </div>

                    <div className="billingChoicePrice">
                      <strong>
                        C$200
                      </strong>

                      <span>
                        /month
                      </span>
                    </div>

                    <p>
                      AI call answering for
                      businesses that don't
                      require appointment
                      booking.
                    </p>

                    <ul>
                      <li>
                        24/7 AI call answering
                      </li>

                      <li>
                        Customer question
                        handling
                      </li>

                      <li>
                        Call summaries &
                        analytics
                      </li>

                      <li>
                        Human call transfers
                      </li>

                      <li>
                        Managed configuration
                      </li>
                    </ul>
                  </button>

                  <button
                    type="button"
                    className={`billingPlanChoice ${
                      selectedPlan ===
                      'Recepta Pro'
                        ? 'billingPlanChoice--selected'
                        : ''
                    }`}
                    onClick={() =>
                      setSelectedPlan(
                        'Recepta Pro'
                      )
                    }
                  >
                    <div className="billingPlanChoiceTop">
                      <div>
                        <span>
                          PRO
                        </span>

                        <h3>
                          Recepta Pro
                        </h3>
                      </div>

                      <div className="billingChoiceRadio">
                        {selectedPlan ===
                          'Recepta Pro' && (
                          <span />
                        )}
                      </div>
                    </div>

                    <div className="billingChoicePrice">
                      <strong>
                        C$300
                      </strong>

                      <span>
                        /month
                      </span>
                    </div>

                    <p>
                      Complete receptionist
                      automation with
                      appointment and employee
                      management.
                    </p>

                    <ul>
                      <li>
                        Everything in Standard
                      </li>

                      <li>
                        AI appointment booking
                      </li>

                      <li>
                        Employee selection
                      </li>

                      <li>
                        Employee schedules
                      </li>

                      <li>
                        Appointment dashboard
                      </li>

                      <li>
                        Calendar integration
                      </li>
                    </ul>
                  </button>
                </div>
              </div>

              {/* AI MODEL */}

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">
                    2
                  </span>

                  <div>
                    <h3>
                      Choose your AI
                    </h3>

                    <p>
                      Select the AI model
                      powering your Recepta
                      receptionist.
                    </p>
                  </div>
                </div>

                <div className="billingModelGrid">
                  {models.map(
                    (model) => {
                      const selected =
                        model.id ===
                        selectedModelId

                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={`billingModelCard ${
                            selected
                              ? 'billingModelCard--selected'
                              : ''
                          }`}
                          onClick={() =>
                            setSelectedModelId(
                              model.id
                            )
                          }
                        >
                          <div className="billingModelTop">
                            <div className="billingProviderLogo">
                              <img
                                src={getProviderLogo(
                                  model.provider
                                )}
                                alt={`${model.provider} logo`}
                              />
                            </div>

                            <div className="billingChoiceRadio">
                              {selected && (
                                <span />
                              )}
                            </div>
                          </div>

                          <div className="billingModelTier">
                            {model.tier_name}

                            {model.is_recommended && (
                              <span>
                                RECOMMENDED
                              </span>
                            )}
                          </div>

                          <h3>
                            {model.display_name}
                          </h3>

                          <p>
                            {model.description}
                          </p>

                          <div className="billingModelBestFor">
                            <span>
                              BEST FOR
                            </span>

                            <strong>
                              {model.best_for ||
                                'Business calls'}
                            </strong>
                          </div>

                          <div className="billingModelPrice">
                            <strong>
                              C$
                              {Number(
                                model.customer_price_per_minute_cad ??
                                  0
                              ).toFixed(
                                2
                              )}
                            </strong>

                            <span>
                              / minute
                            </span>
                          </div>
                        </button>
                      )
                    }
                  )}
                </div>
              </div>

              {/* MINUTES */}

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">
                    3
                  </span>

                  <div>
                    <h3>
                      Choose monthly minutes
                    </h3>

                    <p>
                      Choose how many AI call
                      minutes are available
                      each month.
                    </p>
                  </div>
                </div>

                <div className="billingMinuteChoices">
                  {MINUTE_PRESETS.map(
                    (minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        className={`billingMinuteChoice ${
                          !usingCustomMinutes &&
                          selectedMinutes ===
                            minutes
                            ? 'billingMinuteChoice--selected'
                            : ''
                        }`}
                        onClick={() =>
                          selectPresetMinutes(
                            minutes
                          )
                        }
                      >
                        <strong>
                          {minutes.toLocaleString()}
                        </strong>

                        <span>
                          minutes
                        </span>
                      </button>
                    )
                  )}

                  <button
                    type="button"
                    className={`billingMinuteChoice ${
                      usingCustomMinutes
                        ? 'billingMinuteChoice--selected'
                        : ''
                    }`}
                    onClick={
                      activateCustomMinutes
                    }
                  >
                    <strong>
                      Custom
                    </strong>

                    <span>
                      choose amount
                    </span>
                  </button>
                </div>

                {usingCustomMinutes && (
                  <div className="billingCustomMinutes">
                    <label>
                      Custom monthly minutes

                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={
                          customMinutes
                        }
                        placeholder="Enter minutes"
                        onChange={(
                          event
                        ) =>
                          updateCustomMinutes(
                            event.target.value
                          )
                        }
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* TOTAL */}

              <div className="billingCheckoutSummary">
                <div className="billingCheckoutSummaryHead">
                  <div>
                    <span className="billingPremiumEyebrow">
                      YOUR SUBSCRIPTION
                    </span>

                    <h2>
                      Monthly total
                    </h2>
                  </div>

                  <div className="billingCheckoutTotal">
                    <strong>
                      C$
                      {monthlyTotal.toFixed(
                        2
                      )}
                    </strong>

                    <span>
                      /month
                    </span>
                  </div>
                </div>

                <div className="billingCheckoutRows">
                  <div>
                    <span>
                      {selectedPlan}
                    </span>

                    <strong>
                      C$
                      {planPrice.toFixed(
                        2
                      )}
                    </strong>
                  </div>

                  <div>
                    <span>
                      {selectedModel
                        ?.display_name ??
                        'Select an AI model'}
                    </span>

                    <strong>
                      C$
                      {minutePrice.toFixed(
                        2
                      )}
                      /min
                    </strong>
                  </div>

                  <div>
                    <span>
                      {selectedMinutes.toLocaleString()}{' '}
                      monthly minutes
                    </span>

                    <strong>
                      C$
                      {minutesCost.toFixed(
                        2
                      )}
                    </strong>
                  </div>
                </div>

                <div className="billingCheckoutEquation">
                  <span>
                    C$
                    {planPrice.toFixed(
                      2
                    )}
                    {' + '}
                    {selectedMinutes.toLocaleString()}
                    {' × C$'}
                    {minutePrice.toFixed(
                      2
                    )}
                  </span>

                  <strong>
                    C$
                    {monthlyTotal.toFixed(
                      2
                    )}
                  </strong>
                </div>

                <button
                  type="button"
                  className="btn btnPrimary billingUpdateSubscription"
                  onClick={
                    handleUpdateSubscription
                  }
                  disabled={
                    updating ||
                    !selectedModel ||
                    selectedMinutes < 1 ||
                    (subscriptionIsActive &&
                      !configurationChanged)
                  }
                >
                  {updating
                    ? 'Updating...'
                    : !subscriptionIsActive
                      ? 'Activate Subscription'
                      : configurationChanged
                        ? 'Update Subscription'
                        : 'Current Configuration'}
                </button>

                {subscriptionIsActive && (
                  <button
                    type="button"
                    className="btn btnOutline billingUpdateSubscription"
                    onClick={handleCancelSubscription}
                    disabled={updating}
                    style={{ marginTop: '12px' }}
                  >
                    Cancel Subscription
                  </button>
                )}

                {subscription?.status === 'cancelled' && (
                  <p className="billingCheckoutDisclaimer">
                    Your previous subscription is cancelled.
                    Choose any plan, AI model and minute
                    package above, then activate a new
                    subscription.
                  </p>
                )}

                {billingError && (
                  <p
                    className="billingCheckoutDisclaimer"
                    role="alert"
                  >
                    {billingError}
                  </p>
                )}

                <p className="billingCheckoutDisclaimer">
                  Your new monthly price
                  will be confirmed before
                  any payment or subscription
                  change is processed.
                </p>
              </div>
            </section>
          </>
      </section>
    </main>
  )
}
