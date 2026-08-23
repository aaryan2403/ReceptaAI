import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type Client = {
  company_name: string | null
  owner_name: string | null
  owner_phone: string | null
  contact_email: string | null
  status: ClientStatus
  created_at: string
}

type Agent = {
  agent_name: string | null
  phone_number: string | null
  business_hours: string | null
  status: ClientStatus
}

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  status: 'pending' | 'active' | 'past_due' | 'cancelled'
  next_billing_date: string | null
}

type Onboarding = {
  business_phone: string | null
  service_area: string | null
  tone_preference: string | null
  voice_preference: string | null
  completed: boolean
}

export default function Settings() {
  const navigate = useNavigate()

  const [client, setClient] = useState<Client | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [onboarding, setOnboarding] =
    useState<Onboarding | null>(null)

  const [loading, setLoading] = useState(true)
  const [resettingPassword, setResettingPassword] =
    useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const loadSettings = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: clientData },
        { data: agentData },
        { data: subscriptionData },
        { data: onboardingData },
      ] = await Promise.all([
        supabase
          .from('clients')
          .select(
            'company_name, owner_name, owner_phone, contact_email, status, created_at'
          )
          .eq('id', user.id)
          .single(),

        supabase
          .from('agents')
          .select(
            'agent_name, phone_number, business_hours, status'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('subscriptions')
          .select(
            'plan_name, monthly_price, status, next_billing_date'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('onboarding')
          .select(
            'business_phone, service_area, tone_preference, voice_preference, completed'
          )
          .eq('client_id', user.id)
          .maybeSingle(),
      ])

      if (clientData) {
        setClient(clientData)
      }

      if (agentData) {
        setAgent(agentData)
      }

      if (subscriptionData) {
        setSubscription(subscriptionData)
      }

      if (onboardingData) {
        setOnboarding(onboardingData)
      }

      setLoading(false)
    }

    loadSettings()
  }, [])

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/login')
  }

  const handlePasswordReset = async () => {
    if (!client?.contact_email) {
      setMessage(
        'No account email is available for password reset.'
      )
      return
    }

    setResettingPassword(true)
    setMessage('')

    const { error } =
      await supabase.auth.resetPasswordForEmail(
        client.contact_email,
        {
          redirectTo:
            `${window.location.origin}/reset-password`,
        }
      )

    if (error) {
      setMessage(
        'Could not send the password reset email.'
      )
    } else {
      setMessage(
        'Password reset email sent. Check your inbox.'
      )
    }

    setResettingPassword(false)
  }

  const accountStatusLabel = () => {
    switch (client?.status) {
      case 'live':
        return 'Live'

      case 'testing':
        return 'Testing'

      case 'paused':
        return 'Paused'

      default:
        return 'Setup'
    }
  }

  const billingStatusLabel = () => {
    switch (subscription?.status) {
      case 'active':
        return 'Active'

      case 'past_due':
        return 'Payment due'

      case 'cancelled':
        return 'Cancelled'

      default:
        return 'Setup pending'
    }
  }

  const agentStatusLabel = () => {
    switch (agent?.status) {
      case 'live':
        return 'Live'

      case 'testing':
        return 'Testing'

      case 'paused':
        return 'Paused'

      default:
        return 'Setup'
    }
  }

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>
              Loading account information...
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">

      {/* SIDEBAR */}

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
            className="dashboardNavItem"
          >
            Billing
          </a>

          <a
            href="/dashboard/settings"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Settings
          </a>
        </nav>

        <button
          className="btn btnOutline"
          type="button"
          onClick={handleLogout}
          style={{
            width: '100%',
            marginTop: '28px',
          }}
        >
          Log out
        </button>
      </aside>

      {/* MAIN */}

      <section className="dashboardMain">

        {/* HEADER */}

        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              ACCOUNT
            </p>

            <h1>
              Account Settings
            </h1>

            <p>
              Your business, subscription and
              Recepta account information.
            </p>
          </div>

          <span
            className={
              `settingsAccountBadge settingsAccountBadge--${
                client?.status || 'setup'
              }`
            }
          >
            {accountStatusLabel()}
          </span>
        </div>

        {/* BUSINESS */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">
                BUSINESS
              </span>

              <h2>
                Company information
              </h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Company name
              </span>

              <strong>
                {client?.company_name ||
                  'Not provided'}
              </strong>
            </div>

            <div>
              <span>
                Owner / primary contact
              </span>

              <strong>
                {client?.owner_name ||
                  'Not provided'}
              </strong>
            </div>

            <div>
              <span>
                Account email
              </span>

              <strong>
                {client?.contact_email ||
                  'Not provided'}
              </strong>
            </div>

            <div>
              <span>
                Owner phone
              </span>

              <strong>
                {client?.owner_phone ||
                  'Not provided'}
              </strong>
            </div>

            <div>
              <span>
                Business phone
              </span>

              <strong>
                {onboarding?.business_phone ||
                  'Not provided'}
              </strong>
            </div>

            <div>
              <span>
                Service area
              </span>

              <strong>
                {onboarding?.service_area ||
                  'Not configured'}
              </strong>
            </div>
          </div>
        </section>

        {/* ACCOUNT */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">
                ACCOUNT
              </span>

              <h2>
                Recepta account
              </h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Member since
              </span>

              <strong>
                {client?.created_at
                  ? new Date(
                      client.created_at
                    ).toLocaleDateString()
                  : '—'}
              </strong>
            </div>

            <div>
              <span>
                Account status
              </span>

              <strong>
                {accountStatusLabel()}
              </strong>
            </div>

            <div>
              <span>
                Onboarding
              </span>

              <strong>
                {onboarding?.completed
                  ? 'Completed'
                  : 'In progress'}
              </strong>
            </div>

            <div>
              <span>
                Account type
              </span>

              <strong>
                Recepta Client
              </strong>
            </div>
          </div>
        </section>

        {/* AI RECEPTIONIST */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">
                AI RECEPTIONIST
              </span>

              <h2>
                Assigned receptionist
              </h2>
            </div>

            <a
              href="/dashboard/agent"
              className="btn btnOutline"
            >
              View Agent
            </a>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Agent name
              </span>

              <strong>
                {agent?.agent_name ||
                  'Not assigned'}
              </strong>
            </div>

            <div>
              <span>
                Agent phone
              </span>

              <strong>
                {agent?.phone_number ||
                  'Not assigned'}
              </strong>
            </div>

            <div>
              <span>
                Operating hours
              </span>

              <strong>
                {agent?.business_hours ||
                  'Not configured'}
              </strong>
            </div>

            <div>
              <span>
                Agent status
              </span>

              <strong>
                {agentStatusLabel()}
              </strong>
            </div>

            <div>
              <span>
                Voice
              </span>

              <strong>
                {onboarding?.voice_preference ||
                  'Not configured'}
              </strong>
            </div>

            <div>
              <span>
                Tone
              </span>

              <strong>
                {onboarding?.tone_preference ||
                  'Not configured'}
              </strong>
            </div>
          </div>

          <div
            className="settingsActionRow"
            style={{
              marginTop: '14px',
            }}
          >
            <div>
              <strong>
                Need to change your receptionist?
              </strong>

              <p>
                Greeting, voice, operating hours,
                transfer rules and receptionist
                behaviour are managed by Recepta.
              </p>
            </div>

            <a
              className="btn btnOutline"
              href="mailto:support@recepta.ca?subject=Recepta%20Agent%20Change%20Request"
            >
              Request Change
            </a>
          </div>
        </section>

        {/* PLAN */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">
                SUBSCRIPTION
              </span>

              <h2>
                Plan & billing
              </h2>
            </div>

            <a
              href="/dashboard/billing"
              className="btn btnOutline"
            >
              View Billing
            </a>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Current plan
              </span>

              <strong>
                {subscription?.plan_name ||
                  'Not assigned'}
              </strong>
            </div>

            <div>
              <span>
                Monthly price
              </span>

              <strong>
                {subscription?.monthly_price !==
                  null &&
                subscription?.monthly_price !==
                  undefined
                  ? `C$${subscription.monthly_price.toFixed(
                      2
                    )}`
                  : '—'}
              </strong>
            </div>

            <div>
              <span>
                Billing status
              </span>

              <strong>
                {billingStatusLabel()}
              </strong>
            </div>

            <div>
              <span>
                Next billing date
              </span>

              <strong>
                {subscription?.next_billing_date
                  ? new Date(
                      subscription.next_billing_date
                    ).toLocaleDateString()
                  : 'Not scheduled'}
              </strong>
            </div>
          </div>

          {!isPro && subscription && (
            <div
              className="settingsActionRow"
              style={{
                marginTop: '14px',
              }}
            >
              <div>
                <strong>
                  Need appointment booking?
                </strong>

                <p>
                  Recepta Pro adds AI appointment
                  booking, employee schedules and
                  appointment management.
                </p>
              </div>

              <a
                className="btn btnPrimary"
                href="mailto:support@recepta.ca?subject=Upgrade%20to%20Recepta%20Pro"
              >
                Upgrade to Pro
              </a>
            </div>
          )}
        </section>

        {/* SECURITY */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">
                SECURITY
              </span>

              <h2>
                Account security
              </h2>
            </div>
          </div>

          <div className="settingsActionRow">
            <div>
              <strong>
                Password
              </strong>

              <p>
                Send a secure password reset link
                to your account email.
              </p>
            </div>

            <button
              className="btn btnOutline"
              type="button"
              onClick={handlePasswordReset}
              disabled={resettingPassword}
            >
              {resettingPassword
                ? 'Sending...'
                : 'Reset Password'}
            </button>
          </div>

          {message && (
            <p className="settingsMessage">
              {message}
            </p>
          )}
        </section>

        {/* SUPPORT */}

        <section className="settingsPanel settingsSupportPanel">
          <div>
            <span className="settingsSectionLabel">
              SUPPORT
            </span>

            <h2>
              Need help with your receptionist?
            </h2>

            <p>
              Contact Recepta for configuration
              changes, account questions, billing
              support or technical help.
            </p>
          </div>

          <a
            className="btn btnPrimary"
            href="mailto:support@recepta.ca"
          >
            Contact Recepta
          </a>
        </section>
      </section>
    </main>
  )
}
