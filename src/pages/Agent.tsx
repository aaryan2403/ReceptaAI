import BillingAccessNotice from '../components/BillingAccessNotice'
import { calculateMinuteBalance } from '../lib/minuteBalance'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchClientCalls } from '../lib/clientCalls'
import { storeHoursSummary } from '../lib/storeHours'

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
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([])
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [isPro, setIsPro] = useState(false)
  const [hasPaidService,setHasPaidService]=useState(false)
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
        { data: subscriptionData },
        { data: phoneNumberData },
      ] = await Promise.all([
        supabase
          .from('agents')
          .select(
            'agent_name, phone_number, business_hours, status'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('subscriptions')
          .select('plan_name, status, current_period_start, current_period_end')
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('agent_phone_numbers')
          .select('phone_number')
          .eq('client_id', user.id)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true }),
      ])

      if (!agentError && agentData) {
        setAgent(agentData)

        const assignedPhoneNumbers = (phoneNumberData ?? []).map(
          (row) => row.phone_number
        )

        setPhoneNumbers(
          assignedPhoneNumbers.length > 0
            ? assignedPhoneNumbers
            : agentData.phone_number
              ? [agentData.phone_number]
              : []
        )

      }

      try {
        const callsResult = await fetchClientCalls()
        setCalls(callsResult.calls)
      } catch (error) {
        console.error('Agent call sync failed:', error)
      }

      setIsPro(subscriptionData?.plan_name === 'Recepta Pro')
      setHasPaidService(calculateMinuteBalance({ ...subscriptionData,monthly_minutes:0,status:subscriptionData?.status ?? null },0).paid)

      setLoading(false)
    }

    loadAgent()
  }, [])

  const scheduleSummary = storeHoursSummary(agent?.business_hours)

  const effectiveAgentStatus=hasPaidService ? agent?.status : 'paused'
  const getStatusInfo = () => {
    switch (effectiveAgentStatus) {
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
          label: 'AI Configuration Pending',
          shortLabel: 'Config Pending',
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

          <a
            href="/dashboard/agent"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Agent
          </a>

          <a href="/dashboard/requests" className="dashboardNavItem">
            Customer Requests
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
        <BillingAccessNotice />


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
                {phoneNumbers.length > 0
                  ? phoneNumbers.join(' · ')
                  : 'Your Recepta phone number has not been assigned yet.'}
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
              <span>
                {phoneNumbers.length === 1
                  ? 'PHONE NUMBER'
                  : 'PHONE NUMBERS'}
              </span>

              <strong>
                {phoneNumbers.length > 0
                  ? phoneNumbers.join(', ')
                  : 'Pending'}
              </strong>
            </div>

            <div>
              <span>BUSINESS HOURS</span>

              <strong>
                {scheduleSummary}
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
                {effectiveAgentStatus === 'live'
                  ? 'Ready for customer calls'
                  : effectiveAgentStatus === 'paused'
                    ? 'Receptionist paused'
                    : effectiveAgentStatus === 'testing'
                      ? 'Receptionist being tested'
                      : 'AI configuration pending'}
              </strong>

              <p>
                {effectiveAgentStatus === 'live'
                  ? 'Your AI receptionist is online and ready to answer incoming customer calls.'
                  : effectiveAgentStatus === 'paused'
                    ? 'Your receptionist is currently paused and is not handling customer calls.'
                    : effectiveAgentStatus === 'testing'
                      ? 'The Recepta team is currently testing your receptionist before activation.'
                      : 'Your dashboard is ready. The remaining step is connecting and configuring your AI receptionist.'}
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
              <span>
                {phoneNumbers.length === 1
                  ? 'Phone number'
                  : 'Phone numbers'}
              </span>

              <strong>
                {phoneNumbers.length > 0
                  ? phoneNumbers.join(', ')
                  : 'Pending'}
              </strong>
            </div>

            <div>
              <span>Operating hours</span>

              <strong>
                {scheduleSummary}
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
              Your store hours and AI answering settings are managed by Recepta.
              Send your opening hours or any requested changes to the Recepta team.
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
                <span>Confirmed Appointments</span>

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
