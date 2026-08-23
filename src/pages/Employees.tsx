import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type Employee = {
  id: string
  name: string
  email: string | null
  phone: string | null
  role: string | null
  is_active: boolean
}

type Schedule = {
  id?: string
  employee_id: string
  day_of_week: number
  is_working: boolean
  start_time: string | null
  end_time: string | null
}

type ScheduleOverride = {
  id?: string
  employee_id: string
  schedule_date: string
  is_working: boolean
  start_time: string | null
  end_time: string | null
}

const DAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]

const getDateString = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

const getStartOfWeek = (date: Date) => {
  const copy = new Date(date)
  const day = copy.getDay()

  copy.setDate(copy.getDate() - day)
  copy.setHours(0, 0, 0, 0)

  return copy
}

export default function Employees() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [overrides, setOverrides] = useState<ScheduleOverride[]>([])

  const [selectedEmployeeId, setSelectedEmployeeId] =
    useState<string | null>(null)

  const [selectedWeek, setSelectedWeek] = useState(() =>
    getStartOfWeek(new Date())
  )

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState('')

  const [loading, setLoading] = useState(true)
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [savingOverrides, setSavingOverrides] = useState(false)

  const [message, setMessage] = useState('')

  useEffect(() => {
    loadEmployees()
  }, [])

  useEffect(() => {
    if (!selectedEmployeeId) {
      setSchedules([])
      setOverrides([])
      return
    }

    loadSchedule(selectedEmployeeId)
    loadOverrides(selectedEmployeeId)
  }, [selectedEmployeeId, selectedWeek])

  const loadEmployees = async () => {
    setLoading(true)

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setLoading(false)
      return
    }

    const { data, error } = await supabase
      .from('employees')
      .select('id, name, email, phone, role, is_active')
      .eq('client_id', user.id)
      .order('created_at', { ascending: true })

    if (!error && data) {
      setEmployees(data)

      if (data.length > 0) {
        setSelectedEmployeeId(
          (current) => current || data[0].id
        )
      }
    }

    setLoading(false)
  }

  const loadSchedule = async (employeeId: string) => {
    const { data, error } = await supabase
      .from('employee_schedules')
      .select(
        'id, employee_id, day_of_week, is_working, start_time, end_time'
      )
      .eq('employee_id', employeeId)
      .order('day_of_week', { ascending: true })

    if (error) {
      console.error(error)
      return
    }

    const existing = data || []

    const fullWeek = DAYS.map((day) => {
      const found = existing.find(
        (schedule) =>
          schedule.day_of_week === day.value
      )

      if (found) {
        return found
      }

      return {
        employee_id: employeeId,
        day_of_week: day.value,
        is_working: day.value >= 1 && day.value <= 5,
        start_time: '09:00',
        end_time: '17:00',
      }
    })

    setSchedules(fullWeek)
  }

  const loadOverrides = async (employeeId: string) => {
    const weekStart = new Date(selectedWeek)

    const weekEnd = new Date(selectedWeek)
    weekEnd.setDate(weekEnd.getDate() + 6)

    const { data, error } = await supabase
      .from('employee_schedule_overrides')
      .select(
        'id, employee_id, schedule_date, is_working, start_time, end_time'
      )
      .eq('employee_id', employeeId)
      .gte(
        'schedule_date',
        getDateString(weekStart)
      )
      .lte(
        'schedule_date',
        getDateString(weekEnd)
      )

    if (error) {
      console.error(error)
      return
    }

    setOverrides(data || [])
  }

  const handleAddEmployee = async () => {
    if (!name.trim()) {
      setMessage('Employee name is required.')
      return
    }

    setSavingEmployee(true)
    setMessage('')

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setSavingEmployee(false)
      return
    }

    const { data, error } = await supabase
      .from('employees')
      .insert({
        client_id: user.id,
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        role: role.trim() || null,
        is_active: true,
      })
      .select(
        'id, name, email, phone, role, is_active'
      )
      .single()

    if (error) {
      setMessage('Could not add employee.')
      setSavingEmployee(false)
      return
    }

    setEmployees((current) => [
      ...current,
      data,
    ])

    setSelectedEmployeeId(data.id)

    setName('')
    setEmail('')
    setPhone('')
    setRole('')

    setMessage('Employee added.')
    setSavingEmployee(false)
  }

  const handleToggleActive = async (
    employee: Employee
  ) => {
    const { error } = await supabase
      .from('employees')
      .update({
        is_active: !employee.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', employee.id)

    if (error) {
      return
    }

    setEmployees((current) =>
      current.map((item) =>
        item.id === employee.id
          ? {
              ...item,
              is_active: !item.is_active,
            }
          : item
      )
    )
  }

  const handleDeleteEmployee = async (
    employeeId: string
  ) => {
    const confirmed = window.confirm(
      'Delete this employee and their schedule?'
    )

    if (!confirmed) return

    const { error } = await supabase
      .from('employees')
      .delete()
      .eq('id', employeeId)

    if (error) return

    const remaining = employees.filter(
      (employee) =>
        employee.id !== employeeId
    )

    setEmployees(remaining)

    if (
      selectedEmployeeId === employeeId
    ) {
      setSelectedEmployeeId(
        remaining[0]?.id || null
      )
    }
  }

  const updateSchedule = (
    dayOfWeek: number,
    field: keyof Schedule,
    value: boolean | string | null
  ) => {
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.day_of_week === dayOfWeek
          ? {
              ...schedule,
              [field]: value,
            }
          : schedule
      )
    )
  }

  const handleSaveSchedule = async () => {
    if (!selectedEmployeeId) return

    setSavingSchedule(true)
    setMessage('')

    const rows = schedules.map(
      (schedule) => ({
        employee_id:
          selectedEmployeeId,

        day_of_week:
          schedule.day_of_week,

        is_working:
          schedule.is_working,

        start_time:
          schedule.is_working
            ? schedule.start_time
            : null,

        end_time:
          schedule.is_working
            ? schedule.end_time
            : null,

        updated_at:
          new Date().toISOString(),
      })
    )

    const { error } = await supabase
      .from('employee_schedules')
      .upsert(rows, {
        onConflict:
          'employee_id,day_of_week',
      })

    if (error) {
      setMessage(
        'Could not save normal schedule.'
      )
    } else {
      setMessage(
        'Normal weekly schedule saved.'
      )

      await loadSchedule(
        selectedEmployeeId
      )
    }

    setSavingSchedule(false)
  }

  const weekDates = useMemo(() => {
    return DAYS.map((day, index) => {
      const date = new Date(selectedWeek)
      date.setDate(
        selectedWeek.getDate() + index
      )

      return {
        ...day,
        date,
        dateString:
          getDateString(date),
      }
    })
  }, [selectedWeek])

  const getDefaultForDate = (
    dayOfWeek: number
  ) => {
    return schedules.find(
      (schedule) =>
        schedule.day_of_week === dayOfWeek
    )
  }

  const getOverrideForDate = (
    dateString: string
  ) => {
    return overrides.find(
      (override) =>
        override.schedule_date ===
        dateString
    )
  }

  const updateOverride = (
    dateString: string,
    dayOfWeek: number,
    field:
      | 'is_working'
      | 'start_time'
      | 'end_time',
    value:
      | boolean
      | string
      | null
  ) => {
    setOverrides((current) => {
      const existing =
        current.find(
          (override) =>
            override.schedule_date ===
            dateString
        )

      if (existing) {
        return current.map(
          (override) =>
            override.schedule_date ===
            dateString
              ? {
                  ...override,
                  [field]: value,
                }
              : override
        )
      }

      const defaultSchedule =
        getDefaultForDate(dayOfWeek)

      return [
        ...current,
        {
          employee_id:
            selectedEmployeeId || '',

          schedule_date:
            dateString,

          is_working:
            field === 'is_working'
              ? Boolean(value)
              : defaultSchedule?.is_working ??
                true,

          start_time:
            field === 'start_time'
              ? String(value)
              : defaultSchedule?.start_time ||
                '09:00',

          end_time:
            field === 'end_time'
              ? String(value)
              : defaultSchedule?.end_time ||
                '17:00',
        },
      ]
    })
  }

  const resetOverride = (
    dateString: string
  ) => {
    setOverrides((current) =>
      current.filter(
        (override) =>
          override.schedule_date !==
          dateString
      )
    )
  }

  const handleSaveOverrides = async () => {
    if (!selectedEmployeeId) return

    setSavingOverrides(true)
    setMessage('')

    const weekStart =
      getDateString(selectedWeek)

    const weekEndDate =
      new Date(selectedWeek)

    weekEndDate.setDate(
      weekEndDate.getDate() + 6
    )

    const weekEnd =
      getDateString(weekEndDate)

    const { error: deleteError } =
      await supabase
        .from(
          'employee_schedule_overrides'
        )
        .delete()
        .eq(
          'employee_id',
          selectedEmployeeId
        )
        .gte(
          'schedule_date',
          weekStart
        )
        .lte(
          'schedule_date',
          weekEnd
        )

    if (deleteError) {
      setMessage(
        'Could not save weekly changes.'
      )
      setSavingOverrides(false)
      return
    }

    if (overrides.length > 0) {
      const rows = overrides.map(
        (override) => ({
          employee_id:
            selectedEmployeeId,

          schedule_date:
            override.schedule_date,

          is_working:
            override.is_working,

          start_time:
            override.is_working
              ? override.start_time
              : null,

          end_time:
            override.is_working
              ? override.end_time
              : null,

          updated_at:
            new Date().toISOString(),
        })
      )

      const { error: insertError } =
        await supabase
          .from(
            'employee_schedule_overrides'
          )
          .upsert(rows, {
            onConflict:
              'employee_id,schedule_date',
          })

      if (insertError) {
        setMessage(
          'Could not save weekly changes.'
        )
        setSavingOverrides(false)
        return
      }
    }

    setMessage(
      'Weekly schedule changes saved.'
    )

    await loadOverrides(
      selectedEmployeeId
    )

    setSavingOverrides(false)
  }

  const changeWeek = (
    amount: number
  ) => {
    const next = new Date(selectedWeek)

    next.setDate(
      next.getDate() + amount * 7
    )

    setSelectedWeek(next)
  }

  const selectedEmployee =
    useMemo(() => {
      return employees.find(
        (employee) =>
          employee.id ===
          selectedEmployeeId
      )
    }, [
      employees,
      selectedEmployeeId,
    ])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Loading employees...
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">

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
            className="dashboardNavItem"
          >
            Calls
          </a>

          <a
            href="/dashboard/appointments"
            className="dashboardNavItem"
          >
            Appointments
          </a>

          <a
            href="/dashboard/employees"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Employees
          </a>

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

      <section className="dashboardMain">

        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              EMPLOYEES
            </p>

            <h1>
              Team & Availability
            </h1>

            <p>
              Add employees, set their normal hours
              and make week-specific changes.
            </p>
          </div>
        </div>

        {/* ADD EMPLOYEE */}

        <section className="employeePanel">
          <div className="employeePanelHeading">
            <div>
              <span className="employeeSectionLabel">
                ADD EMPLOYEE
              </span>

              <h2>
                Add someone to your team
              </h2>
            </div>
          </div>

          <div className="employeeCreateGrid">
            <label>
              <span>Name</span>

              <input
                value={name}
                onChange={(event) =>
                  setName(
                    event.target.value
                  )
                }
                placeholder="John Smith"
              />
            </label>

            <label>
              <span>Role</span>

              <input
                value={role}
                onChange={(event) =>
                  setRole(
                    event.target.value
                  )
                }
                placeholder="Technician"
              />
            </label>

            <label>
              <span>Phone</span>

              <input
                value={phone}
                onChange={(event) =>
                  setPhone(
                    event.target.value
                  )
                }
                placeholder="+1 416..."
              />
            </label>

            <label>
              <span>Email</span>

              <input
                value={email}
                onChange={(event) =>
                  setEmail(
                    event.target.value
                  )
                }
                placeholder="john@company.com"
              />
            </label>
          </div>

          <button
            type="button"
            className="btn btnPrimary"
            onClick={handleAddEmployee}
            disabled={savingEmployee}
          >
            {savingEmployee
              ? 'Adding...'
              : 'Add Employee'}
          </button>
        </section>

        <div className="employeeWorkspace">

          {/* EMPLOYEE LIST */}

          <section className="employeePanel">
            <div className="employeePanelHeading">
              <div>
                <span className="employeeSectionLabel">
                  TEAM
                </span>

                <h2>
                  Employees
                </h2>
              </div>

              <span className="employeeCount">
                {employees.length}
              </span>
            </div>

            {employees.length === 0 ? (
              <div className="employeeEmpty">
                <strong>
                  No employees yet
                </strong>

                <p>
                  Add your first employee above.
                </p>
              </div>
            ) : (
              <div className="employeeList">
                {employees.map(
                  (employee) => (
                    <button
                      key={employee.id}
                      type="button"
                      onClick={() =>
                        setSelectedEmployeeId(
                          employee.id
                        )
                      }
                      className={
                        selectedEmployeeId ===
                        employee.id
                          ? 'employeeCard employeeCard--active'
                          : 'employeeCard'
                      }
                    >
                      <div className="employeeAvatar">
                        {employee.name
                          .split(' ')
                          .map(
                            (part) =>
                              part[0]
                          )
                          .join('')
                          .slice(0, 2)
                          .toUpperCase()}
                      </div>

                      <div className="employeeCardInfo">
                        <strong>
                          {employee.name}
                        </strong>

                        <span>
                          {employee.role ||
                            'Employee'}
                        </span>
                      </div>

                      <span
                        className={
                          employee.is_active
                            ? 'employeeStatus employeeStatus--active'
                            : 'employeeStatus employeeStatus--inactive'
                        }
                      >
                        {employee.is_active
                          ? 'Active'
                          : 'Inactive'}
                      </span>
                    </button>
                  )
                )}
              </div>
            )}
          </section>

          {/* NORMAL SCHEDULE */}

          <section className="employeePanel">
            <div className="employeePanelHeading">
              <div>
                <span className="employeeSectionLabel">
                  NORMAL SCHEDULE
                </span>

                <h2>
                  {selectedEmployee
                    ? selectedEmployee.name
                    : 'Select an employee'}
                </h2>
              </div>
            </div>

            {!selectedEmployee ? (
              <div className="employeeEmpty">
                <strong>
                  Select an employee
                </strong>

                <p>
                  Choose an employee to edit
                  their normal weekly hours.
                </p>
              </div>
            ) : (
              <>
                <div className="employeeProfileSummary">
                  <div>
                    <span>
                      Role
                    </span>

                    <strong>
                      {selectedEmployee.role ||
                        'Not specified'}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Phone
                    </span>

                    <strong>
                      {selectedEmployee.phone ||
                        'Not provided'}
                    </strong>
                  </div>

                  <div>
                    <span>
                      Email
                    </span>

                    <strong>
                      {selectedEmployee.email ||
                        'Not provided'}
                    </strong>
                  </div>
                </div>

                <div className="employeeScheduleList">
                  {DAYS.map((day) => {
                    const schedule =
                      schedules.find(
                        (item) =>
                          item.day_of_week ===
                          day.value
                      )

                    if (!schedule) {
                      return null
                    }

                    return (
                      <div
                        className="employeeScheduleRow"
                        key={day.value}
                      >
                        <div className="employeeScheduleDay">
                          <strong>
                            {day.label}
                          </strong>
                        </div>

                        <label className="employeeWorkingToggle">
                          <input
                            type="checkbox"
                            checked={
                              schedule.is_working
                            }
                            onChange={(event) =>
                              updateSchedule(
                                day.value,
                                'is_working',
                                event.target
                                  .checked
                              )
                            }
                          />

                          <span>
                            {schedule.is_working
                              ? 'Working'
                              : 'Off'}
                          </span>
                        </label>

                        {schedule.is_working ? (
                          <div className="employeeTimeInputs">
                            <input
                              type="time"
                              value={
                                schedule.start_time?.slice(
                                  0,
                                  5
                                ) ||
                                '09:00'
                              }
                              onChange={(event) =>
                                updateSchedule(
                                  day.value,
                                  'start_time',
                                  event.target
                                    .value
                                )
                              }
                            />

                            <span>
                              to
                            </span>

                            <input
                              type="time"
                              value={
                                schedule.end_time?.slice(
                                  0,
                                  5
                                ) ||
                                '17:00'
                              }
                              onChange={(event) =>
                                updateSchedule(
                                  day.value,
                                  'end_time',
                                  event.target
                                    .value
                                )
                              }
                            />
                          </div>
                        ) : (
                          <span className="employeeDayOff">
                            Day off
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>

                <div className="employeeScheduleActions">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={
                      handleSaveSchedule
                    }
                    disabled={savingSchedule}
                  >
                    {savingSchedule
                      ? 'Saving...'
                      : 'Save Normal Schedule'}
                  </button>

                  <button
                    type="button"
                    className="btn btnOutline"
                    onClick={() =>
                      handleToggleActive(
                        selectedEmployee
                      )
                    }
                  >
                    {selectedEmployee.is_active
                      ? 'Deactivate Employee'
                      : 'Activate Employee'}
                  </button>

                  <button
                    type="button"
                    className="btn btnOutline employeeDeleteButton"
                    onClick={() =>
                      handleDeleteEmployee(
                        selectedEmployee.id
                      )
                    }
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        {/* SPECIFIC WEEK */}

        {selectedEmployee && (
          <section className="employeePanel">
            <div className="employeePanelHeading">
              <div>
                <span className="employeeSectionLabel">
                  THIS WEEK / OVERRIDES
                </span>

                <h2>
                  Specific week schedule
                </h2>

                <p>
                  Change individual days without
                  changing the employee's normal schedule.
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  className="btn btnOutline"
                  onClick={() =>
                    changeWeek(-1)
                  }
                >
                  ←
                </button>

                <span
                  style={{
                    fontSize: '10px',
                    color:
                      'rgba(235,244,238,0.55)',
                  }}
                >
                  {selectedWeek.toLocaleDateString(
                    [],
                    {
                      month: 'short',
                      day: 'numeric',
                    }
                  )}
                  {' — '}
                  {new Date(
                    selectedWeek.getFullYear(),
                    selectedWeek.getMonth(),
                    selectedWeek.getDate() + 6
                  ).toLocaleDateString(
                    [],
                    {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    }
                  )}
                </span>

                <button
                  type="button"
                  className="btn btnOutline"
                  onClick={() =>
                    changeWeek(1)
                  }
                >
                  →
                </button>
              </div>
            </div>

            <div className="employeeScheduleList">
              {weekDates.map((day) => {
                const defaultSchedule =
                  getDefaultForDate(
                    day.value
                  )

                const override =
                  getOverrideForDate(
                    day.dateString
                  )

                const effectiveWorking =
                  override
                    ? override.is_working
                    : defaultSchedule?.is_working ??
                      false

                const effectiveStart =
                  override?.start_time ||
                  defaultSchedule?.start_time ||
                  '09:00'

                const effectiveEnd =
                  override?.end_time ||
                  defaultSchedule?.end_time ||
                  '17:00'

                const isOverridden =
                  Boolean(override)

                return (
                  <div
                    className="employeeScheduleRow"
                    key={day.dateString}
                  >
                    <div className="employeeScheduleDay">
                      <strong>
                        {day.label}
                      </strong>

                      <span
                        style={{
                          display: 'block',
                          marginTop: '3px',
                          color:
                            'rgba(235,244,238,0.3)',
                          fontSize: '9px',
                        }}
                      >
                        {day.date.toLocaleDateString(
                          [],
                          {
                            month: 'short',
                            day: 'numeric',
                          }
                        )}
                      </span>
                    </div>

                    <label className="employeeWorkingToggle">
                      <input
                        type="checkbox"
                        checked={
                          effectiveWorking
                        }
                        onChange={(event) =>
                          updateOverride(
                            day.dateString,
                            day.value,
                            'is_working',
                            event.target.checked
                          )
                        }
                      />

                      <span>
                        {effectiveWorking
                          ? 'Working'
                          : 'Off'}
                      </span>
                    </label>

                    {effectiveWorking ? (
                      <div className="employeeTimeInputs">
                        <input
                          type="time"
                          value={
                            effectiveStart.slice(
                              0,
                              5
                            )
                          }
                          onChange={(event) =>
                            updateOverride(
                              day.dateString,
                              day.value,
                              'start_time',
                              event.target.value
                            )
                          }
                        />

                        <span>
                          to
                        </span>

                        <input
                          type="time"
                          value={
                            effectiveEnd.slice(
                              0,
                              5
                            )
                          }
                          onChange={(event) =>
                            updateOverride(
                              day.dateString,
                              day.value,
                              'end_time',
                              event.target.value
                            )
                          }
                        />
                      </div>
                    ) : (
                      <span className="employeeDayOff">
                        Day off
                      </span>
                    )}

                    {isOverridden && (
                      <button
                        type="button"
                        className="btn btnOutline"
                        onClick={() =>
                          resetOverride(
                            day.dateString
                          )
                        }
                      >
                        Reset
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="employeeScheduleActions">
              <button
                type="button"
                className="btn btnPrimary"
                onClick={
                  handleSaveOverrides
                }
                disabled={
                  savingOverrides
                }
              >
                {savingOverrides
                  ? 'Saving...'
                  : 'Save Weekly Changes'}
              </button>
            </div>
          </section>
        )}

        {message && (
          <p className="employeeMessage">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}
