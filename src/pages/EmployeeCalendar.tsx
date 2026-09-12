import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

type AppointmentStatus = 'booked' | 'cancelled' | 'completed'
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
  status: AppointmentStatus
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

type CalendarResponse = {
  calendar?: {
    date: string
    endDate: string
    timeZone: string
    employees: Employee[]
    appointments: Appointment[]
    blocks: CalendarBlock[]
    warning?: string | null
  }
  appointment?: Appointment
  block?: CalendarBlock
  confirmationEmailSent?: boolean
  confirmationWarning?: string | null
  error?: string
}

type CustomField = {
  id: string
  label: string
  value: string
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
  customFields: CustomField[]
}

type TimetableEntry = {
  id: string
  kind: EntryKind
  employeeId: string
  employeeName: string
  color: string
  date: string
  startMinutes: number
  endMinutes: number
  title: string
  detail: string
}

const DEFAULT_COLOR = '#00e676'
const SLOT_MINUTES = 30
const TOTAL_SLOTS = (24 * 60) / SLOT_MINUTES

const getLocalDate = () => {
  const now = new Date()

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

const parseDateValue = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

const formatDateValue = (date: Date) =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')

const addDays = (value: string, amount: number) => {
  const date = parseDateValue(value)
  date.setDate(date.getDate() + amount)
  return formatDateValue(date)
}

const getWeekStart = (value: string) => {
  const date = parseDateValue(value)
  const distanceFromMonday = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - distanceFromMonday)
  return formatDateValue(date)
}

const getInitialForm = (): FormState => ({
  kind: 'appointment',
  employeeId: '',
  date: getLocalDate(),
  time: '09:00',
  durationMinutes: '30',
  customerName: '',
  customerPhone: '',
  blockTitle: '',
  customFields: [],
})

const makeCustomField = (): CustomField => ({
  id: crypto.randomUUID(),
  label: '',
  value: '',
})

const normalizeColor = (value: string | null | undefined) =>
  /^#[0-9a-f]{6}$/i.test(value || '') ? value! : DEFAULT_COLOR

const textColorFor = (color: string) => {
  const normalized = normalizeColor(color).slice(1)
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000

  return luminance > 150 ? '#041108' : '#ffffff'
}

const minutesToTime = (minutes: number) => {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(getLocalDate()))
  const [timeZone, setTimeZone] = useState('America/Toronto')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [blocks, setBlocks] = useState<CalendarBlock[]>([])
  const [form, setForm] = useState<FormState>(getInitialForm)
  const [colorOverride, setColorOverride] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const timetableScrollerRef = useRef<HTMLDivElement | null>(null)

  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart]
  )
  const weekEnd = weekDays[6]

  const requestCalendar = useCallback(
    async (
      path: string,
      init?: RequestInit
    ): Promise<CalendarResponse> => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error('Please sign in again.')
      }

      const response = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
      const responseText = await response.text()
      let body: CalendarResponse = {}

      try {
        body = responseText ? (JSON.parse(responseText) as CalendarResponse) : {}
      } catch {
        throw new Error(
          response.ok
            ? 'The calendar returned an invalid response.'
            : 'The calendar server could not complete the request.'
        )
      }

      if (!response.ok) {
        throw new Error(body.error || 'The calendar request failed.')
      }

      return body
    },
    []
  )

  const loadCalendar = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      const body = await requestCalendar(
        `/.netlify/functions/calendar?start=${encodeURIComponent(
          weekStart
        )}&end=${encodeURIComponent(weekEnd)}`
      )
      const calendar = body.calendar

      if (!calendar) {
        throw new Error('The calendar response was incomplete.')
      }

      setTimeZone(calendar.timeZone)
      setEmployees(calendar.employees)
      setAppointments(calendar.appointments)
      setBlocks(calendar.blocks)
      setError(calendar.warning || '')

      const activeEmployees = calendar.employees.filter(
        (employee) => employee.is_active
      )
      const firstEmployee = activeEmployees[0]

      setForm((current) => {
        const selected = activeEmployees.find(
          (employee) => employee.id === current.employeeId
        )
        const nextEmployee = selected || firstEmployee

        return {
          ...current,
          employeeId: nextEmployee?.id || '',
        }
      })
    } catch (loadError) {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      const { data: fallbackEmployees } = user
        ? await supabase
            .from('employees')
            .select('id, name, role, email, is_active')
            .eq('client_id', user.id)
            .order('created_at', { ascending: true })
        : { data: [] }
      const restoredEmployees = (fallbackEmployees ?? []).map((employee) => ({
        ...employee,
        calendar_color: window.localStorage.getItem(
          `recepta-employee-color:${employee.id}`
        ),
      })) as Employee[]

      setEmployees(restoredEmployees)
      setAppointments([])
      setBlocks([])

      const firstEmployee = restoredEmployees.find(
        (employee) => employee.is_active
      )

      setForm((current) => ({
        ...current,
        employeeId:
          restoredEmployees.some(
            (employee) =>
              employee.is_active && employee.id === current.employeeId
          )
            ? current.employeeId
            : firstEmployee?.id || '',
      }))
      setError(
        restoredEmployees.length > 0
          ? 'Your staff calendars are available, but the calendar database setup is incomplete. Run supabase_add_employee_calendar.sql in Supabase before adding appointments or blocked time.'
          : loadError instanceof Error
            ? loadError.message
            : 'Could not load the appointment calendar.'
      )
    } finally {
      setLoading(false)
    }
  }, [requestCalendar, weekEnd, weekStart])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCalendar()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadCalendar])

  useEffect(() => {
    if (loading) return

    const timer = window.setTimeout(() => {
      if (timetableScrollerRef.current) {
        timetableScrollerRef.current.scrollTop =
          (8 * 60 * 34) / SLOT_MINUTES
      }
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loading, weekStart])

  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees]
  )
  const selectedEmployee = employeeById.get(form.employeeId)
  const employeeColor =
    colorOverride ?? normalizeColor(selectedEmployee?.calendar_color)

  const calendarDateFor = useCallback(
    (value: string) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(value))
      const part = (type: string) =>
        parts.find((item) => item.type === type)?.value || ''

      return `${part('year')}-${part('month')}-${part('day')}`
    },
    [timeZone]
  )

  const calendarMinutesFor = useCallback(
    (value: string) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(value))
      const part = (type: string) =>
        parts.find((item) => item.type === type)?.value || '00'

      return Number(part('hour')) * 60 + Number(part('minute'))
    },
    [timeZone]
  )

  const timetableEntries = useMemo(() => {
    const appointmentEntries: TimetableEntry[] = appointments
      .filter((appointment) => appointment.status === 'booked')
      .map((appointment) => {
        const employee = appointment.employee_id
          ? employeeById.get(appointment.employee_id)
          : null
        const date = calendarDateFor(appointment.appointment_time)
        const endDate = appointment.appointment_end_time
          ? calendarDateFor(appointment.appointment_end_time)
          : date
        const startMinutes = calendarMinutesFor(appointment.appointment_time)
        const calculatedEnd = appointment.appointment_end_time
          ? calendarMinutesFor(appointment.appointment_end_time)
          : startMinutes + Math.max(appointment.duration_minutes || 30, 5)

        return {
          id: appointment.id,
          kind: 'appointment',
          employeeId: appointment.employee_id || '',
          employeeName: employee?.name || 'Unassigned',
          color: normalizeColor(employee?.calendar_color),
          date,
          startMinutes,
          endMinutes: endDate === date ? calculatedEnd : 1440,
          title: appointment.customer_name || 'Appointment',
          detail: [
            appointment.customer_phone,
            appointment.service,
            appointment.notes,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      })

    const blockEntries: TimetableEntry[] = blocks.map((block) => {
      const employee = employeeById.get(block.employee_id)
      const date = calendarDateFor(block.starts_at)
      const endDate = calendarDateFor(block.ends_at)
      const startMinutes = calendarMinutesFor(block.starts_at)
      const calculatedEnd = calendarMinutesFor(block.ends_at)

      return {
        id: block.id,
        kind: 'block',
        employeeId: block.employee_id,
        employeeName: employee?.name || 'Unassigned',
        color: normalizeColor(employee?.calendar_color),
        date,
        startMinutes,
        endMinutes: endDate === date ? calculatedEnd : 1440,
        title: block.title,
        detail: block.details || 'Unavailable',
      }
    })

    return [...appointmentEntries, ...blockEntries]
  }, [
    appointments,
    blocks,
    calendarDateFor,
    calendarMinutesFor,
    employeeById,
  ])

  const updateForm = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key]
  ) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const updateCustomField = (
    id: string,
    key: 'label' | 'value',
    value: string
  ) => {
    setForm((current) => ({
      ...current,
      customFields: current.customFields.map((field) =>
        field.id === id ? { ...field, [key]: value } : field
      ),
    }))
  }

  const addCustomField = () => {
    setForm((current) => ({
      ...current,
      customFields: [...current.customFields, makeCustomField()],
    }))
  }

  const removeCustomField = (id: string) => {
    setForm((current) => ({
      ...current,
      customFields: current.customFields.filter((field) => field.id !== id),
    }))
  }

  const saveEmployeeColor = async () => {
    if (
      !selectedEmployee ||
      normalizeColor(selectedEmployee.calendar_color) === employeeColor
    ) {
      return
    }

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) throw new Error('Please sign in again.')

    const { error: colorError } = await supabase
      .from('employees')
      .update({
        calendar_color: employeeColor,
        updated_at: new Date().toISOString(),
      })
      .eq('id', selectedEmployee.id)
      .eq('client_id', user.id)

    if (colorError) {
      window.localStorage.setItem(
        `recepta-employee-color:${selectedEmployee.id}`,
        employeeColor
      )
    } else {
      window.localStorage.removeItem(
        `recepta-employee-color:${selectedEmployee.id}`
      )
    }

    setEmployees((current) =>
      current.map((employee) =>
        employee.id === selectedEmployee.id
          ? { ...employee, calendar_color: employeeColor }
          : employee
      )
    )
    setColorOverride(null)
  }

  const submitCalendarEntry = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')

    try {
      if (!form.employeeId) {
        throw new Error('Choose a staff member.')
      }

      const customDetails = form.customFields
        .map((field) => ({
          label: field.label.trim(),
          value: field.value.trim(),
        }))
        .filter((field) => field.label || field.value)
        .map((field) => `${field.label || 'Detail'}: ${field.value || 'Not provided'}`)
        .join('\n')

      await saveEmployeeColor()

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
          notes: customDetails || null,
          internalNotes: null,
          title: form.blockTitle || 'Blocked time',
          details: customDetails || null,
          blockType: 'unavailable',
        }),
      })

      if (form.kind === 'appointment') {
        setMessage(
          body.confirmationEmailSent
            ? 'Appointment added. Confirmation emails were sent.'
            : `Appointment added to the calendar. ${
                body.confirmationWarning || ''
              }`.trim()
        )
      } else {
        setMessage('The selected time is now blocked on the calendar.')
      }

      const nextWeekStart = getWeekStart(form.date)
      setForm((current) => ({
        ...getInitialForm(),
        employeeId: current.employeeId,
        date: current.date,
        kind: current.kind,
      }))

      if (nextWeekStart === weekStart) {
        await loadCalendar()
      } else {
        setWeekStart(nextWeekStart)
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not add this time to the calendar.'
      )
    } finally {
      setSaving(false)
    }
  }

  const deleteBlock = async (id: string) => {
    if (!window.confirm('Remove this blocked time?')) return

    setError('')

    try {
      await requestCalendar(
        `/.netlify/functions/calendar?kind=block&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      )
      setBlocks((current) => current.filter((block) => block.id !== id))
      setMessage('Blocked time removed.')
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Could not remove the blocked time.'
      )
    }
  }

  const selectDate = (date: string) => {
    updateForm('date', date)
    document
      .getElementById('employee-calendar-form')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const displayWeek = `${parseDateValue(weekStart).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })} – ${parseDateValue(weekEnd).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`

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
          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>
          <a
            href="/dashboard/calendar"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Calendar
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
        <div className="dashboardHeader appointmentPageHeader">
          <div>
            <p className="dashboardEyebrow">CALENDAR</p>
            <h1>Appointment Calendar</h1>
            <p>
              View every booked appointment in one timetable or reserve a time
              slot directly. Retell uses this same calendar when booking calls.
            </p>
          </div>
        </div>

        {error && <div className="calendarAlert calendarAlert--error">{error}</div>}
        {message && <div className="calendarAlert">{message}</div>}

        <section
          className="employeeAppointmentComposer"
          id="employee-calendar-form"
        >
          <div className="employeeTimetableSectionHeading">
            <div>
              <span className="appointmentSectionLabel">BOOK A TIME</span>
              <h2>
                {form.kind === 'appointment'
                  ? 'Add appointment'
                  : 'Block employee time'}
              </h2>
            </div>

            <div className="calendarSegmentedControl">
              <button
                type="button"
                className={form.kind === 'appointment' ? 'active' : ''}
                onClick={() => updateForm('kind', 'appointment')}
              >
                Appointment
              </button>
              <button
                type="button"
                className={form.kind === 'block' ? 'active' : ''}
                onClick={() => updateForm('kind', 'block')}
              >
                Block time
              </button>
            </div>
          </div>

          <form className="employeeQuickAppointmentForm" onSubmit={submitCalendarEntry}>
            <div className="employeeQuickFormGrid">
              <label>
                <span>Staff member *</span>
                <select
                  required
                  value={form.employeeId}
                  onChange={(event) => {
                    updateForm('employeeId', event.target.value)
                    setColorOverride(null)
                  }}
                >
                  <option value="">Choose staff member</option>
                  {employees
                    .filter((employee) => employee.is_active)
                    .map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name}
                        {employee.role ? ` — ${employee.role}` : ''}
                      </option>
                    ))}
                </select>
              </label>

              <label>
                <span>Date *</span>
                <input
                  type="date"
                  required
                  value={form.date}
                  onChange={(event) => updateForm('date', event.target.value)}
                />
              </label>

              <label>
                <span>Start time *</span>
                <input
                  type="time"
                  required
                  value={form.time}
                  onChange={(event) => updateForm('time', event.target.value)}
                />
              </label>

              <label>
                <span>Length *</span>
                <select
                  value={form.durationMinutes}
                  onChange={(event) =>
                    updateForm('durationMinutes', event.target.value)
                  }
                >
                  {[15, 30, 45, 60, 90, 120, 180, 240].map((duration) => (
                    <option key={duration} value={duration}>
                      {duration} minutes
                    </option>
                  ))}
                </select>
              </label>

              <label className="employeeColorField">
                <span>Calendar color</span>
                <div>
                  <input
                    type="color"
                    value={employeeColor}
                    onChange={(event) => setColorOverride(event.target.value)}
                    aria-label="Choose employee calendar color"
                  />
                  <strong>{employeeColor.toUpperCase()}</strong>
                </div>
              </label>
            </div>

            {form.kind === 'appointment' ? (
              <div className="employeeQuickFormGrid employeeQuickFormGrid--customer">
                <label>
                  <span>Name *</span>
                  <input
                    required
                    value={form.customerName}
                    onChange={(event) =>
                      updateForm('customerName', event.target.value)
                    }
                    placeholder="Customer name"
                  />
                </label>

                <label>
                  <span>Phone number</span>
                  <input
                    value={form.customerPhone}
                    onChange={(event) =>
                      updateForm('customerPhone', event.target.value)
                    }
                    placeholder="+1 416 555 0123"
                  />
                </label>
              </div>
            ) : (
              <label className="calendarFullField">
                <span>Block label *</span>
                <input
                  required
                  value={form.blockTitle}
                  onChange={(event) =>
                    updateForm('blockTitle', event.target.value)
                  }
                  placeholder="Lunch, unavailable, meeting..."
                />
              </label>
            )}

            <div className="employeeCustomFields">
              <div className="employeeCustomFieldsHeading">
                <div>
                  <strong>Additional fields</strong>
                  <span>Add any extra information needed for this entry.</span>
                </div>
                <button
                  type="button"
                  className="btn btnOutline"
                  onClick={addCustomField}
                >
                  + Add field
                </button>
              </div>

              {form.customFields.map((field) => (
                <div className="employeeCustomFieldRow" key={field.id}>
                  <input
                    value={field.label}
                    onChange={(event) =>
                      updateCustomField(field.id, 'label', event.target.value)
                    }
                    placeholder="Field name"
                    aria-label="Additional field name"
                  />
                  <input
                    value={field.value}
                    onChange={(event) =>
                      updateCustomField(field.id, 'value', event.target.value)
                    }
                    placeholder="Value"
                    aria-label="Additional field value"
                  />
                  <button
                    type="button"
                    onClick={() => removeCustomField(field.id)}
                    aria-label="Remove additional field"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <button
              type="submit"
              className="btn btnPrimary employeeAddCalendarButton"
              disabled={saving || !form.employeeId}
            >
              {saving
                ? 'Saving...'
                : form.kind === 'appointment'
                  ? 'Add Appointment to Calendar'
                  : 'Block This Time'}
            </button>
          </form>
        </section>

        <section className="employeeWeeklyTimetable">
          <div className="employeeTimetableSectionHeading">
            <div>
              <span className="appointmentSectionLabel">WEEKLY CALENDAR</span>
              <h2>{displayWeek}</h2>
              <p>
                Each staff member has their own color. Select a date heading to
                add a new appointment or blocked time for that day.
              </p>
            </div>

            <div className="appointmentMonthControls">
              <button
                type="button"
                className="btn btnOutline"
                onClick={() => setWeekStart(addDays(weekStart, -7))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btnOutline"
                onClick={() => setWeekStart(getWeekStart(getLocalDate()))}
              >
                Today
              </button>
              <button
                type="button"
                className="btn btnOutline"
                onClick={() => setWeekStart(addDays(weekStart, 7))}
              >
                Next
              </button>
            </div>
          </div>

          <div className="employeeColorLegend">
            {employees
              .filter((employee) => employee.is_active)
              .map((employee) => (
                <span key={employee.id}>
                  <i
                    style={{
                      backgroundColor: normalizeColor(employee.calendar_color),
                    }}
                  />
                  {employee.name}
                </span>
              ))}
          </div>

          {loading ? (
            <div className="appointmentInnerEmpty">
              <strong>Loading appointment calendar...</strong>
            </div>
          ) : employees.filter((employee) => employee.is_active).length === 0 ? (
            <div className="appointmentInnerEmpty">
              <strong>No booking calendars are configured</strong>
              <p>Contact Recepta to configure a staff calendar for bookings.</p>
            </div>
          ) : (
            <div
              className="employeeTimetableScroller"
              ref={timetableScrollerRef}
            >
              <div className="employeeTimetableHeader">
                <div className="employeeTimetableCorner">TIME</div>
                {weekDays.map((date) => {
                  const parsed = parseDateValue(date)
                  const isToday = date === getLocalDate()

                  return (
                    <button
                      type="button"
                      key={date}
                      className={
                        isToday
                          ? 'employeeTimetableDay employeeTimetableDay--today'
                          : 'employeeTimetableDay'
                      }
                      onClick={() => selectDate(date)}
                    >
                      <span>
                        {parsed.toLocaleDateString([], { weekday: 'short' })}
                      </span>
                      <strong>{parsed.getDate()}</strong>
                    </button>
                  )
                })}
              </div>

              <div
                className="employeeTimetableGrid"
                style={{
                  gridTemplateRows: `repeat(${TOTAL_SLOTS}, 34px)`,
                }}
              >
                {Array.from({ length: TOTAL_SLOTS }, (_, slotIndex) => {
                  const minutes = slotIndex * SLOT_MINUTES

                  return (
                    <div
                      key={`time-${minutes}`}
                      className="employeeTimetableTime"
                      style={{
                        gridColumn: 1,
                        gridRow: slotIndex + 1,
                      }}
                    >
                      {minutes % 60 === 0 ? minutesToTime(minutes) : ''}
                    </div>
                  )
                })}

                {weekDays.flatMap((date, dayIndex) =>
                  Array.from({ length: TOTAL_SLOTS }, (_, slotIndex) => (
                    <button
                      type="button"
                      aria-label={`Add entry on ${date} at ${minutesToTime(
                        slotIndex * SLOT_MINUTES
                      )}`}
                      key={`${date}-${slotIndex}`}
                      className="employeeTimetableCell"
                      style={{
                        gridColumn: dayIndex + 2,
                        gridRow: slotIndex + 1,
                      }}
                      onClick={() => {
                        updateForm('date', date)
                        updateForm('time', minutesToTime(slotIndex * SLOT_MINUTES))
                      }}
                    />
                  ))
                )}

                {timetableEntries.map((entry) => {
                  const dayIndex = weekDays.indexOf(entry.date)

                  if (dayIndex < 0) return null

                  const rowStart =
                    Math.floor(entry.startMinutes / SLOT_MINUTES) + 1
                  const rowEnd = Math.max(
                    rowStart + 1,
                    Math.ceil(entry.endMinutes / SLOT_MINUTES) + 1
                  )

                  return (
                    <article
                      key={`${entry.kind}-${entry.id}`}
                      className={`employeeTimetableEntry employeeTimetableEntry--${entry.kind}`}
                      style={{
                        gridColumn: dayIndex + 2,
                        gridRow: `${rowStart} / ${Math.min(
                          rowEnd,
                          TOTAL_SLOTS + 1
                        )}`,
                        backgroundColor: entry.color,
                        color: textColorFor(entry.color),
                      }}
                      title={`${entry.employeeName} · ${entry.title} · ${entry.detail}`}
                    >
                      <span>
                        {minutesToTime(entry.startMinutes)} · {entry.employeeName}
                      </span>
                      <strong>{entry.title}</strong>
                      {entry.detail && <small>{entry.detail}</small>}
                      {entry.kind === 'block' && (
                        <button
                          type="button"
                          onClick={() => void deleteBlock(entry.id)}
                        >
                          Remove
                        </button>
                      )}
                    </article>
                  )
                })}
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
