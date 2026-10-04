import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchClientCalls } from '../lib/clientCalls'

type PlanName = 'Recepta Standard' | 'Recepta Pro'
type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'cancelled'

type Subscription = {
  plan_name: PlanName | null
  monthly_price: number | null
  monthly_minutes: number | null
  ai_model_id: string | null
  pii_redaction_enabled: boolean
  safety_guardrails_enabled: boolean
  extra_phone_numbers: number
  status: SubscriptionStatus
  next_billing_date: string | null
  current_period_start: string | null
  rollover_seconds: number
  stripe_subscription_id: string | null
}

type CallRecord = { duration_seconds: number; started_at: string }

const MAX_MONTHLY_MINUTES = 100_000_000
const PII_RATE_CAD = 0.014
const GUARDRAIL_RATE_CAD = 0.007
const EXTRA_NUMBER_MONTHLY_CAD = 20

const isMissingRolloverColumn = (error: { code?: string; message?: string } | null) => {
  const message = error?.message?.toLowerCase() ?? ''
  return message.includes('rollover_seconds') &&
    (error?.code === '42703' || error?.code === 'PGRST204' ||
      message.includes('does not exist') || message.includes('schema cache'))
}

const loadSubscription = async (clientId: string) => {
  const columns = 'plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, status, next_billing_date, current_period_start, rollover_seconds, stripe_subscription_id'
  const result = await supabase
    .from('subscriptions')
    .select(columns)
    .eq('client_id', clientId)
    .maybeSingle()

  if (!result.error) return result.data as Subscription | null
  if (!isMissingRolloverColumn(result.error)) throw result.error

  const fallback = await supabase
    .from('subscriptions')
    .select('plan_name, monthly_price, monthly_minutes, ai_model_id, pii_redaction_enabled, safety_guardrails_enabled, extra_phone_numbers, status, next_billing_date, current_period_start, stripe_subscription_id')
    .eq('client_id', clientId)
    .maybeSingle()

  if (fallback.error) throw fallback.error
  return fallback.data ? { ...fallback.data, rollover_seconds: 0 } as Subscription : null
}

export default function Billing() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [modelRate, setModelRate] = useState(0)
  const [selectedMinutes, setSelectedMinutes] = useState('300')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    const load = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return

        const loadedSubscription = await loadSubscription(user.id)
        setSubscription(loadedSubscription)
        setSelectedMinutes(String(loadedSubscription?.monthly_minutes ?? 300))

        if (loadedSubscription?.ai_model_id) {
          const { data } = await supabase
            .from('ai_models')
            .select('customer_price_per_minute_cad')
            .eq('id', loadedSubscription.ai_model_id)
            .maybeSingle()
          setModelRate(Math.max(0, Number(data?.customer_price_per_minute_cad ?? 0)))
        }

        try {
          const result = await fetchClientCalls()
          setCalls(result.calls)
        } catch (callError) {
          console.error('Could not load billing usage:', callError)
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load billing.')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [])

  const monthlyMinutes = Math.floor(Number(selectedMinutes))
  const proposedTotal = useMemo(() => {
    if (!subscription || !Number.isFinite(monthlyMinutes)) return 0
    const base = subscription.plan_name === 'Recepta Pro' ? 300 : 200
    return base + monthlyMinutes * modelRate +
      (subscription.pii_redaction_enabled ? monthlyMinutes * PII_RATE_CAD : 0) +
      (subscription.safety_guardrails_enabled ? monthlyMinutes * GUARDRAIL_RATE_CAD : 0) +
      Math.max(0, Number(subscription.extra_phone_numbers ?? 0)) * EXTRA_NUMBER_MONTHLY_CAD
  }, [modelRate, monthlyMinutes, subscription])

  const secondsUsed = useMemo(() => {
    const periodStart = subscription?.current_period_start
      ? new Date(subscription.current_period_start).getTime()
      : 0
    return calls
      .filter((call) => new Date(call.started_at).getTime() >= periodStart)
      .reduce((total, call) => total + (call.duration_seconds || 0), 0)
  }, [calls, subscription])

  const minutesUsed = Math.ceil(secondsUsed / 60)
  const rolloverMinutes = Math.floor(Math.max(0, Number(subscription?.rollover_seconds ?? 0)) / 60)
  const availableMinutes = Math.max(0, Number(subscription?.monthly_minutes ?? 0) + rolloverMinutes)
  const minutesRemaining = Math.max(0, availableMinutes - minutesUsed)
  const usagePercent = availableMinutes > 0
    ? Math.min(100, Math.round((minutesUsed / availableMinutes) * 100))
    : 0

  const saveMinutes = async () => {
    setError('')
    setSuccess('')

    if (!subscription || subscription.status !== 'active') {
      setError('Only an active subscription can change monthly minutes.')
      return
    }
    if (!Number.isFinite(monthlyMinutes) || monthlyMinutes < 1 || monthlyMinutes > MAX_MONTHLY_MINUTES) {
      setError('Monthly minutes must be between 1 and 100,000,000.')
      return
    }

    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')

      const response = await fetch('/.netlify/functions/update-subscription', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'change_minutes', monthlyMinutes }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not update monthly minutes.')

      setSubscription((current) => current ? {
        ...current,
        monthly_minutes: body.monthlyMinutes,
        monthly_price: body.monthlyPrice,
      } : current)
      setSuccess(body.unchanged
        ? 'Your monthly minute allowance is already set to this amount.'
        : 'Monthly minutes and billing were updated successfully.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update monthly minutes.')
    } finally {
      setSaving(false)
    }
  }

  const startRenewal = async () => {
    setError('')
    setSuccess('')
    if (!subscription?.plan_name || !subscription.ai_model_id) {
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
      setError(renewError instanceof Error ? renewError.message : 'Could not renew subscription.')
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

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand"><img src="/components/logoR.png" alt="Recepta" /></a>
        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">Overview</a>
          <a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
          <a href="/dashboard/appointments" className="dashboardNavItem">Appointments</a>
          <a href="/dashboard/agent" className="dashboardNavItem">Agent</a>
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

        {!subscription ? (
          <div className="dashboardEmptyState">
            <strong>Your subscription is not configured yet.</strong>
            <p>Contact Recepta so we can assign your plan and receptionist configuration.</p>
            <a className="btn btnPrimary" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
          </div>
        ) : (
          <>
            <section className="billingHeroCard">
              <div className="billingPlanHeader">
                <div>
                  <span className="billingPremiumEyebrow">CURRENT SUBSCRIPTION</span>
                  <h2>{subscription.plan_name || 'Recepta plan'}</h2>
                  <p>{statusLabel}</p>
                </div>
                <div className="billingPriceBlock">
                  <strong>C${Number(subscription.monthly_price ?? 0).toFixed(2)}</strong>
                  <span>/ month</span>
                </div>
              </div>
            </section>

            <section className="billingUsageCard">
              <div className="billingUsageHeader">
                <div><span className="billingPremiumEyebrow">MONTHLY USAGE</span><h2>{minutesUsed.toLocaleString()} minutes used</h2></div>
                <strong>{minutesRemaining.toLocaleString()} remaining</strong>
              </div>
              <div className="billingProgressTrack"><div className="billingProgressFill" style={{ width: `${usagePercent}%` }} /></div>
              <p>{Number(subscription.monthly_minutes ?? 0).toLocaleString()} monthly minutes{rolloverMinutes > 0 ? ` + ${rolloverMinutes.toLocaleString()} rollover minutes` : ''}.</p>
            </section>

            <section className="billingCheckoutSummary" style={{ marginTop: '24px' }}>
              <span className="billingPremiumEyebrow">CHANGE MONTHLY MINUTES</span>
              <h2>Choose your allowance</h2>
              <p>Everything else is managed by Recepta. Contact us if you need plan, model, phone number, security or agent changes.</p>

              <div className="billingCustomMinutes" style={{ marginTop: '20px' }}>
                <label>
                  Monthly minutes
                  <input
                    type="number"
                    min="1"
                    max={MAX_MONTHLY_MINUTES}
                    step="1"
                    value={selectedMinutes}
                    onChange={(event) => setSelectedMinutes(event.target.value)}
                  />
                </label>
              </div>

              <div className="billingPlanHeader" style={{ marginTop: '22px' }}>
                <div><span>Estimated monthly total</span><p>Based on the configuration assigned by Recepta.</p></div>
                <div className="billingPriceBlock"><strong>C${proposedTotal.toFixed(2)}</strong><span>/ month</span></div>
              </div>

              {subscription.status === 'active' ? (
                <button type="button" className="btn btnPrimary billingUpdateSubscription" onClick={saveMinutes} disabled={saving}>
                  {saving ? 'Updating Minutes...' : 'Update Monthly Minutes'}
                </button>
              ) : subscription.status === 'cancelled' || subscription.status === 'pending' ? (
                <button type="button" className="btn btnPrimary billingUpdateSubscription" onClick={startRenewal} disabled={saving}>
                  {saving ? 'Opening Stripe Checkout...' : 'Continue to Payment'}
                </button>
              ) : (
                <a className="btn btnPrimary billingUpdateSubscription" href="mailto:receptahelp02@gmail.com">Contact Recepta</a>
              )}

              {success && <p className="calendarAlert">{success}</p>}
              {error && <p className="calendarAlert calendarAlert--error" role="alert">{error}</p>}
            </section>
          </>
        )}
      </section>
    </main>
  )
}
