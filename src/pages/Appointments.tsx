import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type AppointmentStatus = 'booked' | 'cancelled' | 'completed'

type AppointmentRecord = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  service: string | null
  appointment_time: string | null
  status: AppointmentStatus
}

export default function Appointments() {
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [hasProAccess, setHasProAccess] = useState(false)
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date()

    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
  })

  const [updatingId, setUpdatingId] = useState<string | null>(null)

  useEffect(() => {
    const loadAppointments = async () => {
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

      const allowed =
        !subscriptionError &&
        subscription?.status === 'active' &&
        subscription?.plan_name === 'Recepta Pro'

      if (!allowed) {
        setHasProAccess(false)
        setLoading(false)
        return
      }

      setHasProAccess(true)

      const { data, error } = await supabase
        .from('appointments')
        .select(
          'id, customer_name, customer_phone, customer_email, service, appointment_time, status'
        )
        .eq('client_id', user.id)
        .order('appointment_time', { ascending: true })

      if (!error && data) {
        setAppointments(data)
      }

      setLoading(false)
    }

    loadAppointments()
  }, [])

  const isSameDate = (dateString: string | null, targetDate: string) => {
    if (!dateString) return false

    const date = new Date(dateString)

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}` === targetDate
  }

  const todayString = useMemo(() => {
    const now = new Date()

    const year = now.getFullYear()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
  }, [])

  const todaysAppointments = useMemo(() => {
    return appointments.filter((appointment) =>
      isSameDate(appointment.appointment_time, todayString)
    )
  }, [appointments, todayString])

  const selectedDateAppointments = useMemo(() => {
    return appointments.filter((appointment) =>
      isSameDate(appointment.appointment_time, selectedDate)
    )
  }, [appointments, selectedDate])

  const updateStatus = async (
    appointmentId: string,
    newStatus: AppointmentStatus
  ) => {
    if (!hasProAccess) return

    setUpdatingId(appointmentId)

    const { error } = await supabase
      .from('appointments')
      .update({
        status: newStatus,
      })
      .eq('id', appointmentId)

    if (!error) {
      setAppointments((current) =>
        current.map((appointment) =>
          appointment.id === appointmentId
            ? {
                ...appointment,
                status: newStatus,
              }
            : appointment
        )
      )
    }

    setUpdatingId(null)
  }

  const formatAppointmentTime = (appointmentTime: string | null) => {
    if (!appointmentTime) return 'Time not assigned'

    return new Date(appointmentTime).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const formatSelectedDate = (dateValue: string) => {
    const [year, month, day] = dateValue.split('-')

    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day)
    ).toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const renderAppointment = (appointment: AppointmentRecord) => {
    return (
      <div className="todayAppointmentCard" key={appointment.id}>
        <div className="todayAppointmentTime">
          <span>TIME</span>

          <strong>
            {formatAppointmentTime(appointment.appointment_time)}
          </strong>
        </div>

        <div className="todayAppointmentCustomer">
          <strong>
            {appointment.customer_name || 'Customer'}
          </strong>

          <span>
            {appointment.service || 'Service not specified'}
          </span>

          <div className="todayAppointmentContact">
            {appointment.customer_phone && (
              <span>{appointment.customer_phone}</span>
            )}

            {appointment.customer_email && (
              <span>{appointment.customer_email}</span>
            )}
          </div>
        </div>

        <div className="todayAppointmentStatus">
          <span>STATUS</span>

          <select
            value={appointment.status}
            disabled={updatingId === appointment.id}
            onChange={(event) =>
              updateStatus(
                appointment.id,
                event.target.value as AppointmentStatus
              )
            }
            className={`appointmentStatusSelect appointmentStatusSelect--${appointment.status}`}
          >
            <option value="booked">
              Booked
            </option>

            <option value="completed">
              Completed
            </option>

            <option value="cancelled">
              Cancelled
            </option>
          </select>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>Loading appointments...</p>
          </div>
        </section>
      </main>
    )
  }

  if (!hasProAccess) {
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
              href="/dashboard/billing"
              className="dashboardNavItem dashboardNavItemActive"
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
          <div className="dashboardEmptyState">
            <p className="dashboardEyebrow">RECEPTA PRO</p>
            <h2>Appointments requires Recepta Pro</h2>
            <p>
              Upgrade to the C$300 Pro plan to unlock
              appointments and employee scheduling.
            </p>
            <a
              href="/dashboard/billing"
              className="btn btnPrimary"
            >
              View Pro Plan
            </a>
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
            className="dashboardNavItem dashboardNavItemActive"
          >
            Appointments
          </a>

          <a
            href="/dashboard/employees"
            className="dashboardNavItem"
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
              APPOINTMENTS
            </p>

            <h1>Appointments</h1>

            <p>
              See who is scheduled today and check appointments for any date.
            </p>
          </div>
        </div>

        {/* TODAY */}

        <section className="todayAppointmentsPanel">
          <div className="todayAppointmentsHeader">
            <div>
              <span className="appointmentSectionLabel">
                TODAY
              </span>

              <h2>
                Today's Appointments
              </h2>

              <p>
                {new Date().toLocaleDateString([], {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>

            <div className="todayAppointmentsCount">
              <strong>
                {todaysAppointments.length}
              </strong>

              <span>
                {todaysAppointments.length === 1
                  ? 'appointment'
                  : 'appointments'}
              </span>
            </div>
          </div>

          {todaysAppointments.length === 0 ? (
            <div className="appointmentInnerEmpty">
              <strong>
                No appointments today
              </strong>

              <p>
                Your receptionist has no customer appointments scheduled for today.
              </p>
            </div>
          ) : (
            <div className="todayAppointmentsList">
              {todaysAppointments.map(renderAppointment)}
            </div>
          )}
        </section>

        {/* DATE LOOKUP */}

        <section className="appointmentDatePanel">
          <div className="appointmentDateHeader">
            <div>
              <span className="appointmentSectionLabel">
                OTHER DATES
              </span>

              <h2>
                Check another day
              </h2>

              <p>
                Choose a date to see appointments scheduled for that day.
              </p>
            </div>

            <input
              type="date"
              value={selectedDate}
              onChange={(event) =>
                setSelectedDate(event.target.value)
              }
              className="appointmentDatePicker"
            />
          </div>

          <div className="appointmentSelectedDateHeading">
            <div>
              <span>
                SELECTED DATE
              </span>

              <strong>
                {formatSelectedDate(selectedDate)}
              </strong>
            </div>

            <span className="appointmentCount">
              {selectedDateAppointments.length}
            </span>
          </div>

          {selectedDateAppointments.length === 0 ? (
            <div className="appointmentInnerEmpty">
              <strong>
                No appointments on this date
              </strong>

              <p>
                Choose another date to check scheduled appointments.
              </p>
            </div>
          ) : (
            <div className="todayAppointmentsList">
              {selectedDateAppointments.map(renderAppointment)}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
