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

  const getStatusLabel = () => {
    switch (subscription?.status) {
      case 'active':
        return 'Active'
      case 'past_due':
        return 'Payment Due'
      case 'cancelled':
        return 'Cancelled'
      default:
        return 'Billing Setup Pending'
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
            <h1>Billing & Plan</h1>
            <p>View your Recepta subscription and payment status.</p>
          </div>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading billing information...</p>
          </div>
        ) : subscription ? (
          <div className="dashboardStats">
            <div className="dashboardStatCard">
              <span>Current Plan</span>
              <strong>{subscription.plan_name || 'Not assigned'}</strong>
            </div>

            <div className="dashboardStatCard">
              <span>Monthly Price</span>
              <strong>
                {subscription.monthly_price !== null
                  ? `$${subscription.monthly_price.toFixed(2)}`
                  : '—'}
              </strong>
            </div>

            <div className="dashboardStatCard">
              <span>Payment Status</span>
              <strong>{getStatusLabel()}</strong>
            </div>

            <div className="dashboardStatCard">
              <span>Next Billing Date</span>
              <strong>
                {subscription.next_billing_date
                  ? new Date(subscription.next_billing_date).toLocaleDateString()
                  : '—'}
              </strong>
            </div>
          </div>
        ) : (
          <div className="dashboardEmptyState">
            <h2>Billing setup pending</h2>
            <p>
              Your Recepta plan will appear here once onboarding and payment setup
              are completed.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
