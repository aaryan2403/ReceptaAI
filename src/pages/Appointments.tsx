import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type AppointmentStatus = 'booked' | 'cancelled' | 'completed'

type Employee = {
  id: string
  name: string
  role: string | null
  email: string | null
  is_active: boolean
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

type SavedContact = {
  id: string
  name: string
  email: string | null
  phone: string | null
  company_name: string | null
  notes: string | null
  created_at: string
}

type CalendarResponse = {
  calendar?: {
    date: string
    timeZone: string
    employees: Employee[]
    appointments: Appointment[]
    blocks: CalendarBlock[]
  }
  contacts?: SavedContact[]
  appointment?: Appointment
  block?: CalendarBlock
  contact?: SavedContact
  confirmationEmailSent?: boolean
  confirmationWarning?: string | null
  error?: string
}

type FormState = {
  kind: 'appointment' | 'block'
  employeeId: string
  time: string
  durationMinutes: string
  customerName: string
  customerEmail: string
  customerPhone: string
  companyName: string
  service: string
  notes: string
  internalNotes: string
  blockType: 'unavailable' | 'break' | 'meeting' | 'time_off'
  title: string
  details: string
}

const getLocalDate = () => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

const INITIAL_FORM: FormState = {
  kind: 'appointment',
  employeeId: '',
  time: '09:00',
  durationMinutes: '30',
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  companyName: '',
  service: '',
  notes: '',
  internalNotes: '',
  blockType: 'unavailable',
  title: '',
  details: '',
}

export default function Appointments() {
  const [selectedDate, setSelectedDate] = useState(getLocalDate)
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [blocks, setBlocks] = useState<CalendarBlock[]>([])
  const [contacts, setContacts] = useState<SavedContact[]>([])
  const [timeZone, setTimeZone] = useState('America/Toronto')
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [savedContactId, setSavedContactId] = useState('')
  const [contactForm, setContactForm] = useState({
    name: '',
    email: '',
    phone: '',
    companyName: '',
    notes: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingContact, setSavingContact] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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
      const body = (await response.json()) as CalendarResponse

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
        `/.netlify/functions/calendar?date=${encodeURIComponent(selectedDate)}`
      )
      const calendar = body.calendar

      if (!calendar) throw new Error('The calendar response was incomplete.')

      setEmployees(calendar.employees)
      setAppointments(calendar.appointments)
      setBlocks(calendar.blocks)
      setContacts(body.contacts ?? [])
      setTimeZone(calendar.timeZone)

      const activeEmployees = calendar.employees.filter(
        (employee) => employee.is_active
      )
      const firstEmployeeId = activeEmployees[0]?.id || ''

      setSelectedEmployeeId((current) =>
        activeEmployees.some((employee) => employee.id === current)
          ? current
          : firstEmployeeId
      )
      setForm((current) => ({
        ...current,
        employeeId: activeEmployees.some(
          (employee) => employee.id === current.employeeId
        )
          ? current.employeeId
          : firstEmployeeId,
      }))
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load the employee calendar.'
      )
    } finally {
      setLoading(false)
    }
  }, [requestCalendar, selectedDate])

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
  const filteredAppointments = useMemo(
    () =>
      appointments.filter(
        (appointment) =>
          !selectedEmployeeId || appointment.employee_id === selectedEmployeeId
      ),
    [appointments, selectedEmployeeId]
  )
  const filteredBlocks = useMemo(
    () =>
      blocks.filter(
        (block) =>
          !selectedEmployeeId || block.employee_id === selectedEmployeeId
      ),
    [blocks, selectedEmployeeId]
  )
  const agenda = useMemo(() => {
    const appointmentItems = filteredAppointments.map((appointment) => ({
      id: appointment.id,
      kind: 'appointment' as const,
      start: appointment.appointment_time,
      appointment,
    }))
    const blockItems = filteredBlocks.map((block) => ({
      id: block.id,
      kind: 'block' as const,
      start: block.starts_at,
      block,
    }))

    return [...appointmentItems, ...blockItems].sort((left, right) =>
      left.start.localeCompare(right.start)
    )
  }, [filteredAppointments, filteredBlocks])

  const updateForm = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key]
  ) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const selectSavedContact = (contactId: string) => {
    setSavedContactId(contactId)
    const contact = contacts.find((item) => item.id === contactId)

    if (!contact) return

    setForm((current) => ({
      ...current,
      customerName: contact.name,
      customerEmail: contact.email || '',
      customerPhone: contact.phone || '',
      companyName: contact.company_name || '',
      notes: contact.notes || current.notes,
    }))
  }

  const submitCalendarItem = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')

    try {
      const body = await requestCalendar('/.netlify/functions/calendar', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          date: selectedDate,
          durationMinutes: Number(form.durationMinutes),
        }),
      })

      if (form.kind === 'appointment') {
        setMessage(
          body.confirmationEmailSent
            ? 'Appointment booked. Confirmation emails were sent to the caller and business owner.'
            : `Appointment booked. ${
                body.confirmationWarning || 'Confirmation email was not sent.'
              }`
        )
      } else {
        setMessage('The employee’s calendar has been blocked for that time.')
      }

      setForm((current) => ({
        ...INITIAL_FORM,
        kind: current.kind,
        employeeId: current.employeeId,
      }))
      setSavedContactId('')
      await loadCalendar()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not save the calendar item.'
      )
    } finally {
      setSaving(false)
    }
  }

  const updateStatus = async (
    appointmentId: string,
    status: AppointmentStatus
  ) => {
    setUpdatingId(appointmentId)
    setError('')

    try {
      const body = await requestCalendar('/.netlify/functions/calendar', {
        method: 'PATCH',
        body: JSON.stringify({ id: appointmentId, status }),
      })

      if (body.appointment) {
        setAppointments((current) =>
          current.map((appointment) =>
            appointment.id === appointmentId ? body.appointment! : appointment
          )
        )
      }
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'Could not update the appointment.'
      )
    } finally {
      setUpdatingId(null)
    }
  }

  const deleteItem = async (kind: 'block' | 'contact', id: string) => {
    const label = kind === 'block' ? 'blocked time' : 'saved client'

    if (!window.confirm(`Delete this ${label}?`)) return

    setError('')

    try {
      await requestCalendar(
        `/.netlify/functions/calendar?kind=${kind}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      )

      if (kind === 'block') {
        setBlocks((current) => current.filter((block) => block.id !== id))
      } else {
        setContacts((current) => current.filter((contact) => contact.id !== id))
        if (savedContactId === id) setSavedContactId('')
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : `Could not delete the ${label}.`
      )
    }
  }

  const saveContact = async (event: React.FormEvent) => {
    event.preventDefault()
    setSavingContact(true)
    setError('')

    try {
      const body = await requestCalendar('/.netlify/functions/calendar', {
        method: 'POST',
        body: JSON.stringify({ kind: 'contact', ...contactForm }),
      })

      if (body.contact) {
        setContacts((current) =>
          [...current, body.contact!].sort((left, right) =>
            left.name.localeCompare(right.name)
          )
        )
      }

      setContactForm({
        name: '',
        email: '',
        phone: '',
        companyName: '',
        notes: '',
      })
      setMessage('Client saved to the optional appointment list.')
    } catch (contactError) {
      setError(
        contactError instanceof Error
          ? contactError.message
          : 'Could not save the client.'
      )
    } finally {
      setSavingContact(false)
    }
  }

  const formatTime = (value: string | null) => {
    if (!value) return 'Not assigned'

    return new Intl.DateTimeFormat([], {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value))
  }

  const formatSelectedDate = () => {
    const [year, month, day] = selectedDate.split('-').map(Number)

    return new Date(year, month - 1, day).toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
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
          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>
          <a
            href="/dashboard/appointments"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Appointments
          </a>
          <a href="/dashboard/employees" className="dashboardNavItem">
            Employees
          </a>
          <a href="/dashboard/agent" className="dashboardNavItem">
            Agent
          </a>
          <a href="/dashboard/requests" className="dashboardNavItem">
            Customer Requests
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
            <p className="dashboardEyebrow">EMPLOYEE CALENDAR</p>
            <h1>Appointments</h1>
            <p>
              Manage each employee’s live calendar. Retell checks this same
              calendar before booking callers.
            </p>
          </div>

          <div className="appointmentTimeZone">
            <span>BUSINESS TIMEZONE</span>
            <strong>{timeZone}</strong>
          </div>
        </div>

        {error && <div className="calendarAlert calendarAlert--error">{error}</div>}
        {message && <div className="calendarAlert">{message}</div>}

        <section className="appointmentDatePanel employeeCalendarPanel">
          <div className="appointmentDateHeader">
            <div>
              <span className="appointmentSectionLabel">CALENDAR DATE</span>
              <h2>{formatSelectedDate()}</h2>
              <p>Select an employee to see only their bookings and blocks.</p>
            </div>

            <input
              type="date"
              value={selectedDate}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="appointmentDatePicker"
            />
          </div>

          <div className="employeeCalendarTabs">
            {employees
              .filter((employee) => employee.is_active)
              .map((employee) => (
                <button
                  key={employee.id}
                  type="button"
                  className={
                    selectedEmployeeId === employee.id
                      ? 'employeeCalendarTab employeeCalendarTab--active'
                      : 'employeeCalendarTab'
                  }
                  onClick={() => {
                    setSelectedEmployeeId(employee.id)
                    updateForm('employeeId', employee.id)
                  }}
                >
                  <strong>{employee.name}</strong>
                  <span>{employee.role || 'Employee'}</span>
                </button>
              ))}
          </div>

          {loading ? (
            <div className="appointmentInnerEmpty">
              <strong>Loading calendar...</strong>
            </div>
          ) : employees.filter((employee) => employee.is_active).length === 0 ? (
            <div className="appointmentInnerEmpty">
              <strong>No active employees</strong>
              <p>Add and schedule an employee before creating appointments.</p>
              <a href="/dashboard/employees" className="btn btnPrimary">
                Manage Employees
              </a>
            </div>
          ) : agenda.length === 0 ? (
            <div className="appointmentInnerEmpty">
              <strong>No bookings or blocked time</strong>
              <p>This employee’s calendar is open for the selected date.</p>
            </div>
          ) : (
            <div className="employeeCalendarAgenda">
              {agenda.map((item) => {
                if (item.kind === 'block') {
                  const block = item.block

                  return (
                    <article className="calendarAgendaItem calendarAgendaItem--block" key={item.id}>
                      <div className="calendarAgendaTime">
                        <strong>{formatTime(block.starts_at)}</strong>
                        <span>to {formatTime(block.ends_at)}</span>
                      </div>
                      <div className="calendarAgendaDetails">
                        <span>BLOCKED · {block.block_type.replace('_', ' ')}</span>
                        <strong>{block.title}</strong>
                        {block.details && <p>{block.details}</p>}
                      </div>
                      <button
                        type="button"
                        className="calendarDeleteButton"
                        onClick={() => void deleteItem('block', block.id)}
                      >
                        Delete
                      </button>
                    </article>
                  )
                }

                const appointment = item.appointment
                const employee = appointment.employee_id
                  ? employeeById.get(appointment.employee_id)
                  : null

                return (
                  <article className="calendarAgendaItem" key={item.id}>
                    <div className="calendarAgendaTime">
                      <strong>{formatTime(appointment.appointment_time)}</strong>
                      <span>
                        to{' '}
                        {formatTime(
                          appointment.appointment_end_time ||
                            new Date(
                              new Date(appointment.appointment_time).getTime() +
                                appointment.duration_minutes * 60_000
                            ).toISOString()
                        )}
                      </span>
                    </div>
                    <div className="calendarAgendaDetails">
                      <span>
                        {appointment.source.toUpperCase()} ·{' '}
                        {employee?.name || 'Unassigned employee'}
                      </span>
                      <strong>{appointment.customer_name || 'Customer'}</strong>
                      <p>
                        {appointment.service || 'Reason not specified'}
                        {appointment.company_name
                          ? ` · ${appointment.company_name}`
                          : ''}
                      </p>
                      <div className="todayAppointmentContact">
                        {appointment.customer_phone && (
                          <span>{appointment.customer_phone}</span>
                        )}
                        {appointment.customer_email && (
                          <span>{appointment.customer_email}</span>
                        )}
                      </div>
                      {appointment.notes && (
                        <p className="calendarPublicNote">{appointment.notes}</p>
                      )}
                      {appointment.internal_notes && (
                        <p className="calendarInternalNote">
                          Private: {appointment.internal_notes}
                        </p>
                      )}
                    </div>
                    <select
                      value={appointment.status}
                      disabled={updatingId === appointment.id}
                      onChange={(event) =>
                        void updateStatus(
                          appointment.id,
                          event.target.value as AppointmentStatus
                        )
                      }
                      className={`appointmentStatusSelect appointmentStatusSelect--${appointment.status}`}
                    >
                      <option value="booked">Booked</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className="appointmentDatePanel calendarCreatePanel">
          <div className="appointmentDateHeader">
            <div>
              <span className="appointmentSectionLabel">ADD TO CALENDAR</span>
              <h2>Book or block a time</h2>
              <p>
                Manual bookings immediately become unavailable to the AI agent.
                Private notes are never shared with callers.
              </p>
            </div>
          </div>

          <form className="calendarCreateForm" onSubmit={submitCalendarItem}>
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
                Blocked time
              </button>
            </div>

            <div className="calendarFormGrid">
              <label>
                <span>Employee</span>
                <select
                  required
                  value={form.employeeId}
                  onChange={(event) => updateForm('employeeId', event.target.value)}
                >
                  <option value="">Choose employee</option>
                  {employees
                    .filter((employee) => employee.is_active)
                    .map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name} — {employee.role || 'Employee'}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Date</span>
                <input
                  type="date"
                  required
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                />
              </label>
              <label>
                <span>Start time</span>
                <input
                  type="time"
                  required
                  value={form.time}
                  onChange={(event) => updateForm('time', event.target.value)}
                />
              </label>
              <label>
                <span>Duration</span>
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
            </div>

            {form.kind === 'appointment' ? (
              <>
                <label className="calendarFullField">
                  <span>Saved client (optional)</span>
                  <select
                    value={savedContactId}
                    onChange={(event) => selectSavedContact(event.target.value)}
                  >
                    <option value="">Enter details manually</option>
                    {contacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                        {contact.company_name ? ` — ${contact.company_name}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="calendarFormGrid">
                  <label>
                    <span>Customer name *</span>
                    <input
                      required
                      value={form.customerName}
                      onChange={(event) =>
                        updateForm('customerName', event.target.value)
                      }
                      placeholder="Jane Smith"
                    />
                  </label>
                  <label>
                    <span>Email</span>
                    <input
                      type="email"
                      value={form.customerEmail}
                      onChange={(event) =>
                        updateForm('customerEmail', event.target.value)
                      }
                      placeholder="jane@example.com"
                    />
                  </label>
                  <label>
                    <span>Phone</span>
                    <input
                      value={form.customerPhone}
                      onChange={(event) =>
                        updateForm('customerPhone', event.target.value)
                      }
                      placeholder="+1 416..."
                    />
                  </label>
                  <label>
                    <span>Customer company</span>
                    <input
                      value={form.companyName}
                      onChange={(event) =>
                        updateForm('companyName', event.target.value)
                      }
                      placeholder="Optional"
                    />
                  </label>
                  <label>
                    <span>Reason or service</span>
                    <input
                      value={form.service}
                      onChange={(event) => updateForm('service', event.target.value)}
                      placeholder="Consultation"
                    />
                  </label>
                  <label>
                    <span>Customer-visible details</span>
                    <input
                      value={form.notes}
                      onChange={(event) => updateForm('notes', event.target.value)}
                      placeholder="Included in confirmation"
                    />
                  </label>
                </div>
                <label className="calendarFullField">
                  <span>Private manager notes</span>
                  <textarea
                    value={form.internalNotes}
                    onChange={(event) =>
                      updateForm('internalNotes', event.target.value)
                    }
                    placeholder="Only visible inside the Recepta dashboard"
                  />
                </label>
              </>
            ) : (
              <div className="calendarFormGrid">
                <label>
                  <span>Block type</span>
                  <select
                    value={form.blockType}
                    onChange={(event) =>
                      updateForm(
                        'blockType',
                        event.target.value as FormState['blockType']
                      )
                    }
                  >
                    <option value="unavailable">Unavailable</option>
                    <option value="break">Break</option>
                    <option value="meeting">Internal meeting</option>
                    <option value="time_off">Time off</option>
                  </select>
                </label>
                <label>
                  <span>Title *</span>
                  <input
                    required
                    value={form.title}
                    onChange={(event) => updateForm('title', event.target.value)}
                    placeholder="Lunch break"
                  />
                </label>
                <label className="calendarGridWide">
                  <span>Details</span>
                  <input
                    value={form.details}
                    onChange={(event) => updateForm('details', event.target.value)}
                    placeholder="Optional internal details"
                  />
                </label>
              </div>
            )}

            <button
              type="submit"
              className="btn btnPrimary"
              disabled={saving || !form.employeeId}
            >
              {saving
                ? 'Saving...'
                : form.kind === 'appointment'
                  ? 'Book Appointment'
                  : 'Block This Time'}
            </button>
          </form>
        </section>

        <section className="appointmentDatePanel savedClientsPanel">
          <div className="appointmentDateHeader">
            <div>
              <span className="appointmentSectionLabel">OPTIONAL CLIENT LIST</span>
              <h2>Saved appointment clients</h2>
              <p>
                Save frequent clients to prefill bookings. Appointments do not
                require this list, and deleting a client will not delete history.
              </p>
            </div>
            <span className="appointmentCount">{contacts.length}</span>
          </div>

          <form className="savedContactForm" onSubmit={saveContact}>
            <div className="calendarFormGrid">
              <label>
                <span>Name *</span>
                <input
                  required
                  value={contactForm.name}
                  onChange={(event) =>
                    setContactForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="Customer name"
                />
              </label>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={contactForm.email}
                  onChange={(event) =>
                    setContactForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  placeholder="customer@example.com"
                />
              </label>
              <label>
                <span>Phone</span>
                <input
                  value={contactForm.phone}
                  onChange={(event) =>
                    setContactForm((current) => ({
                      ...current,
                      phone: event.target.value,
                    }))
                  }
                  placeholder="+1 416..."
                />
              </label>
              <label>
                <span>Company</span>
                <input
                  value={contactForm.companyName}
                  onChange={(event) =>
                    setContactForm((current) => ({
                      ...current,
                      companyName: event.target.value,
                    }))
                  }
                  placeholder="Optional"
                />
              </label>
            </div>
            <label className="calendarFullField">
              <span>Notes</span>
              <input
                value={contactForm.notes}
                onChange={(event) =>
                  setContactForm((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                placeholder="Optional preferences or details"
              />
            </label>
            <button
              type="submit"
              className="btn btnOutline"
              disabled={savingContact}
            >
              {savingContact ? 'Saving...' : 'Add to Client List'}
            </button>
          </form>

          {contacts.length > 0 && (
            <div className="savedContactList">
              {contacts.map((contact) => (
                <article key={contact.id} className="savedContactCard">
                  <div>
                    <strong>{contact.name}</strong>
                    <span>{contact.company_name || 'Individual client'}</span>
                    <p>
                      {[contact.email, contact.phone].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="savedContactActions">
                    <button
                      type="button"
                      onClick={() => {
                        selectSavedContact(contact.id)
                        updateForm('kind', 'appointment')
                        window.scrollTo({ top: 650, behavior: 'smooth' })
                      }}
                    >
                      Use
                    </button>
                    <button
                      type="button"
                      className="calendarDeleteButton"
                      onClick={() => void deleteItem('contact', contact.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
