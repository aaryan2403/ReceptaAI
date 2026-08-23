import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type AgentStatus = 'setup' | 'testing' | 'live' | 'paused'

type AgentRecord = {
  agent_name: string | null
  phone_number: string | null
  business_hours: string | null
  status: AgentStatus
}

type CallRecord = {
  id: string
  started_at: string
  duration_seconds: number
  appointment_booked: boolean
  outcome: string | null
}

export default function Agent() {
  const [agent, setAgent] = useState<AgentRecord | null>(null)
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [isPro, setIsPro] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadAgent = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: agentData, error: agentError },
        { data: callsData, error: callsError },
        { data: subscriptionData },
      ] = await Promise.all([
        supabase
          .from('agents')
          .select(
            'agent_name, phone_number, business_hours, status'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('calls')
          .select(
            'id, started_at, duration_seconds, appointment_booked, outcome'
          )
          .eq('client_id', user.id)
          .order('started_at', { ascending: false }),

        supabase
          .from('subscriptions')
          .select('plan_name')
          .eq('client_id', user.id)
          .maybeSingle(),
      ])

      if (!agentError && agentData) {
        setAgent(agentData)
      }

      if (!callsError && callsData) {
        setCalls(callsData)
      }

      setIsPro(
        subscriptionData?.plan_name === 'Recepta Pro'
      )

      setLoading(false)
    }

    loadAgent()
  }, [])

  const getStatusInfo = () => {
    switch (agent?.status) {
      case 'live':
        return {
          label: 'Agent Live',
          shortLabel: 'Live',
          color: '#00e676',
          background: 'rgba(0, 230, 118, 0.10)',
          border: 'rgba(0, 230, 118, 0.20)',
          shadow: 'rgba(0, 230, 118, 0.7)',
        }

      case 'testing':
        return {
          label: 'Agent Testing',
          shortLabel: 'Testing',
          color: '#58b7ff',
          background: 'rgba(88, 183, 255, 0.10)',
          border: 'rgba(88, 183, 255, 0.20)',
          shadow: 'rgba(88, 183, 255, 0.7)',
        }

      case 'paused':
        return {
          label: 'Agent Paused',
          shortLabel: 'Paused',
          color: '#a0a0a0',
          background: 'rgba(160, 160, 160, 0.10)',
          border: 'rgba(160, 160, 160, 0.20)',
          shadow: 'rgba(160, 160, 160, 0.5)',
        }

      default:
        return {
          label: 'Setup in progress',
          shortLabel: 'Setup',
          color: '#f5b942',
          background: 'rgba(245, 185, 66, 0.08)',
          border: 'rgba(245, 185, 66, 0.25)',
          shadow: 'rgba(245, 185, 66, 0.6)',
        }
    }
  }

  const status = getStatusInfo()

  const performance = useMemo(() => {
    const totalCalls = calls.length

    const totalSeconds = calls.reduce(
      (total, call) =>
        total + (call.duration_seconds || 0),
      0
    )

    const totalMinutes = Math.round(totalSeconds / 60)

    const averageSeconds =
      totalCalls > 0
        ? Math.round(totalSeconds / totalCalls)
        : 0

    const averageMinutes =
      Math.floor(averageSeconds / 60)

    const remainingSeconds =
      averageSeconds % 60

    const appointments = calls.filter(
      (call) => call.appointment_booked
    ).length

    return {
      totalCalls,
      totalMinutes,
      appointments,

      averageDuration:
        totalCalls > 0
          ? `${averageMinutes}m ${String(
              remainingSeconds
            ).padStart(2, '0')}s`
          : '—',
    }
  }, [calls])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Loading agent...
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
            className="dashboardNavItem dashboardNavItemActive"
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

        {/* HEADER */}

        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              YOUR AI RECEPTIONIST
            </p>

            <h1>
              {agent?.agent_name || 'AI Receptionist'}
            </h1>

            <p>
              See how your receptionist is configured
              and performing.
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
                boxShadow:
                  `0 0 12px ${status.shadow}`,
              }}
            />

            {status.label}
          </div>
        </div>

        {/* RECEPTIONIST */}

        <section className="agentControlHero">
          <div className="agentControlIdentity">
            <div
              className="agentControlAvatar"
              style={{
                color: status.color,
                borderColor: status.border,
                background: status.background,
              }}
            >
              AI
            </div>

            <div>
              <span className="agentSectionLabel">
                YOUR RECEPTIONIST
              </span>

              <h2>
                {agent?.agent_name ||
                  'Not assigned yet'}
              </h2>

              <p>
                {agent?.phone_number ||
                  'Your Recepta phone number has not been assigned yet.'}
              </p>
            </div>
          </div>

          <div className="agentControlFacts">
            <div>
              <span>STATUS</span>

              <strong
                style={{
                  color: status.color,
                }}
              >
                {status.shortLabel}
              </strong>
            </div>

            <div>
              <span>PHONE NUMBER</span>

              <strong>
                {agent?.phone_number || 'Pending'}
              </strong>
            </div>

            <div>
              <span>BUSINESS HOURS</span>

              <strong>
                {agent?.business_hours ||
                  'Not configured'}
              </strong>
            </div>

            <div>
              <span>LAST CALL</span>

              <strong>
                {calls.length > 0
                  ? new Date(
                      calls[0].started_at
                    ).toLocaleString()
                  : 'No calls yet'}
              </strong>
            </div>
          </div>
        </section>

        {/* CURRENT STATUS */}

        <section className="agentPanel agentLivePanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">
                CURRENT STATUS
              </span>

              <h2>
                Your receptionist
              </h2>
            </div>

            <span
              className="agentIdleStatus"
              style={{
                color: status.color,
              }}
            >
              <span
                style={{
                  background: status.color,
                }}
              />

              {status.shortLabel}
            </span>
          </div>

          <div className="agentLiveState">
            <div className="agentLiveOrb">
              <span />
            </div>

            <div>
              <strong>
                {agent?.status === 'live'
                  ? 'Ready for customer calls'
                  : agent?.status === 'paused'
                    ? 'Receptionist paused'
                    : agent?.status === 'testing'
                      ? 'Receptionist being tested'
                      : 'Receptionist being prepared'}
              </strong>

              <p>
                {agent?.status === 'live'
                  ? 'Your AI receptionist is online and ready to answer incoming customer calls.'
                  : agent?.status === 'paused'
                    ? 'Your receptionist is currently paused and is not handling customer calls.'
                    : agent?.status === 'testing'
                      ? 'The Recepta team is currently testing your receptionist before activation.'
                      : 'The Recepta team is preparing your receptionist before it goes live.'}
              </p>
            </div>
          </div>
        </section>

        {/* CONFIGURATION */}

        <section className="agentPanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">
                CONFIGURATION
              </span>

              <h2>
                Receptionist setup
              </h2>
            </div>
          </div>

          <div className="agentConfigurationGrid">
            <div>
              <span>Agent name</span>

              <strong>
                {agent?.agent_name || 'Pending'}
              </strong>
            </div>

            <div>
              <span>Phone number</span>

              <strong>
                {agent?.phone_number || 'Pending'}
              </strong>
            </div>

            <div>
              <span>Operating hours</span>

              <strong>
                {agent?.business_hours || 'Pending'}
              </strong>
            </div>

            <div>
              <span>Current status</span>

              <strong
                style={{
                  color: status.color,
                }}
              >
                {status.shortLabel}
              </strong>
            </div>
          </div>

          <div className="agentConfigurationNotice">
            <strong>
              Want something changed?
            </strong>

            <p>
              Need to change your greeting,
              business hours, call instructions,
              transfer preferences or receptionist
              behaviour? Send a request to the
              Recepta team.
            </p>

            <a
              href="mailto:support@recepta.ca?subject=Recepta%20Agent%20Change%20Request"
              className="btn btnOutline"
            >
              Request a change
            </a>
          </div>
        </section>

        {/* PERFORMANCE */}

        <section className="agentPanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">
                PERFORMANCE
              </span>

              <h2>
                Receptionist performance
              </h2>
            </div>
          </div>

          <div className="agentPerformanceGrid">
            <div>
              <span>Calls Handled</span>

              <strong>
                {performance.totalCalls}
              </strong>
            </div>

            <div>
              <span>Minutes Talked</span>

              <strong>
                {performance.totalMinutes}
              </strong>
            </div>

            {isPro && (
              <div>
                <span>Appointments Booked</span>

                <strong>
                  {performance.appointments}
                </strong>
              </div>
            )}

            <div>
              <span>Avg. Call Duration</span>

              <strong>
                {performance.averageDuration}
              </strong>
            </div>
          </div>
        </section>

        {/* RECENT ACTIVITY */}

        <section className="agentPanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">
                RECENT ACTIVITY
              </span>

              <h2>
                Recent calls
              </h2>
            </div>

            {calls.length > 0 && (
              <a
                href="/dashboard/calls"
                className="btn btnOutline"
              >
                View all calls
              </a>
            )}
          </div>

          {calls.length === 0 ? (
            <div className="agentActivityEmpty">
              <strong>
                No calls yet
              </strong>

              <p>
                Your recent receptionist activity
                will appear here once customer
                calls start coming in.
              </p>
            </div>
          ) : (
            <div className="agentActivityList">
              {calls.slice(0, 5).map((call) => (
                <div
                  className="agentActivityRow"
                  key={call.id}
                >
                  <div className="agentActivityIcon">
                    ↗
                  </div>

                  <div className="agentActivityText">
                    <strong>
                      {isPro &&
                      call.appointment_booked
                        ? 'Call handled · Appointment booked'
                        : 'Customer call handled'}
                    </strong>

                    <span>
                      {call.outcome ||
                        'Call completed'}
                    </span>
                  </div>

                  <time>
                    {new Date(
                      call.started_at
                    ).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
