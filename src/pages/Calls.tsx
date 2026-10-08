import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchClientCalls } from '../lib/clientCalls'
import type { ClientCallRecord } from '../lib/clientCalls'

type CallRecord = ClientCallRecord

type Subscription = {
  plan_name: string | null
}

type AppointmentRecord = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  company_name: string | null
  service: string | null
  notes: string | null
  appointment_time: string
  retell_call_id: string | null
}

type CapturedDetail = { label: string; value: string }

const capturedDetails = (notes: string | null): CapturedDetail[] => {
  if (!notes) return []

  try {
    const parsed = JSON.parse(notes) as { details?: unknown }
    if (!Array.isArray(parsed.details)) return []

    return parsed.details.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      return typeof row.label === 'string' && typeof row.value === 'string'
        ? [{ label: row.label, value: row.value }]
        : []
    })
  } catch {
    return [{ label: 'Notes', value: notes }]
  }
}

export default function Calls() {
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([])
  const [selectedCall, setSelectedCall] =
    useState<CallRecord | null>(null)

  const [subscription, setSubscription] =
    useState<Subscription | null>(null)

  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [callWarning, setCallWarning] = useState('')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const loadCalls = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [subscriptionResult, appointmentResult] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('plan_name')
          .eq('client_id', user.id)
          .maybeSingle(),
        supabase
          .from('appointments')
          .select('id, customer_name, customer_phone, customer_email, company_name, service, notes, appointment_time, retell_call_id')
          .eq('client_id', user.id)
          .order('appointment_time', { ascending: false }),
      ])

      if (!appointmentResult.error) {
        setAppointments((appointmentResult.data ?? []) as AppointmentRecord[])
      }

      try {
        const result = await fetchClientCalls()
        const resolvedCalls = result.calls

        setCalls(resolvedCalls)
        setCallWarning(result.warning || '')

        setSelectedCall((current) =>
          current
            ? resolvedCalls.find(
                (call) =>
                  call.id === current.id
              ) ?? resolvedCalls[0] ?? null
            : resolvedCalls[0] ?? null
        )
      } catch (error) {
        setCallWarning(
          error instanceof Error
            ? error.message
            : 'Could not load Retell calls.'
        )
      }

      if (subscriptionResult.data) {
        setSubscription(subscriptionResult.data)
      }

      setLoading(false)
    }

    loadCalls()

    const refreshInterval =
      window.setInterval(
        loadCalls,
        5000
      )

    const clockInterval = window.setInterval(
      () => setNow(Date.now()),
      1000
    )

    return () => {
      window.clearInterval(
        refreshInterval
      )
      window.clearInterval(clockInterval)
    }
  }, [])

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const selectedAppointment = selectedCall?.retell_call_id
    ? appointments.find((appointment) =>
        appointment.retell_call_id?.split(':')[0] === selectedCall.retell_call_id
      ) ?? null
    : null

  const activeCall = calls.find(
    (call) =>
      call.call_status === 'ongoing' ||
      call.call_status === 'registered'
  )

  const activeCallSeconds = activeCall
    ? Math.max(
        0,
        Math.floor(
          (now - new Date(activeCall.started_at).getTime()) /
            1000
        )
      )
    : 0

  const formatDuration = (seconds: number) => {
    const safeSeconds = seconds || 0

    const minutes = Math.floor(
      safeSeconds / 60
    )

    const remainingSeconds =
      safeSeconds % 60

    return `${minutes}m ${String(
      remainingSeconds
    ).padStart(2, '0')}s`
  }

  const filteredCalls = useMemo(() => {
    const query = search
      .toLowerCase()
      .trim()

    if (!query) {
      return calls
    }

    return calls.filter((call) => {
      return (
        call.caller_name
          ?.toLowerCase()
          .includes(query) ||
        call.caller_number
          ?.toLowerCase()
          .includes(query) ||
        call.outcome
          ?.toLowerCase()
          .includes(query)
      )
    })
  }, [calls, search])

  const analytics = useMemo(() => {
    const totalCalls = calls.length

    const totalSeconds = calls.reduce(
      (total, call) =>
        total +
        (call.duration_seconds || 0),
      0
    )

    const averageSeconds =
      totalCalls > 0
        ? Math.round(
            totalSeconds / totalCalls
          )
        : 0

    const appointments =
      calls.filter(
        (call) =>
          call.appointment_booked
      ).length

    const bookingRate =
      totalCalls > 0
        ? Math.round(
            (appointments /
              totalCalls) *
              100
          )
        : 0

    return {
      totalCalls,

      totalMinutes:
        Math.round(
          totalSeconds / 60
        ),

      averageDuration:
        totalCalls > 0
          ? formatDuration(
              averageSeconds
            )
          : '—',

      appointments,
      bookingRate,
    }
  }, [calls])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>
              Loading call history...
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
            className="dashboardNavItem dashboardNavItemActive"
          >
            Calls
          </a>

          <a
            href="/dashboard/agent"
            className="dashboardNavItem"
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

      {/* MAIN */}

      <section className="dashboardMain">

        {/* HEADER */}

        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              CALLS
            </p>

            <h1>
              Call Center
            </h1>

            <p>
              Monitor conversations,
              inspect call details and
              track performance.
            </p>
          </div>
        </div>

        {callWarning && (
          <div className="callsIntegrationWarning" role="status">
            <strong>Call sync notice</strong>
            <span>{callWarning}</span>
          </div>
        )}

        {/* LIVE MONITOR */}

        <section className="callsLiveCard">
          <div className="callsSectionHeading">
            <div>
              <span className="callsSectionLabel">
                LIVE MONITOR
              </span>

              <h2>
                Current call
              </h2>
            </div>

            <span
              className={
                activeCall
                  ? 'callsIdleBadge callsIdleBadge--live'
                  : 'callsIdleBadge'
              }
              aria-live="polite"
            >
              <span />
              {activeCall ? 'Live' : 'Idle'}
            </span>
          </div>

          <div className="callsLiveEmpty">
            <div className="callsLivePulse">
              <span />
            </div>

            <div>
              <strong>
                {activeCall
                  ? activeCall.caller_name ||
                    activeCall.caller_number ||
                    'Retell test call in progress'
                  : 'No active call'}
              </strong>

              <p>
                {activeCall
                  ? `Live for ${formatDuration(
                      activeCallSeconds
                    )}. Started ${new Date(
                      activeCall.started_at
                    ).toLocaleTimeString()}.`
                  : 'When your receptionist is speaking with a customer, the live call will appear here.'}
              </p>
            </div>
          </div>
        </section>

        {/* HISTORY + DETAILS */}

        <div className="callsWorkspace">

          {/* HISTORY */}

          <section className="callsHistoryPanel">
            <div className="callsSectionHeading">
              <div>
                <span className="callsSectionLabel">
                  HISTORY
                </span>

                <h2>
                  Call history
                </h2>
              </div>

              <span className="callsCount">
                {calls.length} calls
              </span>
            </div>

            <div className="callsSearch">
              <input
                type="search"
                placeholder="Search caller, number or outcome..."
                value={search}
                onChange={(event) =>
                  setSearch(
                    event.target.value
                  )
                }
              />
            </div>

            {filteredCalls.length === 0 ? (
              <div className="callsInnerEmpty">
                <strong>
                  No calls yet
                </strong>

                <p>
                  Your completed conversations
                  will appear here automatically.
                </p>
              </div>
            ) : (
              <div className="callsHistoryList">
                {filteredCalls.map(
                  (call) => (
                    <button
                      key={call.id}
                      type="button"
                      className={
                        selectedCall?.id ===
                        call.id
                          ? 'callsHistoryItem callsHistoryItem--active'
                          : 'callsHistoryItem'
                      }
                      onClick={() =>
                        setSelectedCall(
                          call
                        )
                      }
                    >
                      <div className="callsHistoryMain">
                        <strong>
                          {call.caller_name ||
                            call.caller_number ||
                            'Unknown caller'}
                        </strong>

                        <span>
                          {new Date(
                            call.started_at
                          ).toLocaleString()}
                        </span>
                      </div>

                      <div className="callsHistorySide">
                        <strong>
                          {formatDuration(
                            call.duration_seconds
                          )}
                        </strong>

                        {isPro &&
                          call.appointment_booked && (
                            <span className="callsBookedBadge">
                              Booked
                            </span>
                          )}
                      </div>
                    </button>
                  )
                )}
              </div>
            )}
          </section>

          {/* DETAILS */}

          <section className="callsDetailPanel">
            <div className="callsSectionHeading">
              <div>
                <span className="callsSectionLabel">
                  DETAILS
                </span>

                <h2>
                  Call details
                </h2>
              </div>
            </div>

            {!selectedCall ? (
              <div className="callsInnerEmpty">
                <strong>
                  Select a call
                </strong>

                <p>
                  Choose a conversation
                  from Call History to
                  inspect it.
                </p>
              </div>
            ) : (
              <div className="callsDetailContent">

                <div className="callsDetailHero">
                  <div>
                    <span>
                      CALLER
                    </span>

                    <strong>
                      {selectedCall.caller_name ||
                        selectedCall.caller_number ||
                        'Unknown caller'}
                    </strong>

                    {selectedCall.caller_name &&
                      selectedCall.caller_number && (
                        <small>
                          {
                            selectedCall.caller_number
                          }
                        </small>
                      )}
                  </div>

                  <span className="callsOutcomeBadge">
                    {selectedCall.outcome ||
                      'Completed'}
                  </span>
                </div>

                <div className="callsDetailGrid">
                  <div>
                    <span>
                      Date & time
                    </span>

                    <strong>
                      {new Date(
                        selectedCall.started_at
                      ).toLocaleString()}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Duration
                    </span>

                    <strong>
                      {formatDuration(
                        selectedCall.duration_seconds
                      )}
                    </strong>
                  </div>

                  {isPro && (
                    <div>
                      <span>
                        Appointment
                      </span>

                      <strong>
                        {selectedCall.appointment_booked
                          ? 'Booked'
                          : 'Not booked'}
                      </strong>
                    </div>
                  )}

                  <div>
                    <span>
                      Outcome
                    </span>

                    <strong>
                      {selectedCall.outcome ||
                        'Not classified'}
                    </strong>
                  </div>
                </div>

                <div className="callsSummaryBox">
                  <span>
                    AI CALL SUMMARY
                  </span>

                  <p>
                    {selectedCall.summary ||
                      'A call summary will appear here once Recepta receives one from the AI receptionist.'}
                  </p>
                </div>

                {isPro && selectedAppointment && (
                  <div className="callsSummaryBox">
                    <span>APPOINTMENT DETAILS</span>
                    <div className="callsDetailGrid" style={{ marginTop: '14px' }}>
                      <div>
                        <span>Name</span>
                        <strong>{selectedAppointment.customer_name || 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Phone</span>
                        <strong>{selectedAppointment.customer_phone || 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Email</span>
                        <strong>{selectedAppointment.customer_email || 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Company</span>
                        <strong>{selectedAppointment.company_name || 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Reason</span>
                        <strong>{selectedAppointment.service || 'Not provided'}</strong>
                      </div>
                      <div>
                        <span>Requested time</span>
                        <strong>{new Date(selectedAppointment.appointment_time).toLocaleString()}</strong>
                      </div>
                      {capturedDetails(selectedAppointment.notes).map((detail) => (
                        <div key={`${detail.label}:${detail.value}`}>
                          <span>{detail.label}</span>
                          <strong>{detail.value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="callsFutureTools">
                  <div>
                    <span>
                      Transcript
                    </span>

                    {selectedCall.transcript ? (
                      <p
                        style={{
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.6,
                        }}
                      >
                        {selectedCall.transcript}
                      </p>
                    ) : (
                      <strong>
                        Not available for this call
                      </strong>
                    )}
                  </div>

                  <div>
                    <span>
                      Recording
                    </span>

                    {selectedCall.recording_url ? (
                      <a
                        href={selectedCall.recording_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btnOutline"
                      >
                        Open Recording
                      </a>
                    ) : (
                      <strong>
                        Not available for this call
                      </strong>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ANALYTICS */}

        <section className="callsAnalytics">
          <div className="callsSectionHeading">
            <div>
              <span className="callsSectionLabel">
                PERFORMANCE
              </span>

              <h2>
                Call analytics
              </h2>
            </div>
          </div>

          <div className="callsAnalyticsGrid">
            <div>
              <span>
                Total Calls
              </span>

              <strong>
                {analytics.totalCalls}
              </strong>
            </div>

            <div>
              <span>
                Minutes Talked
              </span>

              <strong>
                {analytics.totalMinutes}
              </strong>
            </div>

            <div>
              <span>
                Avg. Duration
              </span>

              <strong>
                {analytics.averageDuration}
              </strong>
            </div>

            {isPro && (
              <div>
                <span>
                  Booking Rate
                </span>

                <strong>
                  {analytics.bookingRate}%
                </strong>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  )
}
