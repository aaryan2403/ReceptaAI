import { useCallback, useEffect, useRef, useState } from 'react'
import { schedulingReason, type AppointmentSlot, type SchedulingSettings } from '../lib/appointmentScheduling'
import { capturedDetails, formatAppointmentPreference, type AppointmentPreference, type AppointmentStatus } from '../lib/appointmentRequests'
import { supabase } from '../lib/supabase'
import './AppointmentScheduling.css'

type Appointment = AppointmentPreference & {
  id: string
  status: AppointmentStatus
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  company_name: string | null
  service: string | null
  notes: string | null
  appointment_time: string | null
  appointment_end_time: string | null
  duration_minutes: number | null
  booking_time_zone: string | null
  booking_version: number
  retell_call_id: string | null
  created_at: string
}

type DashboardData = {
  activePro: boolean
  accessIssue: string | null
  settings: SchedulingSettings
  needsSync: boolean
  appointments: Appointment[]
  conflicts: Array<{ appointment_id: string; reason: string }>
  more: boolean
}

const filters = [
  { value: 'upcoming', label: 'Upcoming' }, { value: 'pending', label: 'Awaiting Confirmation' },
  { value: 'booked', label: 'All confirmed' }, { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
]
const statuses: Record<AppointmentStatus, string> = {
  pending: 'Awaiting Confirmation', booked: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed',
}
const localDate = (zone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' }).format(new Date())
const appointmentTime = (date: string, zone: string) => new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(date))

const callScheduling = async <T,>(clientId?: string, params: Record<string, string> = {}, method = 'GET', body?: unknown): Promise<T> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const query = new URLSearchParams(clientId ? { ...params, clientId } : params)
  const response = await fetch('/.netlify/functions/appointment-scheduling?' + query.toString(), {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Appointment scheduling is unavailable.')
  return data
}

export default function AppointmentScheduling({ clientId }: { clientId?: string }) {
  const [settings, setSettings] = useState<SchedulingSettings | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [status, setStatus] = useState(() => !clientId && new URLSearchParams(window.location.search).get('status') === 'pending' ? 'pending' : 'upcoming')
  const [page, setPage] = useState(0)
  const [loadedFilter, setLoadedFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [availabilityDate, setAvailabilityDate] = useState('')
  const [slots, setSlots] = useState<AppointmentSlot[] | null>(null)
  const [selected, setSelected] = useState<Appointment | null>(null)
  const [chosenSlot, setChosenSlot] = useState('')
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [needsSync, setNeedsSync] = useState(false)
  const [dirty, setDirty] = useState(false)
  const availability = useRef<HTMLElement>(null)

  const refresh = useCallback(async () => {
    const result = await callScheduling<DashboardData>(clientId, { status, page: String(page) })
    setData(result)
    setSettings(previous => previous ?? result.settings)
    setNeedsSync(result.needsSync)
    setLoadedFilter(status + page)
    return result
  }, [clientId, page, status])

  useEffect(() => {
    let active = true
    void callScheduling<DashboardData>(clientId, { status, page: String(page) }).then(result => {
      if (!active) return
      setData(result)
      setSettings(previous => previous ?? result.settings)
      setNeedsSync(result.needsSync)
      setLoadedFilter(status + page)
    }, failure => { if (active) setError(failure.message) })
    return () => { active = false }
  }, [clientId, page, status, reloadKey])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Appointment scheduling is unavailable.')
    } finally { setBusy(false) }
  }

  if (!data || !settings) return <div className="appointmentWorkspace">
    <p role={error ? 'alert' : 'status'}>{error || 'Loading appointment scheduling…'}</p>
    {error && <button type="button" className="btn btnOutline" onClick={() => { setError(''); setReloadKey(value => value + 1) }}>Retry</button>}
  </div>
  const zone = data.settings.time_zone
  const today = localDate(zone)
  const date = availabilityDate || today
  const edit = (patch: Partial<SchedulingSettings>) => { setSettings({ ...settings, ...patch }); setDirty(true) }
  const loadSlots = async (onDate: string, record?: Appointment | null) => {
    setSlots(null)
    setChosenSlot('')
    const result = await callScheduling<{ slots?: AppointmentSlot[]; reason?: string }>(clientId,
      { date: onDate, ...(record?.status === 'booked' ? { appointmentId: record.id } : {}) })
    setSlots(result.slots ?? [])
    if (result.reason && result.reason !== 'choose_a_time') setMessage(schedulingReason(result.reason))
  }
  const save = () => run(async () => {
    if (settings.hourly_limit === null || !Number.isInteger(settings.hourly_limit) || settings.hourly_limit < 1) throw new Error('Enter how many bookings per hour are allowed.')
    const result = await callScheduling<{ settings: SchedulingSettings; synced: boolean; accessIssue?: string }>(clientId, {}, 'PUT', { settings: { ...settings, enabled: true } })
    setSettings(result.settings); setNeedsSync(!result.synced); setDirty(false); setSlots(null)
    setData(previous => previous && { ...previous, settings: result.settings })
    setMessage(result.synced ? 'Appointment settings saved and synced with Retell.' :
      result.accessIssue ? 'Appointment settings saved for setup. Booking remains unavailable until Pro is active.' :
      'Appointment settings saved. Retell synchronization needs attention.')
    await refresh()
  })
  const retrySync = () => run(async () => {
    await callScheduling(clientId, {}, 'POST')
    const result = await refresh()
    setSettings(result.settings)
    setMessage('Retell appointment tools verified.')
  })
  const update = (record: Appointment, action: 'cancel' | 'confirm' | 'reschedule') => run(async () => {
    try {
      await callScheduling(clientId, {}, 'PATCH', { id: record.id, version: record.booking_version, action, start: chosenSlot })
    } catch (failure) {
      await refresh()
      setSelected(null); setCancelId(null); setSlots(null); setChosenSlot('')
      throw failure
    }
    setSelected(null); setCancelId(null); setSlots(null); setChosenSlot('')
    setMessage(action === 'cancel' ? 'Appointment cancelled.' : action === 'confirm' ? 'Appointment confirmed.' : 'Appointment rescheduled.')
    if (page) setPage(0)
    else await refresh()
  })
  const selectAppointment = (record: Appointment) => {
    setSelected(record); setCancelId(null); setSlots(null); setChosenSlot(''); setMessage(''); setError('')
    const requested = record.appointment_time
      ? new Intl.DateTimeFormat('sv-SE', { timeZone: zone, dateStyle: 'short' }).format(new Date(record.appointment_time))
      : record.requested_date
    setAvailabilityDate(requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= today ? requested : today)
    availability.current?.focus()
  }

  return <div className="appointmentWorkspace">
    {data.accessIssue && <p className="appointmentFeedback" role="status">{data.accessIssue}</p>}
    {(clientId || data.activePro) && <details className="appointmentPanel" open={clientId ? true : undefined}>
      <summary>{clientId ? 'Booking rules' : 'Appointment Scheduling Settings'}</summary>
      <fieldset className="appointmentSettings" disabled={busy}>
        <div className="appointmentGrid">
          <label>When can the AI book appointments?
            <select value={settings.booking_hours_mode ?? 'store_hours'} onChange={event =>
              edit({ booking_hours_mode: event.target.value as 'store_hours' | 'anytime' })}>
              <option value="store_hours">Only during store hours</option>
              <option value="anytime">Anytime (24/7, even when the store is closed)</option>
            </select>
          </label>
          <label>Bookings per hour
            <input type="number" min="1" step="1" placeholder="Enter a limit" required
              value={settings.hourly_limit ?? ''} onChange={event =>
                edit({ hourly_limit: event.target.value === '' ? null : Number(event.target.value) })} />
          </label>
        </div>
        <p>The AI checks these booking rules automatically. Store hours are managed above in Store Hours &amp; AI Answering.</p>
        <div className="appointmentActions">
          <button type="button" className="btn btnPrimary" onClick={() => void save()}>Save booking rules</button>
          {data.activePro && !dirty && needsSync && <button type="button" className="btn btnOutline"
            onClick={() => void retrySync()}>Retry Retell sync</button>}
        </div>
        {data.activePro && settings.sync_error && <p className="appointmentFeedback" role="status">{settings.sync_error}</p>}
        {data.activePro && !settings.sync_error && settings.synced_at && !needsSync && <small>Retell tools synchronized.</small>}
      </fieldset>
    </details>}

    {error && <p className="appointmentFeedback appointmentError" role="alert">{error}</p>}
    {message && <p className="appointmentFeedback" role="status">{message}</p>}
    <section className="appointmentPanel">
      <h3>Appointments</h3>
      <div className="appointmentActions">
        <label>Show<select value={status} onChange={event => {
          setStatus(event.target.value); setPage(0); setSelected(null); setCancelId(null); setError('')
        }}>{filters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void run(refresh)}>Refresh</button>
      </div>
      {loadedFilter !== status + page ? <p role="status">Loading appointments…</p> : <>
        {data.appointments.length === 0 && <p>No appointments in this view.</p>}
        <div className="appointmentRecords">
          {data.appointments.map(record => {
            const conflict = data.conflicts.find(item => item.appointment_id === record.id)
            const bookedZone = record.booking_time_zone || zone
            return <details key={record.id} className="appointmentRecord" open={selected?.id === record.id || cancelId === record.id ? true : undefined}>
              <summary><strong>{record.customer_name || 'Caller'}</strong>
                <span>{statuses[record.status]}{record.appointment_time ? ` · ${appointmentTime(record.appointment_time, bookedZone)}` : ''}</span>
              </summary>
              {conflict && <p className="appointmentError">{schedulingReason(conflict.reason)}</p>}
              <dl>
                {record.status === 'pending' && <><dt>Requested</dt><dd>{formatAppointmentPreference(record)}</dd></>}
                {record.appointment_time && <><dt>Time zone</dt><dd>{bookedZone}</dd></>}
                {record.appointment_end_time && <><dt>Ends</dt><dd>{appointmentTime(record.appointment_end_time, bookedZone)}</dd></>}
                {record.duration_minutes && <><dt>Duration</dt><dd>{record.duration_minutes} min</dd></>}
                {record.customer_phone && <><dt>Phone</dt><dd>{record.customer_phone}</dd></>}
                {record.customer_email && <><dt>Email</dt><dd>{record.customer_email}</dd></>}
                {record.company_name && <><dt>Company</dt><dd>{record.company_name}</dd></>}
                {record.service && <><dt>Service</dt><dd>{record.service}</dd></>}
                {record.retell_call_id && <><dt>Retell call</dt><dd>{record.retell_call_id}</dd></>}
                {capturedDetails(record.notes).map(item => <div className="appointmentDetail" key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
              </dl>
              {data.activePro && (record.status === 'pending' || record.status === 'booked') && <div className="appointmentActions">
                <button type="button" className="btn btnOutline" disabled={busy} onClick={() => selectAppointment(record)}>
                  {record.status === 'pending' ? 'Choose a time to confirm' : 'Reschedule'}
                </button>
                <button type="button" className="btn btnOutline" disabled={busy} onClick={() => { setCancelId(record.id); setSelected(null) }}>Cancel appointment</button>
              </div>}
              {cancelId === record.id && <div className="appointmentActions">
                <span>Cancel this {record.status === 'pending' ? 'request' : 'booking'}?</span>
                <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void update(record, 'cancel')}>Yes, cancel</button>
                <button type="button" className="btn btnOutline" disabled={busy} onClick={() => setCancelId(null)}>Keep appointment</button>
              </div>}
            </details>
          })}
        </div>
        {(page > 0 || data.more) && <div className="appointmentActions">
          <button type="button" className="btn btnOutline" disabled={busy || !page} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page + 1}</span>
          <button type="button" className="btn btnOutline" disabled={busy || !data.more} onClick={() => setPage(page + 1)}>Next</button>
        </div>}
      </>}
    </section>

    {data.activePro && <section className="appointmentPanel" ref={availability} tabIndex={-1}>
      <h3>{selected ? `${selected.status === 'pending' ? 'Confirm' : 'Reschedule'} ${selected.customer_name || 'appointment'}` : 'Availability'}</h3>
      <div className="appointmentActions">
        <label>Date in {zone}<input type="date" min={today} value={date} onChange={event => {
          setAvailabilityDate(event.target.value); setSlots(null); setChosenSlot('')
        }} /></label>
        <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void run(() => loadSlots(date, selected))}>Check availability</button>
        {selected && <button type="button" className="btn btnOutline" disabled={busy}
          onClick={() => { setSelected(null); setSlots(null); setChosenSlot('') }}>Exit appointment edit</button>}
      </div>
      {slots && (slots.length === 0 ? <p>No starts are scheduled for this date.</p> : <div className="appointmentSlots">
        <table><thead><tr><th scope="col">Start</th><th scope="col">Starts left in block</th><th scope="col">Overlapping places left</th><th scope="col">Availability</th></tr></thead>
          <tbody>{slots.map(slot => <tr key={slot.start}>
            <td>{slot.wall_time} <small>{slot.start?.slice(-6)}</small></td>
            <td>{slot.hourly_remaining ?? (slot.hourly_limit === null ? 'Unlimited' : '—')}{slot.hourly_limit != null ? ` / ${slot.hourly_limit}` : ''}</td>
            <td>{slot.simultaneous_remaining ?? (slot.simultaneous_remaining === null ? 'Unlimited' : '—')}</td>
            <td>{slot.available && selected ? <button type="button" className="btn btnOutline" aria-pressed={chosenSlot === slot.start}
              disabled={busy} onClick={() => setChosenSlot(slot.start || '')}>{chosenSlot === slot.start ? 'Selected' : 'Choose'}</button>
              : slot.available ? 'Available' : schedulingReason(slot.reason)}</td>
          </tr>)}</tbody>
        </table>
      </div>)}
      {selected && chosenSlot && <button type="button" className="btn btnPrimary" disabled={busy}
        onClick={() => void update(selected, selected.status === 'pending' ? 'confirm' : 'reschedule')}>
        {selected.status === 'pending' ? 'Confirm appointment' : 'Save new time'}
      </button>}
    </section>}
  </div>
}
