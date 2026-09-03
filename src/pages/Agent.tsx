import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  fetchClientCalls,
  saveSchedulePreference,
} from '../lib/clientCalls'

type AgentStatus = 'setup' | 'testing' | 'live' | 'paused'

type AgentRecord = {
  agent_name: string | null
  phone_number: string | null
  business_hours: string | null
  status: AgentStatus
}

type OperatingDay = {
  day: string
  open: boolean
  start: string
  end: string
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
  const [loading, setLoading] = useState(true)

  const [operatingHours, setOperatingHours] = useState<OperatingDay[]>([
    { day: 'Monday', open: true, start: '09:00', end: '17:00' },
    { day: 'Tuesday', open: true, start: '09:00', end: '17:00' },
    { day: 'Wednesday', open: true, start: '09:00', end: '17:00' },
    { day: 'Thursday', open: true, start: '09:00', end: '17:00' },
    { day: 'Friday', open: true, start: '09:00', end: '17:00' },
    { day: 'Saturday', open: false, start: '09:00', end: '17:00' },
    { day: 'Sunday', open: false, start: '09:00', end: '17:00' },
  ])
  const [savingHours, setSavingHours] = useState(false)
  const [hoursMessage, setHoursMessage] = useState('')
  const [scheduleMode, setScheduleMode] =
    useState<'24/7' | 'custom' | null>(null)
  const [businessTimeZone, setBusinessTimeZone] = useState(
    () =>
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'America/Toronto'
  )

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
          .select('plan_name, status')
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

        const normalizedHours = agentData.business_hours
          ?.trim()
          .toLowerCase()

        setScheduleMode(
          !normalizedHours || normalizedHours === 'not configured'
            ? null
            : normalizedHours === 'not required' ||
                normalizedHours === '24/7'
              ? '24/7'
              : 'custom'
        )

        if (agentData.business_hours) {
          try {
            const parsed = JSON.parse(agentData.business_hours)
            const parsedHours = Array.isArray(parsed)
              ? parsed
              : parsed?.hours

            if (
              parsed?.mode === '24/7' ||
              parsed?.mode === 'custom'
            ) {
              setScheduleMode(parsed.mode)
            }

            if (
              typeof parsed?.timeZone === 'string' &&
              parsed.timeZone.trim()
            ) {
              setBusinessTimeZone(parsed.timeZone)
            }

            if (Array.isArray(parsedHours) && parsedHours.length === 7) {
              setOperatingHours(parsedHours)
            }
          } catch {
            // Existing plain-text business hours are left as-is
            // until the customer saves the new structured schedule.
          }
        }
      }

      try {
        const callsResult = await fetchClientCalls()
        setCalls(callsResult.calls)
      } catch (error) {
        console.error('Agent call sync failed:', error)
      }

      setIsPro(
        subscriptionData?.status === 'active' &&
        subscriptionData?.plan_name === 'Recepta Pro'
      )

      setLoading(false)
    }

    loadAgent()
  }, [])

  const updateOperatingDay = (
    index: number,
    updates: Partial<OperatingDay>
  ) => {
    setOperatingHours((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, ...updates }
          : item
      )
    )
  }

  const saveOperatingHours = async () => {
    setSavingHours(true)
    setHoursMessage('')

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setHoursMessage('Please sign in again.')
        return
      }

      const result = await saveSchedulePreference('custom', {
        operatingHours,
        timeZone: businessTimeZone,
      })
      const serialized =
        result.businessHours ??
        JSON.stringify({
          mode: 'custom',
          timeZone: businessTimeZone,
          hours: operatingHours,
        })

      setAgent((current) =>
        current
          ? {
              ...current,
              business_hours: serialized,
            }
          : current
      )

      setScheduleMode('custom')

      setHoursMessage('Custom hours saved and synchronized with Retell.')
    } catch (error) {
      setHoursMessage(
        error instanceof Error
          ? error.message
          : 'Could not save operating hours.'
      )
    } finally {
      setSavingHours(false)
    }
  }

  const operatingHoursSummary = useMemo(() => {
    const openDays = operatingHours.filter((item) => item.open)

    if (openDays.length === 0) {
      return 'Closed all week'
    }

    const first = openDays[0]
    const sameHours = openDays.every(
      (item) =>
        item.start === first.start &&
        item.end === first.end
    )

    if (sameHours) {
      return `${openDays.length} days · ${first.start}–${first.end}`
    }

    return `${openDays.length} days configured`
  }, [operatingHours])

  const scheduleSummary =
    scheduleMode === '24/7'
      ? '24/7'
      : scheduleMode === null
        ? 'Choose in Calls'
        : operatingHoursSummary

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

          {isPro && (
            <a
              href="/dashboard/appointments"
              className="dashboardNavItem"
            >
              Appointments
            </a>
          )}

          <a
            href="/dashboard/employees"
            className="dashboardNavItem"
          >
            Employees
          </a>

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
                {agent?.status === 'live'
                  ? 'Ready for customer calls'
                  : agent?.status === 'paused'
                    ? 'Receptionist paused'
                    : agent?.status === 'testing'
                      ? 'Receptionist being tested'
                      : 'AI configuration pending'}
              </strong>

              <p>
                {agent?.status === 'live'
                  ? 'Your AI receptionist is online and ready to answer incoming customer calls.'
                  : agent?.status === 'paused'
                    ? 'Your receptionist is currently paused and is not handling customer calls.'
                    : agent?.status === 'testing'
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
              You can change operating hours below.
              For greeting, call instructions, transfer
              preferences or receptionist behaviour,
              send a request to the Recepta team.
            </p>

            <a
              href="mailto:support@recepta.ca?subject=Recepta%20Agent%20Change%20Request"
              className="btn btnOutline"
            >
              Request a change
            </a>
          </div>
        </section>

      {/* OPERATING HOURS */}

        {scheduleMode === 'custom' ? (
        <section className="agentPanel">
          <div
            className="agentPanelHeading"
            style={{
              alignItems: 'flex-start',
              gap: '20px',
            }}
          >
            <div>
              <span className="agentSectionLabel">
                OPERATING HOURS
              </span>

              <h2>
                When should your receptionist answer?
              </h2>

              <p>
                Set your normal weekly call-answering hours.
                Calls outside these hours will not connect to the
                receptionist.
              </p>

              <label
                style={{
                  display: 'grid',
                  gap: '8px',
                  marginTop: '18px',
                  maxWidth: '320px',
                }}
              >
                <span>Business timezone</span>

                <select
                  value={businessTimeZone}
                  onChange={(event) =>
                    setBusinessTimeZone(event.target.value)
                  }
                >
                  <option value="America/St_Johns">
                    Newfoundland
                  </option>
                  <option value="America/Halifax">
                    Atlantic
                  </option>
                  <option value="America/Toronto">
                    Eastern
                  </option>
                  <option value="America/Winnipeg">
                    Central
                  </option>
                  <option value="America/Edmonton">
                    Mountain
                  </option>
                  <option value="America/Vancouver">
                    Pacific
                  </option>
                  {![
                    'America/St_Johns',
                    'America/Halifax',
                    'America/Toronto',
                    'America/Winnipeg',
                    'America/Edmonton',
                    'America/Vancouver',
                  ].includes(businessTimeZone) && (
                    <option value={businessTimeZone}>
                      {businessTimeZone}
                    </option>
                  )}
                </select>
              </label>
            </div>

            <div
              className="agentHoursSummary"
              style={{
                whiteSpace: 'nowrap',
              }}
            >
              {operatingHoursSummary}
            </div>
          </div>

          <div
            className="agentHoursList"
            style={{
              display: 'grid',
              gap: '12px',
              marginTop: '24px',
            }}
          >
            {operatingHours.map((item, index) => (
              <div
                key={item.day}
                className={
                  item.open
                    ? 'agentHoursDay agentHoursDay--open'
                    : 'agentHoursDay agentHoursDay--closed'
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '18px',
                  padding: '18px 20px',
                }}
              >
                <div
                  className="agentHoursDayName"
                  style={{
                    minWidth: '150px',
                  }}
                >
                  <strong>{item.day}</strong>

                  <span>
                    {item.open
                      ? `${item.start} – ${item.end}`
                      : 'Closed'}
                  </span>
                </div>

                <label
                  className="agentHoursToggle"
                  style={{
                    marginLeft: 'auto',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={item.open}
                    onChange={(event) =>
                      updateOperatingDay(index, {
                        open: event.target.checked,
                      })
                    }
                  />

                  <span className="agentHoursToggleTrack">
                    <span className="agentHoursToggleThumb" />
                  </span>

                  <span className="agentHoursToggleLabel">
                    {item.open ? 'Open' : 'Closed'}
                  </span>
                </label>

                {item.open ? (
                  <div
                    className="agentHoursTimeRow"
                    style={{
                      display: 'flex',
                      alignItems: 'end',
                      flexWrap: 'wrap',
                      gap: '12px',
                      width: '100%',
                      paddingTop: '4px',
                    }}
                  >
                    <label
                      style={{
                        flex: '1 1 180px',
                      }}
                    >
                      <span>Opens</span>

                      <input
                        type="time"
                        value={item.start}
                        onChange={(event) =>
                          updateOperatingDay(index, {
                            start: event.target.value,
                          })
                        }
                      />
                    </label>

                    <div
                      className="agentHoursTimeDivider"
                      style={{
                        paddingBottom: '12px',
                      }}
                    >
                      to
                    </div>

                    <label
                      style={{
                        flex: '1 1 180px',
                      }}
                    >
                      <span>Closes</span>

                      <input
                        type="time"
                        value={item.end}
                        onChange={(event) =>
                          updateOperatingDay(index, {
                            end: event.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                ) : (
                  <div
                    style={{
                      width: '100%',
                      opacity: 0.7,
                      fontSize: '0.95rem',
                    }}
                  >
                    Your receptionist will not answer
                    calls on {item.day}.
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className="agentHoursActions"
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '14px',
              marginTop: '24px',
            }}
          >
            <button
              type="button"
              className="btn btnPrimary"
              onClick={saveOperatingHours}
              disabled={savingHours}
            >
              {savingHours
                ? 'Saving...'
                : 'Save Operating Hours'}
            </button>

            {hoursMessage && (
              <span
                className="agentHoursMessage"
                role="status"
              >
                {hoursMessage}
              </span>
            )}
          </div>
        </section>
        ) : (
          <section className="agentPanel">
            <div className="agentPanelHeading">
              <div>
                <span className="agentSectionLabel">
                  OPERATING HOURS
                </span>

                <h2>
                  {scheduleMode === '24/7'
                    ? 'Available 24/7'
                    : 'Choose your availability'}
                </h2>

                <p>
                  {scheduleMode === '24/7'
                    ? 'Your receptionist is configured to answer at any time, every day.'
                    : 'Choose either 24/7 or Custom from the Calls page first.'}
                </p>
              </div>

              <a
                href="/dashboard/calls"
                className="btn btnOutline"
              >
                Open Calls
              </a>
            </div>
          </section>
        )}

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
