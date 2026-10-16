import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchBillingStatus } from '../lib/billing'
import type { BillingSubscription as Subscription } from '../lib/billing'
import { calculateMinuteBalance, formatMinuteSeconds, ROLLOVER_POLICY } from '../lib/minuteBalance'

type AIModel = {
  id: string
  display_name: string
  provider: string
  tier_name: string
  customer_price_per_minute_cad: number | null
}

const MAX_MONTHLY_MINUTES = 100_000_000
const PII_RATE_CAD = 0.014
const GUARDRAIL_RATE_CAD = 0.007
const EXTRA_NUMBER_MONTHLY_CAD = 20
const MINUTE_OPTIONS = [100, 300, 500, 1000, 2500, 5000]

export default function Billing() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [secondsUsed, setSecondsUsed] = useState(0)
  const [managingBilling, setManagingBilling] = useState(false)
  const [models, setModels] = useState<AIModel[]>([])
  const [modelRate, setModelRate] = useState(0)
  const [selectedMinutes, setSelectedMinutes] = useState('300')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return

        const [billingStatus, modelsResult] = await Promise.all([
          fetchBillingStatus(),
          supabase
            .from('ai_models')
            .select('id, display_name, provider, tier_name, customer_price_per_minute_cad')
            .eq('is_active', true)
            .order('sort_order', { ascending: true }),
        ])
        const loadedSubscription = billingStatus.subscription
        setSecondsUsed(billingStatus.usedSeconds)
        setSubscription(loadedSubscription)
        const configured = { ...loadedSubscription, ...(loadedSubscription?.pending_configuration ?? {}) }
        setSelectedMinutes(String(configured.monthly_minutes ?? 300))

        if (!modelsResult.error) {
          setModels((modelsResult.data ?? []) as AIModel[])
        }

        if (configured.ai_model_id) {
          const assignedModel = (modelsResult.data ?? []).find(
            (model) => model.id === configured.ai_model_id
          )
          setModelRate(Math.max(0, Number(assignedModel?.customer_price_per_minute_cad ?? 0)))
        }

      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load billing.')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [])

  const checkoutConfiguration = subscription ? { ...subscription, ...(subscription.pending_configuration ?? {}) } : null
  const monthlyMinutes = Math.floor(Number(selectedMinutes))
  const proposedTotal = useMemo(() => {
    if (!subscription || !Number.isFinite(monthlyMinutes)) return 0
    const configuration = { ...subscription, ...(subscription.pending_configuration ?? {}) }
    const base = configuration.plan_name === 'Recepta Pro' ? 300 : 200
    return base + monthlyMinutes * modelRate +
      (configuration.pii_redaction_enabled ? monthlyMinutes * PII_RATE_CAD : 0) +
      (configuration.safety_guardrails_enabled ? monthlyMinutes * GUARDRAIL_RATE_CAD : 0) +
      Math.max(0, Number(configuration.extra_phone_numbers ?? 0)) * EXTRA_NUMBER_MONTHLY_CAD
  }, [modelRate, monthlyMinutes, subscription])

  const balance = calculateMinuteBalance(subscription ?? {
    monthly_minutes: 0, status: null,
  }, secondsUsed)
  const minutesUsed = formatMinuteSeconds(secondsUsed)
  const availableMinutes = formatMinuteSeconds(balance.totalSeconds)
  const minutesRemaining = formatMinuteSeconds(balance.remainingSeconds)
  const rolloverMinutes = formatMinuteSeconds(balance.rolloverSeconds)
  const usagePercent = balance.usagePercent

  const openBillingPortal = async () => {
    setError('')
    setManagingBilling(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response = await fetch('/.netlify/functions/create-billing-portal-session', {
        method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await response.json()
      if (!response.ok || !body.url) throw new Error(body.error || 'Could not open billing management.')
      window.location.href = body.url
    } catch (portalError) {
      setError(portalError instanceof Error ? portalError.message : 'Could not open billing management.')
      setManagingBilling(false)
    }
  }

  const startMinuteCheckout = async () => {
    setError('')
    if (!checkoutConfiguration?.plan_name || !checkoutConfiguration.ai_model_id) {
      setError('Contact Recepta to finish configuring your subscription.')
      return
    }
    if (!Number.isFinite(monthlyMinutes) || monthlyMinutes < 1 || monthlyMinutes > MAX_MONTHLY_MINUTES) {
      setError('Choose a valid monthly minute allowance.')
      return
    }

    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response = await fetch('/.netlify/functions/create-checkout-session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          monthlyMinutes,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not open Stripe checkout.')
      if (!body.url) throw new Error('Stripe checkout URL was not returned.')
      window.location.href = body.url
    } catch (renewError) {
      setError(renewError instanceof Error ? renewError.message : 'Could not open secure payment.')
      setSaving(false)
    }
  }

  if (loading) {
    return <main className="dashboardPage"><section className="dashboardMain"><div className="dashboardEmptyState"><p>Loading billing...</p></div></section></main>
  }

  const statusLabel = subscription?.status === 'active'
    ? 'Active'
    : subscription?.status === 'past_due'
      ? 'Payment due'
      : subscription?.status === 'cancelled'
        ? 'Cancelled'
        : 'Setup pending'

  const nextBillingLabel = subscription?.next_billing_date
    ? new Date(subscription.next_billing_date).toLocaleDateString('en-CA', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'Not scheduled'
  const minuteAllowanceChanged =
    monthlyMinutes !== Number(subscription?.monthly_minutes ?? 0)
  const paymentChangePending = Boolean(subscription?.pending_configuration) || minuteAllowanceChanged

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand"><img src="/components/logoR.png" alt="Recepta" /></a>
        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">Overview</a>
          <a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
          <a href="/dashboard/agent" className="dashboardNavItem">Agent</a>
          <a href="/dashboard/requests" className="dashboardNavItem">Customer Requests</a>
          <a href="/dashboard/billing" className="dashboardNavItem dashboardNavItemActive">Billing</a>
          <a href="/dashboard/settings" className="dashboardNavItem">Settings</a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">BILLING</p>
            <h1>Minutes &amp; billing</h1>
            <p>Choose your monthly call minutes. Recepta manages the AI and technical configuration for you.</p>
          </div>
        </div>

        {error && <p className="calendarAlert calendarAlert--error" role="alert">{error}</p>}

        {!subscription ? (
          <div className="dashboardEmptyState">
            <strong>Your subscription is not configured yet.</strong>
            <p>Contact Recepta so we can assign your plan and receptionist configuration.</p>
            <a className="btn btnPrimary" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
          </div>
        ) : (
          <>
            <section className="billingConfigCurrent">
              <div className="billingConfigCurrentTop">
                <div>
                  <span className="billingPremiumEyebrow">CURRENT SUBSCRIPTION</span>
                  <h2>{subscription.plan_name || 'Recepta plan'}</h2>
                  <p>Your subscription is charged monthly, even when you have rollover minutes.</p>
                  {subscription.stripe_subscription_id && (
                    <button type="button" className="btn btnPrimary" onClick={openBillingPortal} disabled={managingBilling}>
                      {managingBilling ? 'Opening billing...' : 'Manage payment method & subscription'}
                    </button>
                  )}
                </div>
              </div>

              <div className="billingCurrentStats">
                <div>
                  <span>Status</span>
                  <strong>{statusLabel}</strong>
                </div>
                <div>
                  <span>Monthly total</span>
                  <strong>C${Number(subscription.monthly_price ?? 0).toFixed(2)}</strong>
                </div>
                <div>
                  <span>Total cycle allowance</span>
                  <strong>{availableMinutes.toLocaleString()}</strong>
                </div>
                <div>
                  <span>{subscription.cancel_at_period_end ? 'Service ends' : subscription.status === 'past_due' ? 'Payment due' : 'Next monthly payment'}</span>
                  <strong>{nextBillingLabel}</strong>
                </div>
              </div>

              {subscription.cancel_at_period_end && (
                <p className="calendarAlert" role="status">Cancellation is scheduled for {nextBillingLabel}. There is no automatic renewal after that date, and unused minutes expire when service ends.</p>
              )}
              {subscription.status === 'past_due' && (
                <p className="calendarAlert calendarAlert--error" role="alert">Payment is due. Update your payment method above. Rollover minutes require a paid subscription.</p>
              )}
              {subscription.status === 'active' && !balance.paid && (
                <p className="calendarAlert" role="status">Your paid billing cycle has ended. Minutes become available after Stripe confirms renewal payment.</p>
              )}
              <div className="billingCurrentUsage">
                <div className="billingCurrentUsageTop">
                  <span>{minutesUsed.toLocaleString()} minutes used</span>
                  <strong>{minutesRemaining.toLocaleString()} remaining</strong>
                </div>
                <div className="billingUsageTrack">
                  <div className="billingUsageFill" style={{ width: `${usagePercent}%` }} />
                </div>
                <small>
                  {Number(subscription.monthly_minutes ?? 0).toLocaleString()} monthly minutes
                  {' + '}{rolloverMinutes.toLocaleString()} rollover minutes
                </small>
              </div>
              <div className="billingCurrentStats">
                <div><span>Monthly minutes left</span><strong>{formatMinuteSeconds(balance.monthlyRemainingSeconds)}</strong></div>
                <div><span>Rollover minutes left</span><strong>{formatMinuteSeconds(balance.rolloverRemainingSeconds)}</strong></div>
                <div><span>Rollover expires</span><strong>{subscription.current_period_end ? new Date(subscription.current_period_end).toLocaleDateString('en-CA') : 'Not scheduled'}</strong></div>
                <div><span>Payment reminders</span><strong>Email before renewal</strong></div>
              </div>
              <p className="billingCheckoutDisclaimer">{ROLLOVER_POLICY}</p>
              <p className="billingCheckoutDisclaimer">We email you before renewal, after payment, if payment fails, and at 80% and 100% usage. New AI calls pause when your paid allowance is used; calls in progress can finish.</p>
            </section>

            <section className="billingConfigurator billingCatalogue">
              <div className="billingConfiguratorHeading">
                <span className="billingPremiumEyebrow">RECEPTA CATALOGUE</span>
                <h2>Plans, AI models and add-ons</h2>
                <p>See every published price before you request a change. Paid plan, model and add-on changes activate after successful payment.</p>
              </div>

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">1</span>
                  <div>
                    <h3>Plans</h3>
                    <p>Plan prices are monthly base fees. AI usage and selected add-ons are calculated separately.</p>
                  </div>
                </div>

                <div className="billingPlanChoices">
                  <article className={`billingPlanChoice ${subscription.plan_name === 'Recepta Standard' ? 'billingPlanChoice--selected' : ''}`}>
                    <div className="billingPlanChoiceTop">
                      <div><span>STANDARD</span><h3>Recepta Standard</h3></div>
                      {subscription.plan_name === 'Recepta Standard' && <span className="billingCurrentBadge">CURRENT</span>}
                    </div>
                    <div className="billingChoicePrice"><strong>C$200</strong><span>/ month base</span></div>
                    <p>AI call answering and the essential customer dashboard.</p>
                    <ul>
                      <li>Call history and AI summaries</li>
                      <li>Monthly minute selection and rollover</li>
                      <li>Agent settings and basic notifications</li>
                    </ul>
                  </article>

                  <article className={`billingPlanChoice ${subscription.plan_name === 'Recepta Pro' ? 'billingPlanChoice--selected' : ''}`}>
                    <div className="billingPlanChoiceTop">
                      <div><span>PRO</span><h3>Recepta Pro</h3></div>
                      {subscription.plan_name === 'Recepta Pro' && <span className="billingCurrentBadge">CURRENT</span>}
                    </div>
                    <div className="billingChoicePrice"><strong>C$300</strong><span>/ month base</span></div>
                    <p>Everything in Standard, plus AI appointment intake.</p>
                    <ul>
                      <li>Appointment details inside each call</li>
                      <li>Admin-defined custom intake fields</li>
                      <li>Full appointment notifications and AI summary</li>
                    </ul>
                  </article>
                </div>
              </div>

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">2</span>
                  <div>
                    <h3>AI model catalogue</h3>
                    <p>The model rate is charged for each selected monthly minute. Your assigned model is marked below.</p>
                  </div>
                </div>

                {models.length > 0 ? (
                  <div className="billingModelGrid">
                    {models.map((model) => (
                      <article key={model.id} className={`billingModelCard ${subscription.ai_model_id === model.id ? 'billingModelCard--selected' : ''}`}>
                        <div className="billingModelTop">
                          <span className="billingModelProvider">{model.provider}</span>
                          {subscription.ai_model_id === model.id && <span className="billingCurrentBadge">ASSIGNED</span>}
                        </div>
                        <div className="billingModelTier">{model.tier_name}</div>
                        <h3>{model.display_name}</h3>
                        <div className="billingModelPrice">
                          <strong>C${Number(model.customer_price_per_minute_cad ?? 0).toFixed(3)}</strong>
                          <span>/ selected minute</span>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="billingCatalogueEmpty">AI model prices are being configured. Contact Recepta for the current options.</p>
                )}
              </div>

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">3</span>
                  <div>
                    <h3>Optional add-ons</h3>
                    <p>Security add-ons apply to every selected monthly minute. Recepta Admin enables them after your request.</p>
                  </div>
                </div>

                <div className="billingAddOnGrid">
                  <article className={subscription.pii_redaction_enabled ? 'billingAddOnCard billingAddOnCard--enabled' : 'billingAddOnCard'}>
                    <div><span>PRIVACY</span>{subscription.pii_redaction_enabled && <strong>ENABLED</strong>}</div>
                    <h3>PII Redaction</h3>
                    <p>Automatically redacts supported personal information categories from Retell call data.</p>
                    <strong>C$0.014 <small>/ selected minute</small></strong>
                  </article>

                  <article className={subscription.safety_guardrails_enabled ? 'billingAddOnCard billingAddOnCard--enabled' : 'billingAddOnCard'}>
                    <div><span>SAFETY</span>{subscription.safety_guardrails_enabled && <strong>ENABLED</strong>}</div>
                    <h3>Safety Guardrails</h3>
                    <p>Enables supported input and output safeguards for the assigned AI receptionist.</p>
                    <strong>C$0.007 <small>/ selected minute</small></strong>
                  </article>

                  <article className="billingAddOnCard">
                    <div><span>PHONE</span>{subscription.extra_phone_numbers > 0 && <strong>{subscription.extra_phone_numbers} ACTIVE</strong>}</div>
                    <h3>Extra Phone Number</h3>
                    <p>Add another Recepta phone number to the same active subscription.</p>
                    <strong>C$20 <small>/ number / month</small></strong>
                  </article>
                </div>

                <a
                  className="btn btnOutline billingCatalogueRequest"
                  href={`mailto:receptahelp02@gmail.com?subject=${encodeURIComponent('Recepta catalogue change request')}&body=${encodeURIComponent(`Please contact me about changing my Recepta plan, AI model or add-ons. Current plan: ${subscription.plan_name || 'Not assigned'}.`)}`}
                >
                  Request a plan, model or add-on
                </a>
              </div>
            </section>

            <section className="billingConfigurator">
              <div className="billingConfiguratorHeading">
                <span className="billingPremiumEyebrow">MONTHLY MINUTES</span>
                <h2>Choose your call allowance</h2>
                <p>Select a preset or enter an exact amount. Recepta manages your plan, AI model, phone numbers and agent settings.</p>
              </div>

              <div className="billingConfigSection">
                <div className="billingConfigSectionHead">
                  <span className="billingConfigNumber">4</span>
                  <div>
                    <h3>Select your monthly minutes</h3>
                    <p>You can update the allowance whenever your call volume changes.</p>
                  </div>
                </div>

                <div className="billingMinuteChoices">
                  {MINUTE_OPTIONS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      className={`billingMinuteChoice ${monthlyMinutes === minutes ? 'billingMinuteChoice--selected' : ''}`}
                      onClick={() => setSelectedMinutes(String(minutes))}
                    >
                      <strong>{minutes.toLocaleString()}</strong>
                      <span>minutes / month</span>
                    </button>
                  ))}
                </div>

                <div className="billingCustomMinutes">
                  <label>
                    Or enter a custom amount
                    <input
                      type="number"
                      min="1"
                      max={MAX_MONTHLY_MINUTES}
                      step="1"
                      inputMode="numeric"
                      value={selectedMinutes}
                      onChange={(event) => setSelectedMinutes(event.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div className="billingCheckoutSummary">
                {subscription.pending_configuration && <p className="calendarAlert" role="status">Recepta prepared a configuration awaiting payment: {checkoutConfiguration?.plan_name}, {models.find(model => model.id === checkoutConfiguration?.ai_model_id)?.display_name || 'assigned AI model'}, PII redaction {checkoutConfiguration?.pii_redaction_enabled ? 'on' : 'off'}, Safety Guardrails {checkoutConfiguration?.safety_guardrails_enabled ? 'on' : 'off'}, and {checkoutConfiguration?.extra_phone_numbers ?? 0} additional numbers. Your current paid service stays unchanged until payment succeeds.</p>}
                <div className="billingCheckoutSummaryHead">
                  <div>
                    <span className="billingPremiumEyebrow">UPDATED TOTAL</span>
                    <h2>{monthlyMinutes > 0 ? monthlyMinutes.toLocaleString() : '—'} minutes per month</h2>
                  </div>
                  <div className="billingCheckoutTotal">
                    <strong>C${proposedTotal.toFixed(2)}</strong>
                    <span>estimated monthly</span>
                  </div>
                </div>

                {subscription.status === 'active' || subscription.status === 'cancelled' || subscription.status === 'pending' ? (
                  <button
                    type="button"
                    className="btn btnPrimary billingUpdateSubscription"
                    onClick={startMinuteCheckout}
                    disabled={saving || (subscription.status === 'active' && !paymentChangePending)}
                  >
                    {saving
                      ? 'Opening secure payment...'
                      : subscription.status === 'active' && !paymentChangePending
                        ? 'Current minute allowance selected'
                        : 'Pay & activate configuration'}
                  </button>
                ) : (
                  <a className="btn btnPrimary billingUpdateSubscription" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
                )}

                <p className="billingCheckoutDisclaimer">Service activation and billable changes require successful Stripe payment. A cancelled or failed Checkout does not grant new minutes or features.</p>
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  )
}
