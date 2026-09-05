import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { syncEmployeeScheduleWithRetell } from '../lib/employeeSchedule'

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


const DAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]



export default function EmployeeHours() {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])

  const [selectedEmployeeId, setSelectedEmployeeId] =
    useState<string | null>(null)


  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState('')

  const [loading, setLoading] = useState(true)
  const [isPro, setIsPro] = useState(false)
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)

  const [message, setMessage] = useState('')

  const loadEmployees = useCallback(async () => {
    setLoading(true)

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setLoading(false)
      return
    }

    const {
      data: subscription,
      error: subscriptionError,
    } = await supabase
      .from('subscriptions')
      .select('plan_name, status')
      .eq('client_id', user.id)
      .maybeSingle()

    setIsPro(
      !subscriptionError &&
        subscription?.plan_name === 'Recepta Pro'
    )

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
  }, [])

  const loadSchedule = useCallback(async (employeeId: string) => {
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
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadEmployees()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadEmployees])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedEmployeeId) {
        setSchedules([])
        return
      }

      void loadSchedule(selectedEmployeeId)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadSchedule, selectedEmployeeId])

  const syncWithRetell = async (savedMessage: string) => {
    try {
      await syncEmployeeScheduleWithRetell()
      setMessage(`${savedMessage} Retell has been synchronized.`)
      return true
    } catch (error) {
      setMessage(
        `${savedMessage} ${
          error instanceof Error
            ? error.message
            : 'Retell synchronization failed.'
        }`
      )
      return false
    }
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

    await syncWithRetell('Employee added.')
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

    await syncWithRetell('Employee status updated.')
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

    await syncWithRetell('Employee deleted.')
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

    try {
      await syncEmployeeScheduleWithRetell({
        employeeId: selectedEmployeeId,
        schedules: schedules.map((schedule) => ({
          dayOfWeek: schedule.day_of_week,
          isWorking: schedule.is_working,
          startTime: schedule.is_working
            ? schedule.start_time
            : null,
          endTime: schedule.is_working
            ? schedule.end_time
            : null,
        })),
      })

      setMessage(
        'Employee schedule saved to your dashboard and synced with your assigned AI agent.'
      )
      await loadSchedule(selectedEmployeeId)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not save and synchronize the employee schedule.'
      )
    }

    setSavingSchedule(false)
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

          {isPro && (
            <a
              href="/dashboard/appointments"
              className="dashboardNavItem"
            >
              Appointments
            </a>
          )}

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
            href="/dashboard/requests"
            className="dashboardNavItem"
          >
            Customer Requests
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
              Employees & Working Hours
            </h1>

            <p>
              Add employees and manage the weekly hours your AI receptionist uses.
            </p>
          </div>

          <a href="/dashboard/employees" className="btn btnOutline">
            Back to Team Calendar
          </a>
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

                <p>
                  Save changes here to update the dashboard and the
                  assigned AI receptionist automatically.
                </p>
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
                      ? 'Saving & Syncing...'
                      : 'Save & Sync with AI Agent'}
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

        {message && (
          <p className="employeeMessage">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}
