import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { syncEmployeeScheduleWithRetell } from '../lib/employeeSchedule'
import './EmployeeCalendar.css'

type EntryKind = 'appointment' | 'block'

type Employee = {
  id: string
  name: string
  role: string | null
  email: string | null
  is_active: boolean
  calendar_color: string | null
}

type Appointment = {
  id: string
  employee_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  company_name: string | null
  service: string | null
  notes: string | null
  internal_notes: string | null
  appointment_time: string
  appointment_end_time: string | null
  duration_minutes: number
  status: 'booked' | 'cancelled' | 'completed'
  source: string
}

type CalendarBlock = {
  id: string
  employee_id: string
  title: string
  details: string | null
  block_type: string
  starts_at: string
  ends_at: string
}

type BusinessSchedule = {
  mode: '24/7' | 'custom'
  timeZone: string
  hours: Array<{
    day: string
    open: boolean
    start: string
    end: string
  }>
}

type CalendarResponse = {
  calendar?: {
    date: string
    endDate: string
    timeZone: string
    businessSchedule: BusinessSchedule
    appointmentOverlapLimit: number
    employees: Employee[]
    appointments: Appointment[]
    blocks: CalendarBlock[]
    warning?: string | null
  }
  confirmationEmailSent?: boolean
  confirmationWarning?: string | null
  error?: string
}

type FormState = {
  kind: EntryKind
  employeeId: string
  date: string
  time: string
  durationMinutes: string
  customerName: string
  customerPhone: string
  blockTitle: string
  customFields: Array<{ id: string; value: string }>
}

type CalendarItem = {
  id: string
  kind: EntryKind
  employeeName: string
  date: string
  time: string
  title: string
  detail: string
  color: string
}

const DEFAULT_COLOR = '#00e676'
const DEFAULT_SCHEDULE: BusinessSchedule = {
  mode: '24/7',
  timeZone: 'America/Toronto',
  hours: [],
}
const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const localDate = () => {
  const date = new Date()
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

const parseDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const dateValue = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')

const addDays = (value: string, amount: number) => {
  const date = parseDate(value)
  date.setDate(date.getDate() + amount)
  return dateValue(date)
}

const monthStart = (value = localDate()) => {
  const date = parseDate(value)
  date.setDate(1)
  return dateValue(date)
}

const changeMonth = (value: string, amount: number) => {
  const date = parseDate(value)
  date.setMonth(date.getMonth() + amount, 1)
  return dateValue(date)
}

const calendarStart = (month: string) => {
  const date = parseDate(monthStart(month))
  date.setDate(date.getDate() - date.getDay())
  return dateValue(date)
}

const nextSlot = () => {
  const date = new Date(Date.now() + 5 * 60_000)
  date.setSeconds(0, 0)
  date.setMinutes(Math.ceil(date.getMinutes() / 30) * 30)
  return {
    date: dateValue(date),
    time: `${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes()
    ).padStart(2, '0')}`,
  }
}

const initialForm = (employeeId = '', chosenDate?: string): FormState => {
  const next = nextSlot()
  return {
    kind: 'appointment',
    employeeId,
    date: chosenDate || next.date,
    time: chosenDate && chosenDate !== next.date ? '09:00' : next.time,
    durationMinutes: '30',
    customerName: '',
    customerPhone: '',
    blockTitle: '',
    customFields: [],
  }
}

const colorValue = (value?: string | null) =>
  /^#[0-9a-f]{6}$/i.test(value || '') ? value! : DEFAULT_COLOR

const textColor = (color: string) => {
  const value = colorValue(color).slice(1)
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150
    ? '#041108'
    : '#ffffff'
}

export default function CalendarPage() {
  const [month, setMonth] = useState(monthStart)
  const [timeZone, setTimeZone] = useState('America/Toronto')
  const [schedule, setSchedule] = useState<BusinessSchedule>(DEFAULT_SCHEDULE)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [blocks, setBlocks] = useState<CalendarBlock[]>([])
  const [form, setForm] = useState<FormState>(() => initialForm())
  const [staffDraft, setStaffDraft] = useState('')
  const [detailDraft, setDetailDraft] = useState('')
  const [overlapLimit, setOverlapLimit] = useState(0)
  const [composerOpen, setComposerOpen] = useState(false)
  const [viewItem, setViewItem] = useState<CalendarItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [addingStaff, setAddingStaff] = useState(false)
  const [savingOverlap, setSavingOverlap] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [message, setMessage] = useState('')

  const gridStart = useMemo(() => calendarStart(month), [month])
  const gridDays = useMemo(
    () => Array.from({ length: 42 }, (_, index) => addDays(gridStart, index)),
    [gridStart]
  )
  const gridEnd = gridDays[41]

  const requestCalendar = useCallback(
    async (path: string, init?: RequestInit): Promise<CalendarResponse> => {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')

      const response = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
      const raw = await response.text()
      let body: CalendarResponse = {}

      try {
        body = raw ? (JSON.parse(raw) as CalendarResponse) : {}
      } catch {
        throw new Error('The calendar server returned an invalid response.')
      }
      if (!response.ok) throw new Error(body.error || 'The calendar request failed.')
      return body
    },
    []
  )

  const withStoredColors = useCallback(
    (rows: Employee[]) =>
      rows.map((employee) => ({
        ...employee,
        calendar_color:
          employee.calendar_color ||
          window.localStorage.getItem(
            `recepta-employee-color:${employee.id}`
          ),
      })),
    []
  )

  const loadCalendar = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const body = await requestCalendar(
        `/.netlify/functions/calendar?start=${encodeURIComponent(
          gridStart
        )}&end=${encodeURIComponent(gridEnd)}`
      )
      if (!body.calendar) throw new Error('The calendar response was incomplete.')

      const calendarEmployees = withStoredColors(body.calendar.employees)
      const active = calendarEmployees.filter((employee) => employee.is_active)
      setTimeZone(body.calendar.timeZone)
      setSchedule(body.calendar.businessSchedule || DEFAULT_SCHEDULE)
      setEmployees(calendarEmployees)
      setAppointments(body.calendar.appointments)
      setBlocks(body.calendar.blocks)
      setOverlapLimit(body.calendar.appointmentOverlapLimit || 0)
      setError(body.calendar.warning || '')
      setForm((current) => ({
        ...current,
        employeeId: active.some((employee) => employee.id === current.employeeId)
          ? current.employeeId
          : active[0]?.id || '',
      }))
    } catch (loadError) {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const { data } = user
        ? await supabase
            .from('employees')
            .select('id, name, role, email, is_active')
            .eq('client_id', user.id)
            .order('created_at', { ascending: true })
        : { data: [] }
      const restored = withStoredColors(
        (data ?? []).map((employee) => ({
          ...employee,
          calendar_color: null,
        })) as Employee[]
      )
      const active = restored.filter((employee) => employee.is_active)
      setEmployees(restored)
      setAppointments([])
      setBlocks([])
      setForm((current) => ({
        ...current,
        employeeId: active.some((employee) => employee.id === current.employeeId)
          ? current.employeeId
          : active[0]?.id || '',
      }))
      setError(
        restored.length
          ? 'Your employees loaded, but the calendar database setup is incomplete. Run supabase_add_employee_calendar.sql in Supabase.'
          : loadError instanceof Error
            ? loadError.message
            : 'Could not load the appointment calendar.'
      )
    } finally {
      setLoading(false)
    }
  }, [gridEnd, gridStart, requestCalendar, withStoredColors])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCalendar()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadCalendar])

  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees]
  )
  const activeEmployees = employees.filter((employee) => employee.is_active)
  const selectedEmployee = employeeById.get(form.employeeId)

  const dateInZone = useCallback(
    (value: string) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(value))
      const get = (type: string) =>
        parts.find((part) => part.type === type)?.value || ''
      return `${get('year')}-${get('month')}-${get('day')}`
    },
    [timeZone]
  )

  const timeInZone = useCallback(
    (value: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value)),
    [timeZone]
  )

  const calendarItems = useMemo<CalendarItem[]>(() => {
    const booked = appointments
      .filter((appointment) => appointment.status === 'booked')
      .map((appointment) => {
        const employee = appointment.employee_id
          ? employeeById.get(appointment.employee_id)
          : null
        return {
          id: appointment.id,
          kind: 'appointment' as const,
          employeeName: employee?.name || 'Unassigned',
          date: dateInZone(appointment.appointment_time),
          time: timeInZone(appointment.appointment_time),
          title: appointment.customer_name || 'Appointment',
          detail: [
            appointment.customer_phone,
            appointment.service,
            appointment.notes,
          ]
            .filter(Boolean)
            .join(' · '),
          color: colorValue(employee?.calendar_color),
        }
      })

    const unavailable = blocks.map((block) => {
      const employee = employeeById.get(block.employee_id)
      return {
        id: block.id,
        kind: 'block' as const,
        employeeName: employee?.name || 'Unassigned',
        date: dateInZone(block.starts_at),
        time: timeInZone(block.starts_at),
        title: block.title,
        detail: block.details || 'Unavailable',
        color: colorValue(employee?.calendar_color),
      }
    })

    return [...booked, ...unavailable]
  }, [appointments, blocks, dateInZone, employeeById, timeInZone])

  const itemsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarItem[]>()
    calendarItems.forEach((item) =>
      grouped.set(item.date, [...(grouped.get(item.date) || []), item])
    )
    grouped.forEach((items) =>
      items.sort((left, right) => left.time.localeCompare(right.time))
    )
    return grouped
  }, [calendarItems])

  const updateForm = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key]
  ) => setForm((current) => ({ ...current, [key]: value }))

  const addOrSelectStaff = async () => {
    const name = staffDraft.trim()
    if (!name) return

    const existing = employees.find(
      (employee) => employee.name.toLowerCase() === name.toLowerCase()
    )
    if (existing?.is_active) {
      updateForm('employeeId', existing.id)
      setStaffDraft('')
      setMessage(`${existing.name} is selected.`)
      return
    }

    setAddingStaff(true)
    setError('')
    setMessage('')

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error('Please sign in again.')

      let employee: Employee
      if (existing) {
        const result = await supabase
          .from('employees')
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .eq('client_id', user.id)
          .select('id, name, role, email, is_active')
          .single()
        if (result.error || !result.data) {
          throw new Error(result.error?.message || 'Could not activate employee.')
        }
        employee = { ...result.data, calendar_color: existing.calendar_color }
      } else {
        const result = await supabase
          .from('employees')
          .insert({
            client_id: user.id,
            name,
            email: null,
            phone: null,
            role: null,
            is_active: true,
          })
          .select('id, name, role, email, is_active')
          .single()
        if (result.error || !result.data) {
          throw new Error(result.error?.message || 'Could not add employee.')
        }
        employee = { ...result.data, calendar_color: DEFAULT_COLOR }
      }

      const hours = new Map(schedule.hours.map((day) => [day.day, day]))
      const schedules = DAYS.map((day, dayOfWeek) => {
        const businessDay = hours.get(day)
        const isWorking =
          schedule.mode === '24/7' || Boolean(businessDay?.open)
        return {
          dayOfWeek,
          isWorking,
          startTime: isWorking
            ? schedule.mode === '24/7'
              ? '00:00'
              : businessDay?.start || '09:00'
            : null,
          endTime: isWorking
            ? schedule.mode === '24/7'
              ? '23:59'
              : businessDay?.end || '17:00'
            : null,
        }
      })

      let syncNote = ''
      try {
        await syncEmployeeScheduleWithRetell({
          employeeId: employee.id,
          schedules,
        })
      } catch (syncError) {
        syncNote =
          syncError instanceof Error
            ? ` AI sync needs attention: ${syncError.message}`
            : ' AI sync needs attention.'
      }

      setEmployees((current) => [
        ...current.filter((item) => item.id !== employee.id),
        employee,
      ])
      updateForm('employeeId', employee.id)
      setStaffDraft('')
      setMessage(`${employee.name} was added.${syncNote}`)
    } catch (staffError) {
      setError(
        staffError instanceof Error ? staffError.message : 'Could not add employee.'
      )
    } finally {
      setAddingStaff(false)
    }
  }

  const changeEmployeeColor = async (employeeId: string, color: string) => {
    const nextColor = colorValue(color)
    setEmployees((current) =>
      current.map((employee) =>
        employee.id === employeeId
          ? { ...employee, calendar_color: nextColor }
          : employee
      )
    )
    window.localStorage.setItem(
      `recepta-employee-color:${employeeId}`,
      nextColor
    )

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    const { error: colorError } = await supabase
      .from('employees')
      .update({
        calendar_color: nextColor,
        updated_at: new Date().toISOString(),
      })
      .eq('id', employeeId)
      .eq('client_id', user.id)
    if (!colorError) {
      window.localStorage.removeItem(`recepta-employee-color:${employeeId}`)
    }
  }

  const saveOverlapLimit = async () => {
    const limit = Math.max(0, Math.min(10, Math.round(overlapLimit || 0)))
    setOverlapLimit(limit)
    setSavingOverlap(true)
    setError('')

    try {
      const { error: updateError } = await supabase.auth.updateUser({
        data: { appointment_overlap_limit: limit },
      })
      if (updateError) throw updateError
      setMessage(
        limit === 0
          ? 'Overlapping appointments are disabled.'
          : `${limit} additional overlap${limit === 1 ? '' : 's'} allowed per employee.`
      )
    } catch (overlapError) {
      setError(
        overlapError instanceof Error
          ? overlapError.message
          : 'Could not save overlap setting.'
      )
    } finally {
      setSavingOverlap(false)
    }
  }

  const openComposer = (date = localDate()) => {
    if (!form.employeeId) {
      setError('Add or select an employee before creating an appointment.')
      return
    }
    setForm(initialForm(form.employeeId, date))
    setDetailDraft('')
    setFormError('')
    setComposerOpen(true)
  }

  const addDetail = () => {
    const value = detailDraft.trim()
    if (!value) return
    setForm((current) => ({
      ...current,
      customFields: [
        ...current.customFields,
        { id: crypto.randomUUID(), value },
      ],
    }))
    setDetailDraft('')
  }

  const submitEntry = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setFormError('')

    try {
      const details = form.customFields
        .map((field) => field.value.trim())
        .filter(Boolean)
        .join('\n')
      const body = await requestCalendar('/.netlify/functions/calendar', {
        method: 'POST',
        body: JSON.stringify({
          kind: form.kind,
          employeeId: form.employeeId,
          date: form.date,
          time: form.time,
          durationMinutes: Number(form.durationMinutes),
          customerName: form.customerName,
          customerPhone: form.customerPhone,
          customerEmail: null,
          companyName: null,
          service: 'Appointment',
          notes: details || null,
          internalNotes: null,
          title: form.blockTitle || 'Blocked time',
          details: details || null,
          blockType: 'unavailable',
        }),
      })

      setComposerOpen(false)
      setMessage(
        form.kind === 'block'
          ? 'Time blocked. The AI agent will not offer this slot.'
          : body.confirmationEmailSent
            ? 'Appointment added and confirmation emails sent.'
            : `Appointment added and available to the AI agent. ${body.confirmationWarning || ''}`.trim()
      )
      setMonth(monthStart(form.date))
      await loadCalendar()
    } catch (submitError) {
      setFormError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not add this calendar entry.'
      )
    } finally {
      setSaving(false)
    }
  }

  const deleteBlock = async (id: string) => {
    if (!window.confirm('Remove this blocked time?')) return
    try {
      await requestCalendar(
        `/.netlify/functions/calendar?kind=block&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      )
      setBlocks((current) => current.filter((block) => block.id !== id))
      setViewItem(null)
      setMessage('Blocked time removed.')
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Could not remove blocked time.'
      )
    }
  }

  const monthLabel = parseDate(month).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
  })

  return (
    <main className="dashboardPage calendarResponsivePage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>
        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">Overview</a>
          <a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
          <a href="/dashboard/calendar" className="dashboardNavItem dashboardNavItemActive">Calendar</a>
          <a href="/dashboard/agent" className="dashboardNavItem">Agent</a>
          <a href="/dashboard/billing" className="dashboardNavItem">Billing</a>
          <a href="/dashboard/settings" className="dashboardNavItem">Settings</a>
        </nav>
      </aside>

      <section className="dashboardMain calendarResponsiveMain">
        <header className="calendarSketchHeader">
          <div>
            <p className="dashboardEyebrow">CALENDAR</p>
            <h1>Appointments</h1>
            <p>Manage employees, bookings and availability in one place.</p>
          </div>
          <button className="btn btnPrimary" type="button" onClick={() => openComposer()}>
            + Add appointment
          </button>
        </header>

        {error && <div className="calendarAlert calendarAlert--error">{error}</div>}
        {message && <div className="calendarAlert">{message}</div>}

        <section className="calendarSketchCard calendarOverlapCard">
          <div>
            <span className="appointmentSectionLabel">BOOKING RULE</span>
            <h2>Amount of appointment overlaps allowed</h2>
            <p>Use 0 to prevent double-booking. Each number allows one additional appointment at the same time for one employee.</p>
          </div>
          <label>
            <span>Overlap amount</span>
            <input
              type="number"
              min="0"
              max="10"
              step="1"
              value={overlapLimit}
              onChange={(event) => setOverlapLimit(Number(event.target.value))}
              onBlur={() => void saveOverlapLimit()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
            <small>
              {savingOverlap
                ? 'Saving...'
                : 'Saved automatically and used by the AI agent'}
            </small>
          </label>
        </section>

        <section className="calendarSketchCard calendarEmployeesCard">
          <div className="calendarCardHeading">
            <div>
              <span className="appointmentSectionLabel">EMPLOYEE</span>
              <h2>Add an employee</h2>
            </div>
            <span>{activeEmployees.length} active</span>
          </div>

          <div className="calendarEmployeeComposer">
            <input
              value={staffDraft}
              onChange={(event) => setStaffDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void addOrSelectStaff()
                }
              }}
              placeholder="Employee name"
              aria-label="Employee name"
            />
            <button
              type="button"
              className="btn btnOutline"
              disabled={addingStaff || !staffDraft.trim()}
              onClick={() => void addOrSelectStaff()}
            >
              {addingStaff ? 'Adding...' : '+ Add'}
            </button>
          </div>

          <div className="calendarEmployeeList">
            {activeEmployees.map((employee) => {
              const color = colorValue(employee.calendar_color)
              const selected = employee.id === form.employeeId
              return (
                <div
                  key={employee.id}
                  className={selected ? 'calendarEmployeeChip selected' : 'calendarEmployeeChip'}
                >
                  <button
                    type="button"
                    onClick={() => updateForm('employeeId', employee.id)}
                  >
                    <i style={{ backgroundColor: color }} />
                    <span>{employee.name}</span>
                    {selected && <small>Selected</small>}
                  </button>
                  <label title={`Change ${employee.name}'s calendar cube color`}>
                    <input
                      type="color"
                      value={color}
                      onChange={(event) =>
                        void changeEmployeeColor(employee.id, event.target.value)
                      }
                      aria-label={`Change ${employee.name}'s calendar color`}
                    />
                  </label>
                </div>
              )
            })}
            {!loading && !activeEmployees.length && (
              <p className="calendarEmptyEmployees">Type a name above and click Add.</p>
            )}
          </div>
        </section>

        <section className="calendarSketchCard calendarMonthCard">
          <div className="calendarMonthHeading">
            <div>
              <span className="appointmentSectionLabel">MONTH CALENDAR</span>
              <h2>{monthLabel}</h2>
              <p>Click a date to add an appointment for the selected employee.</p>
            </div>
            <div className="calendarMonthControls">
              <button type="button" className="btn btnOutline" onClick={() => setMonth(changeMonth(month, -1))}>Previous</button>
              <button type="button" className="btn btnOutline" onClick={() => setMonth(monthStart())}>Today</button>
              <button type="button" className="btn btnOutline" onClick={() => setMonth(changeMonth(month, 1))}>Next</button>
            </div>
          </div>

          <div className="calendarWeekdayRow">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          {loading ? (
            <div className="calendarMonthLoading">Loading calendar...</div>
          ) : (
            <div className="calendarMonthGrid">
              {gridDays.map((date) => {
                const items = itemsByDate.get(date) || []
                const outside = date.slice(0, 7) !== month.slice(0, 7)
                const today = date === localDate()
                return (
                  <button
                    type="button"
                    key={date}
                    className={`calendarMonthDay${outside ? ' outside' : ''}${today ? ' today' : ''}`}
                    onClick={() => openComposer(date)}
                  >
                    <span className="calendarDayNumber">{parseDate(date).getDate()}</span>
                    <span className="calendarDayItems">
                      {items.slice(0, 3).map((item) => (
                        <span
                          key={`${item.kind}-${item.id}`}
                          className={`calendarEventCube ${item.kind === 'block' ? 'blocked' : ''}`}
                          style={{
                            backgroundColor: item.color,
                            color: textColor(item.color),
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            setViewItem(item)
                          }}
                        >
                          <b>{item.time}</b>
                          <em>{item.title}</em>
                        </span>
                      ))}
                      {items.length > 3 && <small>+{items.length - 3} more</small>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </section>

      {composerOpen && (
        <div className="calendarModalBackdrop" onMouseDown={() => setComposerOpen(false)}>
          <section
            className="calendarModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="calendarModalHeader">
              <div>
                <span className="appointmentSectionLabel">APPOINTMENT DETAILS</span>
                <h2 id="calendar-modal-title">
                  {form.kind === 'appointment' ? 'Add appointment' : 'Block time'}
                </h2>
                <p>{selectedEmployee?.name || 'Select an employee'}</p>
              </div>
              <button type="button" onClick={() => setComposerOpen(false)} aria-label="Close">×</button>
            </div>

            <div className="calendarModalTabs">
              <button type="button" className={form.kind === 'appointment' ? 'active' : ''} onClick={() => updateForm('kind', 'appointment')}>Appointment</button>
              <button type="button" className={form.kind === 'block' ? 'active' : ''} onClick={() => updateForm('kind', 'block')}>Block time</button>
            </div>

            <form onSubmit={submitEntry} className="calendarModalForm">
              <div className="calendarModalGrid">
                <label>
                  <span>Date *</span>
                  <input type="date" required value={form.date} onChange={(event) => updateForm('date', event.target.value)} />
                </label>
                <label>
                  <span>Start time *</span>
                  <input type="time" required value={form.time} onChange={(event) => updateForm('time', event.target.value)} />
                </label>
                <label>
                  <span>Length *</span>
                  <select value={form.durationMinutes} onChange={(event) => updateForm('durationMinutes', event.target.value)}>
                    {[15, 30, 45, 60, 90, 120, 180, 240].map((duration) => (
                      <option key={duration} value={duration}>{duration} minutes</option>
                    ))}
                  </select>
                </label>
                <label className="calendarModalColor">
                  <span>Calendar cube color</span>
                  <input
                    type="color"
                    value={colorValue(selectedEmployee?.calendar_color)}
                    onChange={(event) =>
                      form.employeeId &&
                      void changeEmployeeColor(form.employeeId, event.target.value)
                    }
                  />
                </label>
              </div>

              {form.kind === 'appointment' ? (
                <div className="calendarModalGrid two">
                  <label>
                    <span>Name *</span>
                    <input required value={form.customerName} onChange={(event) => updateForm('customerName', event.target.value)} placeholder="Customer name" />
                  </label>
                  <label>
                    <span>Phone number</span>
                    <input value={form.customerPhone} onChange={(event) => updateForm('customerPhone', event.target.value)} placeholder="+1 416 555 0123" />
                  </label>
                </div>
              ) : (
                <label className="calendarModalFullField">
                  <span>Block label *</span>
                  <input required value={form.blockTitle} onChange={(event) => updateForm('blockTitle', event.target.value)} placeholder="Lunch, unavailable, meeting..." />
                </label>
              )}

              <div className="calendarModalExtras">
                <div>
                  <strong>Additional appointment details</strong>
                  <span>Type one detail and click Add.</span>
                </div>
                <div className="calendarAdditionalFieldComposer">
                  <input
                    value={detailDraft}
                    onChange={(event) => setDetailDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addDetail()
                      }
                    }}
                    placeholder="Appointment detail"
                  />
                  <button type="button" className="btn btnOutline" onClick={addDetail} disabled={!detailDraft.trim()}>+ Add field</button>
                </div>
                {form.customFields.map((field) => (
                  <div className="calendarAddedField" key={field.id}>
                    <span>{field.value}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          customFields: current.customFields.filter(
                            (item) => item.id !== field.id
                          ),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              {formError && <div className="calendarAlert calendarAlert--error">{formError}</div>}
              <div className="calendarModalActions">
                <button type="button" className="btn btnOutline" onClick={() => setComposerOpen(false)}>Cancel</button>
                <button type="submit" className="btn btnPrimary" disabled={saving}>
                  {saving ? 'Saving...' : form.kind === 'appointment' ? 'Add to calendar' : 'Block time'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {viewItem && (
        <div className="calendarModalBackdrop" onMouseDown={() => setViewItem(null)}>
          <section
            className="calendarModal calendarDetailsModal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="calendarModalHeader">
              <div>
                <span className="appointmentSectionLabel">
                  {viewItem.kind === 'block' ? 'BLOCKED TIME' : 'APPOINTMENT DETAILS'}
                </span>
                <h2>{viewItem.title}</h2>
              </div>
              <button type="button" onClick={() => setViewItem(null)} aria-label="Close">×</button>
            </div>
            <dl className="calendarDetailsList">
              <div><dt>Employee</dt><dd><i style={{ backgroundColor: viewItem.color }} />{viewItem.employeeName}</dd></div>
              <div><dt>Date</dt><dd>{parseDate(viewItem.date).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</dd></div>
              <div><dt>Time</dt><dd>{viewItem.time}</dd></div>
              {viewItem.detail && <div><dt>Details</dt><dd>{viewItem.detail}</dd></div>}
            </dl>
            <div className="calendarModalActions">
              {viewItem.kind === 'block' && (
                <button type="button" className="btn btnDanger" onClick={() => void deleteBlock(viewItem.id)}>Remove block</button>
              )}
              <button type="button" className="btn btnPrimary" onClick={() => setViewItem(null)}>Done</button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
