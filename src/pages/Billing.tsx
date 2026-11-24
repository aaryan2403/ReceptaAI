import BillingAccessNotice from '../components/BillingAccessNotice'
import BillingOverview from '../components/BillingOverview'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchBillingStatus } from '../lib/billing'

const MAX_MONTHLY_MINUTES = 100_000_000
const PII_RATE_CAD = 0.014
const GUARDRAIL_RATE_CAD = 0.007
const EXTRA_NUMBER_MONTHLY_CAD = 20
const MINUTE_OPTIONS = [100, 300, 500, 1000, 2500, 5000]

export default function Billing() {
  const [billing, setBilling] = useState<Awaited<ReturnType<typeof fetchBillingStatus>> | null>(null)
  const subscription = billing?.subscription ?? null
  const service = billing?.service ?? null
  const [managingBilling, setManagingBilling] = useState(false)
  const [modelRate, setModelRate] = useState(0)
  const [assignedModelName, setAssignedModelName] = useState('assigned AI model')
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
          fetchBillingStatus(true),
          supabase
            .from('ai_models')
            .select('id, display_name, provider, tier_name, customer_price_per_minute_cad')
            .eq('is_active', true)
            .order('sort_order', { ascending: true }),
        ])
        const loadedSubscription = billingStatus.subscription
        setBilling(billingStatus)
        const configured = { ...loadedSubscription, ...(loadedSubscription?.pending_configuration ?? {}) }
        setSelectedMinutes(String(configured.monthly_minutes ?? 300))

        if (configured.ai_model_id) {
          const assignedModel = (modelsResult.data ?? []).find(
            (model) => model.id === configured.ai_model_id
          )
          setModelRate(Math.max(0, Number(assignedModel?.customer_price_per_minute_cad ?? 0)))
          setAssignedModelName(assignedModel?.display_name || 'assigned AI model')
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
    const base = configuration.plan_name === 'Recepta Pro' ? 299 : 199
    return base + monthlyMinutes * modelRate +
      (configuration.pii_redaction_enabled ? monthlyMinutes * PII_RATE_CAD : 0) +
      (configuration.safety_guardrails_enabled ? monthlyMinutes * GUARDRAIL_RATE_CAD : 0) +
      Math.max(0, Number(configuration.extra_phone_numbers ?? 0)) * EXTRA_NUMBER_MONTHLY_CAD
  }, [modelRate, monthlyMinutes, subscription])

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

  const cancelSubscription = async (timing: 'immediate' | 'period_end') => {
    setManagingBilling(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response = await fetch('/.netlify/functions/cancel-subscription', {
        method: 'POST', body: JSON.stringify({ timing }),
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not confirm cancellation.')
      setBilling(await fetchBillingStatus(true))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not confirm cancellation.')
    } finally {
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

      <section className="dashboardMain billingPageMain">
        <div className="dashboardHeader">
          <div>
            <h1>Minutes &amp; billing</h1>
          </div>
        </div>

        <BillingAccessNotice subscription={subscription} service={service} />

        {error && <p className="calendarAlert calendarAlert--error" role="alert">{error}</p>}

        {!subscription ? (
          <div className="dashboardEmptyState">
            <strong>Your subscription is not configured yet.</strong>
            <p>Contact Recepta so we can assign your plan and receptionist configuration.</p>
            <a className="btn btnPrimary" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
          </div>
        ) : (
          <>
            {billing?.balance && <BillingOverview
              subscription={subscription}
              balance={billing.balance}
              simulation={billing.simulation}
              service={service}
              managing={managingBilling}
              onManage={() => void openBillingPortal()}
              onCancel={(timing) => void cancelSubscription(timing)}
            />}

            <p className="billingCheckoutDisclaimer" style={{ marginTop: 20 }}>
              Looking for plans, models or add-ons? <a href="/our-product#plans" style={{ color: '#81e7a6', textDecoration: 'underline' }}>Explore Our Product</a> or <a href="/contact" style={{ color: '#81e7a6', textDecoration: 'underline' }}>contact Recepta</a> to discuss a change.
            </p>

            <section className="billingConfigurator">
              <div className="billingConfiguratorHeading">
                <h2>Change your monthly allowance</h2>
                <p>Choose a preset or enter the number of minutes you need each month.</p>
              </div>

              <div className="billingConfigSection">
                <div className="billingMinuteChoices">
                  {MINUTE_OPTIONS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      className={`billingMinuteChoice ${monthlyMinutes === minutes ? 'billingMinuteChoice--selected' : ''}`}
                      aria-pressed={monthlyMinutes === minutes}
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
                {subscription.pending_configuration && <p className="calendarAlert" role="status">Recepta prepared a configuration awaiting payment: {checkoutConfiguration?.plan_name}, {assignedModelName}, PII redaction {checkoutConfiguration?.pii_redaction_enabled ? 'on' : 'off'}, Safety Guardrails {checkoutConfiguration?.safety_guardrails_enabled ? 'on' : 'off'}, and {checkoutConfiguration?.extra_phone_numbers ?? 0} additional numbers. Stripe applies these billing changes after payment succeeds.</p>}
                <div className="billingCheckoutSummaryHead">
                  <div>
                    <span className="billingPremiumEyebrow">NEW ALLOWANCE</span>
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
                        : subscription.status === 'cancelled'
                          ? 'Reactivate subscription'
                          : service?.service_status === 'ongoing' ? 'Continue to Stripe payment' : 'Pay & activate configuration'}
                  </button>
                ) : (
                  <a className="btn btnPrimary billingUpdateSubscription" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
                )}

                <p className="billingCheckoutDisclaimer">Stripe billing changes take effect after successful payment. Your current service access appears above.</p>
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  )
}
