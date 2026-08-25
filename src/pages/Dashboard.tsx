import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type Client = {
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
}

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  monthly_minutes: number | null
  status: string | null
}

type Call = {
  duration_seconds: number
  appointment_booked: boolean
}

type Appointment = {
  id: string
  appointment_time: string | null
  status: 'booked' | 'cancelled' | 'completed'
}

export default function Dashboard() {
  const [client, setClient] = useState<Client | null>(null)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] =
    useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadDashboard = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: clientData },
        { data: subscriptionData },
        { data: callsData },
      ] = await Promise.all([
        supabase
          .from('clients')
          .select('company_name, contact_email, status')
          .eq('id', user.id)
          .single(),

        supabase
          .from('subscriptions')
          .select(
            'plan_name, monthly_price, monthly_minutes, status'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('calls')
          .select('duration_seconds, appointment_booked')
          .eq('client_id', user.id),
      ])

      if (clientData) {
        setClient(clientData)
      }

      if (subscriptionData) {
        setSubscription(subscriptionData)
      }

      if (callsData) {
        setCalls(callsData)
      }

      const isPro =
        subscriptionData?.status === 'active' &&
        subscriptionData?.plan_name === 'Recepta Pro'

      if (isPro) {
        const { data: appointmentsData } = await supabase
          .from('appointments')
          .select('id, appointment_time, status')
          .eq('client_id', user.id)

        if (appointmentsData) {
          setAppointments(appointmentsData)
        }
      } else {
        setAppointments([])
      }

      setLoading(false)
    }

    loadDashboard()
  }, [])

  const isSubscriptionCancelled =
    subscription?.status === 'cancelled'

  const isSubscriptionPending =
    !subscription ||
    subscription.status === 'pending'

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const isStandard =
    subscription?.plan_name === 'Recepta Standard'

  const stats = useMemo(() => {
    const callsAnswered = calls.length

    const totalSeconds = calls.reduce(
      (total, call) =>
        total + (call.duration_seconds || 0),
      0
    )

    const minutesTalked =
      Math.round(totalSeconds / 60)

    const monthlyMinutes =
      subscription?.monthly_minutes ?? 300

    const minutesRemaining = Math.max(
      monthlyMinutes - minutesTalked,
      0
    )

    const usagePercentage =
      monthlyMinutes > 0
        ? Math.min(
            (minutesTalked / monthlyMinutes) * 100,
            100
          )
        : 0

    const averageSeconds =
      callsAnswered > 0
        ? Math.round(totalSeconds / callsAnswered)
        : 0

    const averageMinutes =
      Math.floor(averageSeconds / 60)

    const averageRemainingSeconds =
      averageSeconds % 60

    const today = new Date()

    const appointmentsToday =
      appointments.filter((appointment) => {
        if (
          !appointment.appointment_time ||
          appointment.status === 'cancelled'
        ) {
          return false
        }

        const appointmentDate =
          new Date(appointment.appointment_time)

        return (
          appointmentDate.getFullYear() ===
            today.getFullYear() &&
          appointmentDate.getMonth() ===
            today.getMonth() &&
          appointmentDate.getDate() ===
            today.getDate()
        )
      }).length

    return {
      callsAnswered,
      minutesTalked,
      monthlyMinutes,
      minutesRemaining,
      usagePercentage,
      appointmentsToday,

      averageDuration:
        callsAnswered > 0
          ? `${averageMinutes}m ${String(
              averageRemainingSeconds
            ).padStart(2, '0')}s`
          : '0m 00s',
    }
  }, [calls, appointments, subscription])

  const getStatusInfo = () => {
    switch (client?.status) {
      case 'live':
        return {
          label: 'Agent Live',
          color: '#00e676',
          background: 'rgba(0, 230, 118, 0.10)',
          border: 'rgba(0, 230, 118, 0.20)',
          shadow: 'rgba(0, 230, 118, 0.7)',
        }

      case 'testing':
        return {
          label: 'Agent Testing',
          color: '#58b7ff',
          background: 'rgba(88, 183, 255, 0.10)',
          border: 'rgba(88, 183, 255, 0.20)',
          shadow: 'rgba(88, 183, 255, 0.7)',
        }

      case 'paused':
        return {
          label: 'Agent Paused',
          color: '#a0a0a0',
          background: 'rgba(160, 160, 160, 0.10)',
          border: 'rgba(160, 160, 160, 0.20)',
          shadow: 'rgba(160, 160, 160, 0.5)',
        }

      default:
        return {
          label: 'AI Configuration Pending',
          color: '#f5b942',
          background: 'rgba(245, 185, 66, 0.08)',
          border: 'rgba(245, 185, 66, 0.25)',
          shadow: 'rgba(245, 185, 66, 0.6)',
        }
    }
  }

  const status = getStatusInfo()

  const onboardingStep =
    client?.status === 'live'
      ? 4
      : client?.status === 'testing'
        ? 3
        : client?.status === 'paused'
          ? 3
          : 2

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Loading your Recepta dashboard...
        </section>
      </main>
    )
  }

  if (isSubscriptionPending) {
    return (
      <main className="dashboardPage">
        <aside className="dashboardSidebar">
          <a href="/" className="dashboardBrand">
            <img
              src="/components/logoR.png"
              alt="Recepta"
            />
          </a>

          <nav className="dashboardNav">
            <a
              href="/dashboard"
              className="dashboardNavItem dashboardNavItemActive"
            >
              Overview
            </a>

            <a
              href="/dashboard/billing"
              className="dashboardNavItem"
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
                SETUP PENDING
              </p>

              <h1>
                {client?.company_name ||
                  'Your Recepta dashboard'}
              </h1>

              <p>
                Your account has been created. Recepta
                is assigning your plan, AI model and
                monthly minutes.
              </p>
            </div>
          </div>

          <div className="dashboardEmptyState">
            <h2>
              Your workspace is being prepared
            </h2>

            <p>
              You do not need to choose or purchase a
              subscription yourself. Recepta will finish
              the account configuration for you.
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img
            src="/components/logoR.png"
            alt="Recepta"
          />
        </a>

        <nav className="dashboardNav">
          <a
            href="/dashboard"
            className="dashboardNavItem dashboardNavItemActive"
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
            <a
              href="/dashboard/appointments"
              className="dashboardNavItem"
            >
              Appointments
            </a>
          )}

          {isPro && (
            <a
              href="/dashboard/employees"
              className="dashboardNavItem"
            >
              Employees
            </a>
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
              {isPro
                ? 'RECEPTA PRO'
                : isStandard
                  ? 'RECEPTA STANDARD'
                  : 'RECEPTA'}
            </p>

            <h1>
              {client?.company_name ||
                'Your AI receptionist'}
            </h1>

            <p>
              Your workspace is ready and will populate
              automatically as your AI receptionist handles calls.
            </p>
          </div>

          <div
            className="agentLiveBadge"
            style={{
              color: status.color,
              borderColor: status.border,
              background: status.background,
            }}
          >
            <span
              style={{
                background: status.color,
                boxShadow: `0 0 12px ${status.shadow}`,
              }}
            />

            {status.label}
          </div>
        </div>

        {isSubscriptionCancelled ? (
          <div className="dashboardEmptyState">
            <h2>
              Your subscription is cancelled
            </h2>

            <p>
              Your previous plan information is preserved.
              Recepta controls plan, AI model and monthly
              minute changes for your account.
            </p>

            <a
              href="/dashboard/billing"
              className="btn btnPrimary"
            >
              View Billing
            </a>
          </div>
        ) : (
        <>

        <div className="dashboardStats">
          <div className="dashboardStatCard">
            <span>Calls Answered</span>
            <strong>{stats.callsAnswered}</strong>
          </div>

          {isPro && (
            <a
              href="/dashboard/appointments"
              className="dashboardStatCard dashboardStatCardLink"
            >
              <span>Appointments Today</span>

              <strong>
                {stats.appointmentsToday}
              </strong>

              <small>
                {stats.appointmentsToday === 1
                  ? '1 appointment scheduled today'
                  : `${stats.appointmentsToday} appointments scheduled today`}
              </small>
            </a>
          )}

          <div className="dashboardStatCard">
            <span>Minutes Used</span>

            <strong>
              {stats.minutesTalked} /{' '}
              {stats.monthlyMinutes} min
            </strong>

            <div
              style={{
                width: '100%',
                height: '6px',
                marginTop: '12px',
                overflow: 'hidden',
                borderRadius: '999px',
                background:
                  'rgba(255,255,255,0.08)',
              }}
            >
              <div
                style={{
                  width: `${stats.usagePercentage}%`,
                  height: '100%',
                  borderRadius: '999px',
                  background: '#00e676',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>

            <small
              style={{
                display: 'block',
                marginTop: '8px',
              }}
            >
              {stats.minutesRemaining > 0
                ? `${stats.minutesRemaining} minutes remaining`
                : 'Monthly minutes used'}
            </small>
          </div>

          <div className="dashboardStatCard">
            <span>Avg. Call Duration</span>

            <strong>
              {stats.averageDuration}
            </strong>
          </div>
        </div>

        {isPro && (
          <div className="dashboardTodayCard">
            <div>
              <p className="dashboardEyebrow">
                TODAY
              </p>

              <h2>
                {stats.appointmentsToday === 0
                  ? 'No appointments today'
                  : `${stats.appointmentsToday} ${
                      stats.appointmentsToday === 1
                        ? 'appointment'
                        : 'appointments'
                    } today`}
              </h2>

              <p>
                {stats.appointmentsToday === 0
                  ? 'Your receptionist has no customer appointments scheduled for today.'
                  : 'View today’s booked customers and appointment times.'}
              </p>
            </div>

            <a
              href="/dashboard/appointments"
              className="btn btnOutline"
            >
              View Appointments
            </a>
          </div>
        )}

        {client?.status !== 'live' && (
          <div className="onboardingProgressCard">
            <div className="onboardingProgressHead">
              <div>
                <p className="dashboardEyebrow">
                  AI CONFIGURATION
                </p>

                <h2>
                  AI configuration pending
                </h2>

                <p>
                  Your Recepta dashboard is ready. Your plan,
                  AI model and monthly minutes have already
                  been assigned. The only remaining setup is
                  connecting and configuring your AI receptionist.
                </p>
              </div>

              <span className="onboardingProgressPercent">
                Pending
              </span>
            </div>
          </div>
        )}

        {client?.status === 'live' && (
          <div className="dashboardEmptyState">
            <h2>
              {calls.length === 0
                ? 'Your receptionist is live'
                : 'Your receptionist is working'}
            </h2>

            <p>
              {calls.length === 0
                ? 'Recepta is ready to handle customer calls. Your dashboard will populate automatically as calls come in.'
                : 'Your dashboard is now showing real activity from your Recepta receptionist.'}
            </p>
          </div>
        )}
        </>
        )}
      </section>
    </main>
  )
}
