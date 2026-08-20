import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type Client = {
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
}

type Call = {
  duration_seconds: number
  appointment_booked: boolean
}

type Appointment = {
  id: string
  status: 'booked' | 'cancelled' | 'completed'
}

export default function Dashboard() {
  const [client, setClient] = useState<Client | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
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
        { data: callsData },
        { data: appointmentsData },
      ] = await Promise.all([
        supabase
          .from('clients')
          .select('company_name, contact_email, status')
          .eq('id', user.id)
          .single(),

        supabase
          .from('calls')
          .select('duration_seconds, appointment_booked')
          .eq('client_id', user.id),

        supabase
          .from('appointments')
          .select('id, status')
          .eq('client_id', user.id),
      ])

      if (clientData) setClient(clientData)
      if (callsData) setCalls(callsData)
      if (appointmentsData) setAppointments(appointmentsData)

      setLoading(false)
    }

    loadDashboard()
  }, [])

  const stats = useMemo(() => {
    const callsAnswered = calls.length

    const totalSeconds = calls.reduce(
      (total, call) => total + (call.duration_seconds || 0),
      0
    )

    const minutesTalked = Math.round(totalSeconds / 60)

    const averageSeconds =
      callsAnswered > 0 ? Math.round(totalSeconds / callsAnswered) : 0

    const averageMinutes = Math.floor(averageSeconds / 60)
    const averageRemainingSeconds = averageSeconds % 60

    const appointmentsBooked = appointments.filter(
      (appointment) => appointment.status === 'booked'
    ).length

    return {
      callsAnswered,
      appointmentsBooked,
      minutesTalked,
      averageDuration:
        callsAnswered > 0
          ? `${averageMinutes}m ${String(averageRemainingSeconds).padStart(2, '0')}s`
          : '—',
    }
  }, [calls, appointments])

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
          label: 'Setup in progress',
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

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem dashboardNavItemActive">
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

          <a href="/dashboard/billing" className="dashboardNavItem">
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
            <p className="dashboardEyebrow">OVERVIEW</p>

            <h1>{client?.company_name || 'Your AI receptionist'}</h1>

            <p>Track how Recepta is handling your customer calls.</p>
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

        <div className="dashboardStats">
          <div className="dashboardStatCard">
            <span>Calls Answered</span>
            <strong>{stats.callsAnswered}</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Appointments Booked</span>
            <strong>{stats.appointmentsBooked}</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Minutes Talked</span>
            <strong>{stats.minutesTalked} min</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Avg. Call Duration</span>
            <strong>{stats.averageDuration}</strong>
          </div>
        </div>

        {client?.status !== 'live' && (
          <div className="onboardingProgressCard">
            <div className="onboardingProgressHead">
              <div>
                <p className="dashboardEyebrow">ONBOARDING</p>
                <h2>Your Recepta is being prepared</h2>
                <p>
                  Our team is configuring and testing your receptionist before it goes live.
                </p>
              </div>

              <span className="onboardingProgressPercent">
                {onboardingStep === 2 ? '50%' : '75%'}
              </span>
            </div>

            <div className="onboardingProgressBar">
              <div
                className="onboardingProgressFill"
                style={{
                  width: onboardingStep === 2 ? '50%' : '75%',
                }}
              />
            </div>

            <div className="onboardingSteps">
              <div className="onboardingStep onboardingStep--done">
                <span>✓</span>
                <div>
                  <strong>Account created</strong>
                  <small>Your Recepta workspace is ready.</small>
                </div>
              </div>

              <div className="onboardingStep onboardingStep--done">
                <span>✓</span>
                <div>
                  <strong>Business configuration</strong>
                  <small>Your call rules and business details are being prepared.</small>
                </div>
              </div>

              <div
                className={`onboardingStep ${
                  onboardingStep >= 3 ? 'onboardingStep--done' : 'onboardingStep--active'
                }`}
              >
                <span>{onboardingStep >= 3 ? '✓' : '3'}</span>
                <div>
                  <strong>Agent testing</strong>
                  <small>We test calls, bookings, transfers, and edge cases.</small>
                </div>
              </div>

              <div className="onboardingStep">
                <span>4</span>
                <div>
                  <strong>Go live</strong>
                  <small>Your receptionist starts handling real customer calls.</small>
                </div>
              </div>
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
      </section>
    </main>
  )
}
