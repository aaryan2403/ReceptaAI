import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  status: 'pending' | 'active' | 'past_due' | 'cancelled'
  next_billing_date: string | null
}

export default function Billing() {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadSubscription = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('subscriptions')
        .select('plan_name, monthly_price, status, next_billing_date')
        .eq('client_id', user.id)
        .maybeSingle()

      if (!error && data) {
        setSubscription(data)
      }

      setLoading(false)
    }

    loadSubscription()
  }, [])

  const statusLabel = () => {
    switch (subscription?.status) {
      case 'active':
        return 'Active'
      case 'past_due':
        return 'Payment Due'
      case 'cancelled':
        return 'Cancelled'
      default:
        return 'Setup Pending'
    }
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">
            Overview
          </a>
          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>
          <a href="/dashboard/appointments" className="dashboardNavItem">
            Appointments
          </a>
          <a href="/dashboard/agent" className="dashboardNavItem">
            Agent
          </a>
          <a
            href="/dashboard/billing"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Billing
          </a>
          <a href="/dashboard/settings" className="dashboardNavItem">
            Settings
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">BILLING</p>
            <h1>Your Recepta plan</h1>
            <p>Manage your subscription and billing details.</p>
          </div>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading billing...</p>
          </div>
        ) : subscription ? (
          <div className="billingLayout">
            <div className="billingHeroCard">
              <div className="billingPlanTop">
                <div>
                  <span className="billingLabel">CURRENT PLAN</span>

                  <h2>
                    {subscription.plan_name || 'Recepta Pro'}
                  </h2>
                </div>

                <span
                  className={`billingStatus billingStatus--${subscription.status}`}
                >
                  {statusLabel()}
                </span>
              </div>

              <div className="billingPrice">
                <strong>
                  {subscription.monthly_price !== null
                    ? `$${subscription.monthly_price.toFixed(0)}`
                    : '—'}
                </strong>

                <span>/ month</span>
              </div>

              <p className="billingPlanDescription">
                Your AI receptionist, managed and configured by Recepta.
              </p>

              <div className="billingFeatures">
                <span>✓ 24/7 AI call answering</span>
                <span>✓ Appointment booking</span>
                <span>✓ Call summaries & analytics</span>
                <span>✓ Human handoff</span>
                <span>✓ Managed onboarding & configuration</span>
              </div>

              <button className="btn btnPrimary billingManageButton">
                Manage Billing
              </button>
            </div>

            <div className="billingSideGrid">
              <div className="billingInfoCard">
                <span>Next Billing Date</span>
                <strong>
                  {subscription.next_billing_date
                    ? new Date(
                        subscription.next_billing_date
                      ).toLocaleDateString()
                    : 'Not scheduled'}
                </strong>
              </div>

              <div className="billingInfoCard">
                <span>Payment Status</span>
                <strong>{statusLabel()}</strong>
              </div>

              <div className="billingInfoCard">
                <span>Billing Cycle</span>
                <strong>Monthly</strong>
              </div>

              <div className="billingInfoCard">
                <span>Support</span>
                <strong>Managed by Recepta</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className="dashboardEmptyState">
            <h2>Billing setup pending</h2>

            <p>
              Your subscription details will appear here once your onboarding
              and payment setup are completed.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
