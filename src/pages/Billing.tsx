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
  status: SubscriptionStatus
  next_billing_date: string | null
}

type CallRecord = {
  duration_seconds: number
}

export default function Billing() {
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)

  const [calls, setCalls] = useState<CallRecord[]>([])

  const [loading, setLoading] = useState(true)

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
        { data: subscriptionData },
        { data: callsData },
      ] = await Promise.all([
        supabase
          .from('subscriptions')
          .select(
            'plan_name, monthly_price, status, next_billing_date'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('calls')
          .select('duration_seconds')
          .eq('client_id', user.id),
      ])

      if (subscriptionData) {
        setSubscription(subscriptionData)
      }

      if (callsData) {
        setCalls(callsData)
      }

      setLoading(false)
    }

    loadBilling()
  }, [])

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

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

          <a
            href="/dashboard/calls"
            className="dashboardNavItem"
          >
            Calls
          </a>

          {isPro && (
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

            <h1>Your Recepta plan</h1>

            <p>
              View your subscription, usage and billing information.
            </p>
          </div>
        </div>

        {!subscription ? (
          <div className="dashboardEmptyState">
            <h2>Billing setup pending</h2>

            <p>
              Your subscription information will appear here once your plan
              has been assigned.
            </p>
          </div>
        ) : (
          <>
            <div
              className={
                isPro
                  ? 'billingPremiumHero billingPremiumHero--pro'
                  : 'billingPremiumHero billingPremiumHero--standard'
              }
            >
              <div className="billingPremiumTop">
                <div>
                  <span className="billingPremiumEyebrow">
                    CURRENT PLAN
                  </span>

                  <h2>
                    {isPro
                      ? 'Recepta Pro'
                      : 'Recepta Standard'}
                  </h2>

                  <p>
                    {isPro
                      ? 'The complete Recepta experience with appointment booking and employee availability.'
                      : 'Professional AI call answering for businesses that do not require appointment booking.'}
                  </p>
                </div>

                <span
                  className={`billingStatus ${statusInfo.className}`}
                >
                  {statusInfo.label}
                </span>
              </div>

              <div className="billingPremiumPrice">
                <strong>
                  C$
                  {subscription.monthly_price !== null
                    ? subscription.monthly_price.toFixed(0)
                    : isPro
                      ? '300'
                      : '200'}
                </strong>

                <span>/ month</span>
              </div>

              <div className="billingPremiumFeatures">
                <div>
                  <span>✓</span>

                  <p>
                    24/7 AI call answering
                  </p>
                </div>

                <div>
                  <span>✓</span>

                  <p>
                    Customer question handling
                  </p>
                </div>

                <div>
                  <span>✓</span>

                  <p>
                    Call summaries and analytics
                  </p>
                </div>

                <div>
                  <span>✓</span>

                  <p>
                    Human call transfer support
                  </p>
                </div>

                <div>
                  <span>✓</span>

                  <p>
                    Managed setup and configuration
                  </p>
                </div>

                {isPro && (
                  <>
                    <div>
                      <span>✓</span>

                      <p>
                        AI appointment booking
                      </p>
                    </div>

                    <div>
                      <span>✓</span>

                      <p>
                        Employee availability management
                      </p>
                    </div>

                    <div>
                      <span>✓</span>

                      <p>
                        Today's appointment dashboard
                      </p>
                    </div>
                  </>
                )}
              </div>

              {!isPro && (
                <div className="billingUpgradeStrip">
                  <div>
                    <span className="billingPremiumEyebrow">
                      WANT APPOINTMENT BOOKING?
                    </span>

                    <strong>
                      Upgrade to Recepta Pro
                    </strong>

                    <p>
                      Add appointment booking, employee schedules and the
                      appointment dashboard for C$100 more per month.
                    </p>
                  </div>

                  <a
                    href="mailto:support@recepta.ca?subject=Upgrade%20to%20Recepta%20Pro"
                    className="btn btnPrimary"
                  >
                    Upgrade to Pro
                  </a>
                </div>
              )}
            </div>

            <div className="billingDashboardGrid">

              {/* USAGE */}

              <section className="billingModernCard">
                <div className="billingModernHeading">
                  <div>
                    <span className="billingPremiumEyebrow">
                      USAGE
                    </span>

                    <h2>
                      Call usage
                    </h2>
                  </div>
                </div>

                <div className="billingUsageNumber">
                  <strong>
                    {minutesUsed}
                  </strong>

                  <span>
                    minutes used
                  </span>
                </div>

                <p className="billingUsageNote">
                  Your call usage is calculated from conversations handled by
                  your Recepta receptionist.
                </p>
              </section>

              {/* BILLING DETAILS */}

              <section className="billingModernCard">
                <div className="billingModernHeading">
                  <div>
                    <span className="billingPremiumEyebrow">
                      BILLING DETAILS
                    </span>

                    <h2>
                      Subscription
                    </h2>
                  </div>
                </div>

                <div className="billingModernRows">
                  <div>
                    <span>Plan</span>

                    <strong>
                      {subscription.plan_name ||
                        'Not assigned'}
                    </strong>
                  </div>

                  <div>
                    <span>Billing cycle</span>

                    <strong>
                      Monthly
                    </strong>
                  </div>

                  <div>
                    <span>Status</span>

                    <strong>
                      {statusInfo.label}
                    </strong>
                  </div>

                  <div>
                    <span>Next billing date</span>

                    <strong>
                      {subscription.next_billing_date
                        ? new Date(
                            subscription.next_billing_date
                          ).toLocaleDateString()
                        : 'Not scheduled'}
                    </strong>
                  </div>
                </div>
              </section>
            </div>

            <section className="billingManagementCard">
              <div>
                <span className="billingPremiumEyebrow">
                  BILLING SUPPORT
                </span>

                <h2>
                  Need to change your plan or payment details?
                </h2>

                <p>
                  Contact Recepta for upgrades, billing questions, payment
                  changes or subscription support.
                </p>
              </div>

              <a
                href="mailto:support@recepta.ca?subject=Billing%20Support"
                className="btn btnOutline"
              >
                Contact Billing Support
              </a>
            </section>
          </>
        )}
      </section>
    </main>
  )
}
