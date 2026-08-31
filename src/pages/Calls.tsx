import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type CallRecord = {
  id: string
  caller_name: string | null
  caller_number: string | null
  started_at: string
  duration_seconds: number
  outcome: string | null
  summary: string | null
  appointment_booked: boolean
  call_status: string | null
  transcript: string | null
  recording_url: string | null
}

type Subscription = {
  plan_name: string | null
}

export default function Calls() {
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [selectedCall, setSelectedCall] =
    useState<CallRecord | null>(null)

  const [subscription, setSubscription] =
    useState<Subscription | null>(null)

  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const loadCalls = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: callsData, error: callsError },
        { data: subscriptionData },
      ] = await Promise.all([
        supabase
          .from('calls')
          .select(
            `
            id,
            caller_name,
            caller_number,
            started_at,
            duration_seconds,
            outcome,
            summary,
            appointment_booked,
            call_status,
            transcript,
            recording_url
            `
          )
          .eq('client_id', user.id)
          .order('started_at', {
            ascending: false,
          }),

        supabase
          .from('subscriptions')
          .select('plan_name')
          .eq('client_id', user.id)
          .maybeSingle(),
      ])

      let resolvedCalls = callsData

      if (callsError) {
        const { data: legacyCalls } =
          await supabase
            .from('calls')
            .select(
              `
              id,
              caller_name,
              caller_number,
              started_at,
              duration_seconds,
              outcome,
              summary,
              appointment_booked
              `
            )
            .eq('client_id', user.id)
            .order('started_at', {
              ascending: false,
            })

        resolvedCalls =
          legacyCalls?.map((call) => ({
            ...call,
            call_status: null,
            transcript: null,
            recording_url: null,
          })) ?? null
      }

      if (resolvedCalls) {
        setCalls(resolvedCalls)

        setSelectedCall((current) =>
          current
            ? resolvedCalls.find(
                (call) =>
                  call.id === current.id
              ) ?? resolvedCalls[0] ?? null
            : resolvedCalls[0] ?? null
        )
      }

      if (subscriptionData) {
        setSubscription(subscriptionData)
      }

      setLoading(false)
    }

    loadCalls()

    const refreshInterval =
      window.setInterval(
        loadCalls,
        5000
      )

    return () => {
      window.clearInterval(
        refreshInterval
      )
    }
  }, [])

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const activeCall = calls.find(
    (call) =>
      call.call_status === 'ongoing' ||
      call.call_status === 'registered'
  )

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

            <span className="callsIdleBadge">
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
                    'Demo call in progress'
                  : 'No active call'}
              </strong>

              <p>
                {activeCall
                  ? `Started ${new Date(
                      activeCall.started_at
                    ).toLocaleTimeString()}. Live status refreshes automatically.`
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
