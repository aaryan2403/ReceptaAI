import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type AppointmentRecord = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  company_name: string | null
  service: string | null
  notes: string | null
  appointment_time: string
  status: 'booked' | 'cancelled' | 'completed'
  source: string | null
  retell_call_id: string | null
}

type CallSummary = {
  retell_call_id: string | null
  summary: string | null
}

type CapturedDetail = { label: string; value: string }

const summaryFor = (
  appointment: AppointmentRecord,
  summaries: CallSummary[]
) => {
  const callId = appointment.retell_call_id?.split(':')[0]
  return summaries.find((call) => call.retell_call_id === callId)?.summary || null
}

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

export default function Appointments() {
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([])
  const [summaries, setSummaries] = useState<CallSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setLoading(false)
        return
      }

      const [appointmentResult, callResult] = await Promise.all([
        supabase
          .from('appointments')
          .select('id, customer_name, customer_phone, customer_email, company_name, service, notes, appointment_time, status, source, retell_call_id')
          .eq('client_id', user.id)
          .order('appointment_time', { ascending: false }),
        supabase
          .from('calls')
          .select('retell_call_id, summary')
          .eq('client_id', user.id)
          .order('started_at', { ascending: false }),
      ])

      if (appointmentResult.error) {
        setError(appointmentResult.error.message)
      } else {
        const rows = (appointmentResult.data ?? []) as AppointmentRecord[]
        setAppointments(rows)
        setSelectedId(rows[0]?.id ?? null)
      }

      if (!callResult.error) setSummaries((callResult.data ?? []) as CallSummary[])
      setLoading(false)
    }

    void load()
  }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return appointments

    return appointments.filter((appointment) => {
      const searchable = [
        appointment.customer_name,
        appointment.customer_phone,
        appointment.customer_email,
        appointment.company_name,
        appointment.service,
        summaryFor(appointment, summaries),
        ...capturedDetails(appointment.notes).flatMap((detail) => [detail.label, detail.value]),
      ]
      return searchable.some((value) => value?.toLowerCase().includes(query))
    })
  }, [appointments, search, summaries])

  const selected =
    filtered.find((appointment) => appointment.id === selectedId) ||
    filtered[0] ||
    null

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand"><img src="/components/logoR.png" alt="Recepta" /></a>
        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">Overview</a>
          <a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
          <a href="/dashboard/appointments" className="dashboardNavItem dashboardNavItemActive">Appointments</a>
          <a href="/dashboard/agent" className="dashboardNavItem">Agent</a>
          <a href="/dashboard/billing" className="dashboardNavItem">Billing</a>
          <a href="/dashboard/settings" className="dashboardNavItem">Settings</a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">APPOINTMENTS</p>
            <h1>Appointment details</h1>
            <p>View the information your AI receptionist collected from each caller.</p>
          </div>
        </div>

        {error && <div className="calendarAlert calendarAlert--error">{error}</div>}

        <section className="appointmentAnalytics">
          <div className="appointmentAnalyticsGrid">
            <div><span>Total requests</span><strong>{appointments.length}</strong></div>
            <div><span>Captured by AI</span><strong>{appointments.filter((item) => item.source === 'retell').length}</strong></div>
            <div><span>With AI summary</span><strong>{appointments.filter((item) => summaryFor(item, summaries)).length}</strong></div>
          </div>
        </section>

        <div className="appointmentSearch">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search any captured appointment detail..."
          />
        </div>

        {loading ? (
          <div className="dashboardEmptyState"><p>Loading appointments...</p></div>
        ) : (
          <div className="appointmentWorkspace">
            <section className="appointmentListPanel">
              <div className="appointmentSectionHeading">
                <div><span className="appointmentSectionLabel">AI INTAKE</span><h2>Appointment requests</h2></div>
                <span className="appointmentCount">{filtered.length}</span>
              </div>

              {filtered.length === 0 ? (
                <div className="appointmentInnerEmpty">
                  <strong>No appointment details yet</strong>
                  <p>Confirmed appointment requests captured during calls will appear here.</p>
                </div>
              ) : (
                <div className="appointmentHistoryList">
                  {filtered.map((appointment) => (
                    <button
                      key={appointment.id}
                      type="button"
                      onClick={() => setSelectedId(appointment.id)}
                      className={selected?.id === appointment.id
                        ? 'appointmentHistoryItem appointmentHistoryItem--active'
                        : 'appointmentHistoryItem'}
                    >
                      <div className="appointmentHistoryMain">
                        <strong>{appointment.customer_name || 'Unknown caller'}</strong>
                        <span>{appointment.service || 'Appointment request'}</span>
                      </div>
                      <div className="appointmentHistorySide">
                        <strong>{new Date(appointment.appointment_time).toLocaleString()}</strong>
                        <span className="appointmentStatus appointmentStatus--booked">captured</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="appointmentDetailPanel">
              <div className="appointmentSectionHeading">
                <div><span className="appointmentSectionLabel">DETAILS</span><h2>Full appointment record</h2></div>
              </div>

              {!selected ? (
                <div className="appointmentInnerEmpty"><strong>Select an appointment</strong></div>
              ) : (
                <div className="appointmentDetailContent">
                  <div className="appointmentDetailHero">
                    <div>
                      <span>CALLER</span>
                      <strong>{selected.customer_name || 'Unknown caller'}</strong>
                      <small>Captured {new Date(selected.appointment_time).toLocaleString()}</small>
                    </div>
                    <span className="appointmentStatus appointmentStatus--booked">AI captured</span>
                  </div>

                  <div className="appointmentDetailGrid">
                    <div><span>Phone</span><strong>{selected.customer_phone || 'Not provided'}</strong></div>
                    <div><span>Email</span><strong>{selected.customer_email || 'Not provided'}</strong></div>
                    <div><span>Company</span><strong>{selected.company_name || 'Not provided'}</strong></div>
                    <div><span>Reason</span><strong>{selected.service || 'Not provided'}</strong></div>
                    {capturedDetails(selected.notes).map((detail) => (
                      <div key={`${detail.label}:${detail.value}`}>
                        <span>{detail.label}</span><strong>{detail.value}</strong>
                      </div>
                    ))}
                  </div>

                  <div className="appointmentDetailNotice">
                    <span>AI CALL SUMMARY</span>
                    <p>{summaryFor(selected, summaries) || 'The AI summary will appear after Retell finishes analyzing the call.'}</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  )
}
