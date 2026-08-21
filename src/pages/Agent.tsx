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
      ] = await Promise.all([
        supabase
          .from('agents')
          .select('agent_name, phone_number, business_hours, status')
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('calls')
          .select(
            'id, started_at, duration_seconds, appointment_booked, outcome'
          )
          .eq('client_id', user.id)
          .order('started_at', { ascending: false }),
      ])

      if (!agentError && agentData) {
        setAgent(agentData)
      }

      if (!callsError && callsData) {
        setCalls(callsData)
      }

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
      (total, call) => total + (call.duration_seconds || 0),
      0
    )

    const totalMinutes = Math.round(totalSeconds / 60)

    const averageSeconds =
      totalCalls > 0 ? Math.round(totalSeconds / totalCalls) : 0

    const averageMinutes = Math.floor(averageSeconds / 60)
    const remainingSeconds = averageSeconds % 60

    const appointments = calls.filter(
      (call) => call.appointment_booked
    ).length

    return {
      totalCalls,
      totalMinutes,
      appointments,
      averageDuration:
        totalCalls > 0
          ? `${averageMinutes}m ${String(remainingSeconds).padStart(2, '0')}s`
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

          <a
            href="/dashboard/agent"
            className="dashboardNavItem dashboardNavItemActive"
          >
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
            <p className="dashboardEyebrow">YOUR AI RECEPTIONIST</p>

            <h1>{agent?.agent_name || 'AI Receptionist'}</h1>

            <p>
              Monitor your receptionist, configuration and performance.
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

        {/* AGENT OVERVIEW */}

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
              <span className="agentSectionLabel">ASSIGNED AGENT</span>

              <h2>{agent?.agent_name || 'Not assigned yet'}</h2>

              <p>
                {agent?.phone_number ||
                  'A dedicated phone number has not been assigned yet.'}
              </p>
            </div>
          </div>

          <div className="agentControlFacts">
            <div>
              <span>STATUS</span>
              <strong style={{ color: status.color }}>
                {status.shortLabel}
              </strong>
            </div>

            <div>
              <span>PHONE</span>
              <strong>{agent?.phone_number || 'Pending'}</strong>
            </div>

            <div>
              <span>BUSINESS HOURS</span>
              <strong>{agent?.business_hours || 'Not configured'}</strong>
            </div>

            <div>
              <span>LAST ACTIVE</span>
              <strong>
                {calls.length > 0
                  ? new Date(calls[0].started_at).toLocaleString()
                  : '—'}
              </strong>
            </div>
          </div>
        </section>

        {/* LIVE STATUS */}

        <section className="agentPanel agentLivePanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">LIVE STATUS</span>
              <h2>Receptionist activity</h2>
            </div>

            <span className="agentIdleStatus">
              <span />
              Idle
            </span>
          </div>

          <div className="agentLiveState">
            <div className="agentLiveOrb">
              <span />
            </div>

            <div>
              <strong>Ready for calls</strong>

              <p>
                {agent?.status === 'live'
                  ? 'Your receptionist is online and ready to answer customers.'
                  : 'Live call monitoring will become available once your receptionist is activated.'}
              </p>
            </div>
          </div>

          <div className="agentLiveNotice">
            Live caller information and elapsed call time will appear here once
            Retell live-call events are connected.
          </div>
        </section>

        {/* HEALTH + CONFIGURATION */}

        <div className="agentTwoColumn">
          <section className="agentPanel">
            <div className="agentPanelHeading">
              <div>
                <span className="agentSectionLabel">SYSTEM HEALTH</span>
                <h2>Agent health</h2>
              </div>
            </div>

            <div className="agentHealthList">
              <div className="agentHealthRow">
                <div>
                  <strong>AI configuration</strong>
                  <span>Core receptionist configuration</span>
                </div>

                <span
                  className={
                    agent
                      ? 'agentHealthBadge agentHealthBadge--good'
                      : 'agentHealthBadge agentHealthBadge--pending'
                  }
                >
                  {agent ? 'Ready' : 'Pending'}
                </span>
              </div>

              <div className="agentHealthRow">
                <div>
                  <strong>Phone line</strong>
                  <span>Dedicated customer-facing number</span>
                </div>

                <span
                  className={
                    agent?.phone_number
                      ? 'agentHealthBadge agentHealthBadge--good'
                      : 'agentHealthBadge agentHealthBadge--pending'
                  }
                >
                  {agent?.phone_number ? 'Connected' : 'Pending'}
                </span>
              </div>

              <div className="agentHealthRow">
                <div>
                  <strong>Agent testing</strong>
                  <span>Call-flow and response testing</span>
                </div>

                <span
                  className={
                    agent?.status === 'testing' ||
                    agent?.status === 'live'
                      ? 'agentHealthBadge agentHealthBadge--good'
                      : 'agentHealthBadge agentHealthBadge--pending'
                  }
                >
                  {agent?.status === 'live'
                    ? 'Passed'
                    : agent?.status === 'testing'
                      ? 'Testing'
                      : 'Pending'}
                </span>
              </div>

              <div className="agentHealthRow">
                <div>
                  <strong>Live activation</strong>
                  <span>Ready to handle real customers</span>
                </div>

                <span
                  className={
                    agent?.status === 'live'
                      ? 'agentHealthBadge agentHealthBadge--good'
                      : 'agentHealthBadge agentHealthBadge--pending'
                  }
                >
                  {agent?.status === 'live' ? 'Active' : 'Pending'}
                </span>
              </div>
            </div>
          </section>

          <section className="agentPanel">
            <div className="agentPanelHeading">
              <div>
                <span className="agentSectionLabel">CONFIGURATION</span>
                <h2>Configuration summary</h2>
              </div>
            </div>

            <div className="agentConfigurationGrid">
              <div>
                <span>Agent name</span>
                <strong>{agent?.agent_name || 'Pending'}</strong>
              </div>

              <div>
                <span>Phone number</span>
                <strong>{agent?.phone_number || 'Pending'}</strong>
              </div>

              <div>
                <span>Operating hours</span>
                <strong>{agent?.business_hours || 'Pending'}</strong>
              </div>

              <div>
                <span>Agent status</span>
                <strong style={{ color: status.color }}>
                  {status.shortLabel}
                </strong>
              </div>
            </div>

            <div className="agentConfigurationNotice">
              <strong>Need something changed?</strong>

              <p>
                Business rules, voice, appointment handling and transfer
                preferences will be managed by the Recepta team.
              </p>

              <button className="btn btnOutline" type="button">
                Request changes
              </button>
            </div>
          </section>
        </div>

        {/* PERFORMANCE */}

        <section className="agentPanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">PERFORMANCE</span>
              <h2>Agent performance</h2>
            </div>
          </div>

          <div className="agentPerformanceGrid">
            <div>
              <span>Calls Handled</span>
              <strong>{performance.totalCalls}</strong>
            </div>

            <div>
              <span>Minutes Talked</span>
              <strong>{performance.totalMinutes}</strong>
            </div>

            <div>
              <span>Appointments</span>
              <strong>{performance.appointments}</strong>
            </div>

            <div>
              <span>Avg. Duration</span>
              <strong>{performance.averageDuration}</strong>
            </div>
          </div>
        </section>

        {/* RECENT ACTIVITY */}

        <section className="agentPanel">
          <div className="agentPanelHeading">
            <div>
              <span className="agentSectionLabel">RECENT ACTIVITY</span>
              <h2>Agent activity</h2>
            </div>
          </div>

          {calls.length === 0 ? (
            <div className="agentActivityEmpty">
              <strong>No activity yet</strong>

              <p>
                Calls, bookings and other receptionist activity will appear
                here once your agent starts handling customers.
              </p>
            </div>
          ) : (
            <div className="agentActivityList">
              {calls.slice(0, 5).map((call) => (
                <div className="agentActivityRow" key={call.id}>
                  <div className="agentActivityIcon">
                    ↗
                  </div>

                  <div className="agentActivityText">
                    <strong>
                      {call.appointment_booked
                        ? 'Call handled · Appointment booked'
                        : 'Customer call handled'}
                    </strong>

                    <span>
                      {call.outcome || 'Call completed'}
                    </span>
                  </div>

                  <time>
                    {new Date(call.started_at).toLocaleString()}
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
