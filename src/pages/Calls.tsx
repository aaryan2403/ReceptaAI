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
}

export default function Calls() {
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null)
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

      const { data, error } = await supabase
        .from('calls')
        .select(
          'id, caller_name, caller_number, started_at, duration_seconds, outcome, summary, appointment_booked'
        )
        .eq('client_id', user.id)
        .order('started_at', { ascending: false })

      if (!error && data) {
        setCalls(data)

        if (data.length > 0) {
          setSelectedCall(data[0])
        }
      }

      setLoading(false)
    }

    loadCalls()
  }, [])

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60

    return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`
  }

  const filteredCalls = useMemo(() => {
    const query = search.toLowerCase().trim()

    if (!query) return calls

    return calls.filter((call) => {
      return (
        call.caller_name?.toLowerCase().includes(query) ||
        call.caller_number?.toLowerCase().includes(query) ||
        call.outcome?.toLowerCase().includes(query)
      )
    })
  }, [calls, search])

  const analytics = useMemo(() => {
    const totalCalls = calls.length

    const totalSeconds = calls.reduce(
      (total, call) => total + call.duration_seconds,
      0
    )

    const averageSeconds =
      totalCalls > 0 ? Math.round(totalSeconds / totalCalls) : 0

    const appointments = calls.filter(
      (call) => call.appointment_booked
    ).length

    const bookingRate =
      totalCalls > 0
        ? Math.round((appointments / totalCalls) * 100)
        : 0

    return {
      totalCalls,
      totalMinutes: Math.round(totalSeconds / 60),
      averageDuration:
        totalCalls > 0 ? formatDuration(averageSeconds) : '—',
      bookingRate,
    }
  }, [calls])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>Loading call history...</p>
          </div>
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

          <a
            href="/dashboard/calls"
            className="dashboardNavItem dashboardNavItemActive"
          >
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
            <p className="dashboardEyebrow">CALLS</p>
            <h1>Call Center</h1>
            <p>
              Monitor conversations, inspect call details and track performance.
            </p>
          </div>
        </div>

        {/* LIVE CALL MONITOR */}

        <section className="callsLiveCard">
          <div className="callsSectionHeading">
            <div>
              <span className="callsSectionLabel">LIVE MONITOR</span>
              <h2>Current call</h2>
            </div>

            <span className="callsIdleBadge">
              <span />
              Idle
            </span>
          </div>

          <div className="callsLiveEmpty">
            <div className="callsLivePulse">
              <span />
            </div>

            <div>
              <strong>No active call</strong>
              <p>
                When your receptionist is speaking with a customer, the live
                call will appear here.
              </p>
            </div>
          </div>
        </section>

        {/* CALL HISTORY + DETAILS */}

        <div className="callsWorkspace">
          <section className="callsHistoryPanel">
            <div className="callsSectionHeading">
              <div>
                <span className="callsSectionLabel">HISTORY</span>
                <h2>Call history</h2>
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
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            {filteredCalls.length === 0 ? (
              <div className="callsInnerEmpty">
                <strong>No calls yet</strong>
                <p>
                  Your completed conversations will appear here automatically.
                </p>
              </div>
            ) : (
              <div className="callsHistoryList">
                {filteredCalls.map((call) => (
                  <button
                    key={call.id}
                    type="button"
                    className={
                      selectedCall?.id === call.id
                        ? 'callsHistoryItem callsHistoryItem--active'
                        : 'callsHistoryItem'
                    }
                    onClick={() => setSelectedCall(call)}
                  >
                    <div className="callsHistoryMain">
                      <strong>
                        {call.caller_name ||
                          call.caller_number ||
                          'Unknown caller'}
                      </strong>

                      <span>
                        {new Date(call.started_at).toLocaleString()}
                      </span>
                    </div>

                    <div className="callsHistorySide">
                      <strong>
                        {formatDuration(call.duration_seconds)}
                      </strong>

                      {call.appointment_booked && (
                        <span className="callsBookedBadge">
                          Booked
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="callsDetailPanel">
            <div className="callsSectionHeading">
              <div>
                <span className="callsSectionLabel">DETAILS</span>
                <h2>Call details</h2>
              </div>
            </div>

            {!selectedCall ? (
              <div className="callsInnerEmpty">
                <strong>Select a call</strong>
                <p>
                  Choose a conversation from Call History to inspect it.
                </p>
              </div>
            ) : (
              <div className="callsDetailContent">
                <div className="callsDetailHero">
                  <div>
                    <span>CALLER</span>

                    <strong>
                      {selectedCall.caller_name ||
                        selectedCall.caller_number ||
                        'Unknown caller'}
                    </strong>

                    {selectedCall.caller_name &&
                      selectedCall.caller_number && (
                        <small>
                          {selectedCall.caller_number}
                        </small>
                      )}
                  </div>

                  <span className="callsOutcomeBadge">
                    {selectedCall.outcome || 'Completed'}
                  </span>
                </div>

                <div className="callsDetailGrid">
                  <div>
                    <span>Date & time</span>
                    <strong>
                      {new Date(
                        selectedCall.started_at
                      ).toLocaleString()}
                    </strong>
                  </div>

                  <div>
                    <span>Duration</span>
                    <strong>
                      {formatDuration(
                        selectedCall.duration_seconds
                      )}
                    </strong>
                  </div>

                  <div>
                    <span>Appointment</span>
                    <strong>
                      {selectedCall.appointment_booked
                        ? 'Booked'
                        : 'Not booked'}
                    </strong>
                  </div>

                  <div>
                    <span>Outcome</span>
                    <strong>
                      {selectedCall.outcome ||
                        'Not classified'}
                    </strong>
                  </div>
                </div>

                <div className="callsSummaryBox">
                  <span>AI CALL SUMMARY</span>

                  <p>
                    {selectedCall.summary ||
                      'A call summary will appear here once Recepta receives one from the AI receptionist.'}
                  </p>
                </div>

                <div className="callsFutureTools">
                  <div>
                    <span>Transcript</span>
                    <strong>Available after Retell integration</strong>
                  </div>

                  <div>
                    <span>Recording</span>
                    <strong>Available after Retell integration</strong>
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
              <span className="callsSectionLabel">PERFORMANCE</span>
              <h2>Call analytics</h2>
            </div>
          </div>

          <div className="callsAnalyticsGrid">
            <div>
              <span>Total Calls</span>
              <strong>{analytics.totalCalls}</strong>
            </div>

            <div>
              <span>Minutes Talked</span>
              <strong>{analytics.totalMinutes}</strong>
            </div>

            <div>
              <span>Avg. Duration</span>
              <strong>{analytics.averageDuration}</strong>
            </div>

            <div>
              <span>Booking Rate</span>
              <strong>{analytics.bookingRate}%</strong>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}
