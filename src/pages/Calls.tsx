import { useEffect, useState } from 'react'
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
  const [loading, setLoading] = useState(true)

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
            <h1>Call history</h1>
            <p>
              Every call handled by your Recepta receptionist appears here.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading calls...</p>
          </div>
        ) : calls.length === 0 ? (
          <div className="dashboardEmptyState">
            <h2>No calls yet</h2>
            <p>
              Once your AI receptionist starts handling calls, caller details,
              duration, summaries, and outcomes will appear here.
            </p>
          </div>
        ) : (
          <div className="callsList">
            {calls.map((call) => (
              <div className="callCard" key={call.id}>
                <div className="callCardTop">
                  <div>
                    <strong>
                      {call.caller_name || call.caller_number || 'Unknown caller'}
                    </strong>

                    <span>
                      {new Date(call.started_at).toLocaleString()}
                    </span>
                  </div>

                  <span className="callDuration">
                    {formatDuration(call.duration_seconds)}
                  </span>
                </div>

                <div className="callMeta">
                  <span>
                    Outcome: {call.outcome || 'Not classified'}
                  </span>

                  <span>
                    Appointment: {call.appointment_booked ? 'Booked' : 'No'}
                  </span>
                </div>

                {call.summary && (
                  <p className="callSummary">
                    {call.summary}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
