import { useCallback, useEffect, useRef, useState } from 'react'
import { bookingDay, schedulingReason, type AppointmentSlot, type BookingDay, type SchedulingSettings } from '../lib/appointmentScheduling'
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
  settings: SchedulingSettings
  needsSync: boolean
  appointments: Appointment[]
  conflicts: Array<{ appointment_id: string; reason: string }>
  more: boolean
}

const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const filters = [
  { value: 'upcoming', label: 'Upcoming' }, { value: 'pending', label: 'Awaiting Confirmation' },
  { value: 'booked', label: 'All confirmed' }, { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
]
const statuses: Record<AppointmentStatus, string> = {
  pending: 'Awaiting Confirmation', booked: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed',
}
const timeZones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
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

function Minutes({ label, value, presets, min, max, onChange }: {
  label: string; value: number; presets: number[]; min: number; max: number; onChange: (value: number) => void
}) {
  const [custom, setCustom] = useState(!presets.includes(value))
  return <div className="appointmentControl">
    <label>{label}
      <select value={custom ? 'custom' : value} onChange={event => {
        setCustom(event.target.value === 'custom')
        if (event.target.value !== 'custom') onChange(Number(event.target.value))
      }}>
        {presets.map(preset => <option key={preset} value={preset}>{preset} min</option>)}
        <option value="custom">Custom</option>
      </select>
    </label>
    {custom && <label>Custom {label.toLowerCase()} in minutes
      <input type="number" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} />
    </label>}
  </div>
}

function DayRules({ title, day, onChange }: { title: string; day: BookingDay; onChange: (day: BookingDay) => void }) {
  return <fieldset className="appointmentDay">
    <legend>{title}</legend>
    <label className="appointmentCheck">
      <input type="checkbox" checked={day.open} onChange={event => onChange({ ...day, open: event.target.checked })} />
      {day.open ? 'Open for booking' : 'Closed'}
    </label>
    {day.open && <>
      <div className="appointmentGrid">
        <label>Opens<input type="time" value={day.start} onChange={event => onChange({ ...day, start: event.target.value })} /></label>
        <label>Closes
          <input type="time" disabled={day.end === '24:00'} value={day.end === '24:00' ? '00:00' : day.end}
            onChange={event => onChange({ ...day, end: event.target.value })} />
        </label>
      </div>
      <label className="appointmentCheck"><input type="checkbox" checked={day.end === '24:00'}
        onChange={event => onChange({ ...day, end: event.target.checked ? '24:00' : '17:00' })} /> Closes at midnight</label>
      {day.blocks.map((block, index) => <div className="appointmentBlock" key={index}>
        <label>From<input type="time" value={block.start} onChange={event => onChange({
          ...day, blocks: day.blocks.map((item, i) => i === index ? { ...item, start: event.target.value } : item),
        })} /></label>
        <label>Until<input type="time" value={block.end === '24:00' ? '00:00' : block.end} onChange={event => onChange({
          ...day, blocks: day.blocks.map((item, i) => i === index ? { ...item, end: event.target.value === '00:00' ? '24:00' : event.target.value } : item),
        })} /></label>
        <label>Max starts<input type="number" min="0" value={block.limit} onChange={event => onChange({
          ...day, blocks: day.blocks.map((item, i) => i === index ? { ...item, limit: Number(event.target.value) } : item),
        })} /></label>
        <button type="button" className="btn btnOutline" onClick={() => onChange({
          ...day, blocks: day.blocks.filter((_, i) => i !== index),
        })}>Remove</button>
      </div>)}
      <button type="button" className="btn btnOutline" disabled={day.blocks.length >= 24} onClick={() => {
        const start = day.blocks.at(-1)?.end ?? day.start
        const endHour = Number(start.slice(0, 2)) + 1
        const end = `${String(endHour).padStart(2,'0')}:00`
        onChange({ ...day, blocks: [...day.blocks, start >= day.end ? { start: day.start, end: day.end, limit: 1 } : { start, end: end < day.end ? end : day.end, limit: 1 }] })
      }}>Add capacity block</button>
    </>}
  </fieldset>
}

export default function AppointmentScheduling({ clientId }: { clientId?: string }) {
  const [settings, setSettings] = useState<SchedulingSettings | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [status, setStatus] = useState(() => !clientId && new URLSearchParams(window.location.search).get('status') === 'pending' ? 'pending' : 'upcoming')
  const [page, setPage] = useState(0)
  const [loadedFilter, setLoadedFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [exceptionDate, setExceptionDate] = useState('')
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

  const run = async (action: () => Promise<void>) => {
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
  const save = (forceSync = false) => run(async () => {
    const result = await callScheduling<{ settings: SchedulingSettings; synced: boolean }>(clientId, {}, 'PUT', { settings, forceSync })
    setSettings(result.settings); setNeedsSync(!result.synced); setDirty(false); setSlots(null)
    setData(previous => previous && { ...previous, settings: result.settings })
    setMessage(result.synced ? 'Appointment settings saved and synced with Retell.' : 'Appointment settings saved. Retell synchronization needs attention.')
    await refresh()
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
    {!data.activePro && <p className="appointmentFeedback">An active Recepta Pro plan is required to update scheduling settings or manage appointments.</p>}
    {data.activePro && <details className="appointmentPanel" open={clientId ? true : undefined}>
      <summary>{clientId ? 'Booking rules' : 'Appointment Scheduling Settings'}</summary>
      <fieldset className="appointmentSettings" disabled={busy}>
        <label className="appointmentCheck"><input type="checkbox" checked={settings.enabled}
          onChange={event => edit({ enabled: event.target.checked })} /> Allow the AI to confirm bookings</label>
        <div className="appointmentGrid">
          <Minutes label="Appointment duration" min={5} max={480} value={settings.duration_minutes} presets={[15,30,45,60,90,120]}
            onChange={duration_minutes => edit({ duration_minutes })} />
          <Minutes label="Start-time interval" min={1} max={1440} value={settings.start_interval_minutes} presets={[5,10,15,30,60]}
            onChange={start_interval_minutes => edit({ start_interval_minutes })} />
          <Minutes label="Buffer after appointments" min={0} max={120} value={settings.buffer_minutes} presets={[0,5,10,15,30]}
            onChange={buffer_minutes => edit({ buffer_minutes })} />
          <label>Booking timezone
            <input list={`appointment-time-zones-${clientId || 'pro'}`} value={settings.time_zone} onChange={event => edit({ time_zone: event.target.value })} />
          </label>
          <datalist id={`appointment-time-zones-${clientId || 'pro'}`}><option value="UTC" />{timeZones.map(zone => <option key={zone} value={zone} />)}</datalist>
          <label>Maximum overlapping appointments<input type="number" min="1" disabled={settings.capacity === null} value={settings.capacity ?? ''}
            onChange={event => edit({ capacity: Number(event.target.value) })} /></label>
          <label>Default maximum starts per hour<input type="number" min="0" placeholder="Unlimited"
            value={settings.hourly_limit ?? ''} onChange={event => edit({ hourly_limit: event.target.value === '' ? null : Number(event.target.value) })} /></label>
        </div>
        <label className="appointmentCheck"><input type="checkbox" checked={settings.capacity === null}
          onChange={event => edit({ capacity: event.target.checked ? null : 1 })} /> Unlimited overlapping appointments</label>
        <h3>Weekly booking hours</h3>
        <p>Capacity blocks override the default hourly limit for starts within the block. Use 0 to block new starts.</p>
        <div className="appointmentWeek">
          {dayNames.map((name, index) => {
            const day = String(index + 1)
            return <DayRules key={name} title={name} day={settings.weekly[day]}
              onChange={rule => edit({ weekly: { ...settings.weekly, [day]: rule } })} />
          })}
        </div>
        <h3>Date exceptions</h3>
        <div className="appointmentActions">
          <label>Exception date<input type="date" value={exceptionDate} onChange={event => setExceptionDate(event.target.value)} /></label>
          <button type="button" className="btn btnOutline" disabled={!exceptionDate || Boolean(settings.exceptions[exceptionDate])}
            onClick={() => {
              edit({ exceptions: { ...settings.exceptions, [exceptionDate]: bookingDay() } })
              setExceptionDate('')
            }}>Add exception</button>
        </div>
        {Object.entries(settings.exceptions).sort(([a], [b]) => a.localeCompare(b)).map(([key, rule]) => <div key={key}>
          <DayRules title={key} day={rule} onChange={day => edit({ exceptions: { ...settings.exceptions, [key]: day } })} />
          <button type="button" className="btn btnOutline" onClick={() => edit({
            exceptions: Object.fromEntries(Object.entries(settings.exceptions).filter(([day]) => day !== key)),
          })}>Remove {key} exception</button>
        </div>)}
        <h3>Appointment emails</h3>
        <label className="appointmentCheck"><input type="checkbox" checked={settings.email_owner}
          onChange={event => edit({ email_owner: event.target.checked })} /> Email the business about requests and confirmed bookings</label>
        <label className="appointmentCheck"><input type="checkbox" checked={settings.email_customer}
          onChange={event => edit({ email_customer: event.target.checked })} /> Email callers who agree to receive appointment updates</label>
        <div className="appointmentActions">
          <button type="button" className="btn btnPrimary" onClick={() => void save()}>Save appointment settings</button>
          {!dirty && (settings.sync_error || settings.synced_at) && <button type="button" className="btn btnOutline"
            onClick={() => void save(true)}>{needsSync ? 'Retry Retell sync' : 'Sync Retell again'}</button>}
        </div>
        {settings.sync_error && <p className="appointmentFeedback" role="status">{settings.sync_error}</p>}
        {!settings.sync_error && settings.synced_at && !needsSync && <small>Retell tools synchronized.</small>}
        {needsSync && settings.synced_at && <p>Save again to sync the currently assigned Retell agent.</p>}
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
