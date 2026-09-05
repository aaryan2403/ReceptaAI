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
  const [selectedAppointment, setSelectedAppointment] =
    useState<AppointmentRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const loadAppointments = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('appointments')
        .select(
          'id, customer_name, customer_phone, customer_email, service, appointment_time, status'
        )
        .eq('client_id', user.id)
        .order('appointment_time', { ascending: true })

      if (!error && data) {
        setAppointments(data)

        if (data.length > 0) {
          setSelectedAppointment(data[0])
        }
      }

      setLoading(false)
    }

    loadAppointments()
  }, [])

  const filteredAppointments = useMemo(() => {
    const query = search.trim().toLowerCase()

    if (!query) return appointments

    return appointments.filter((appointment) => {
      return (
        appointment.customer_name?.toLowerCase().includes(query) ||
        appointment.customer_phone?.toLowerCase().includes(query) ||
        appointment.customer_email?.toLowerCase().includes(query) ||
        appointment.service?.toLowerCase().includes(query) ||
        appointment.status.toLowerCase().includes(query)
      )
    })
  }, [appointments, search])

  const upcomingAppointments = useMemo(() => {
    const now = new Date()

    return filteredAppointments.filter((appointment) => {
      if (!appointment.appointment_time) return false

      const appointmentDate = new Date(appointment.appointment_time)

      return (
        appointmentDate >= now &&
        appointment.status === 'booked'
      )
    })
  }, [filteredAppointments])

  const appointmentHistory = useMemo(() => {
    const now = new Date()

    return filteredAppointments.filter((appointment) => {
      if (!appointment.appointment_time) return true

      const appointmentDate = new Date(appointment.appointment_time)

      return (
        appointmentDate < now ||
        appointment.status === 'cancelled' ||
        appointment.status === 'completed'
      )
    })
  }, [filteredAppointments])

  const analytics = useMemo(() => {
    const total = appointments.length

    const booked = appointments.filter(
      (appointment) => appointment.status === 'booked'
    ).length

    const completed = appointments.filter(
      (appointment) => appointment.status === 'completed'
    ).length

    const cancelled = appointments.filter(
      (appointment) => appointment.status === 'cancelled'
    ).length

    return {
      total,
      booked,
      completed,
      cancelled,
    }
  }, [appointments])

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
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">APPOINTMENTS</p>

            <h1>Booking Center</h1>

            <p>
              View upcoming appointments, customer details and booking
              performance.
            </p>
          </div>
        </div>

        <section className="appointmentAnalytics">
          <div className="appointmentAnalyticsGrid">
            <div>
              <span>Total Appointments Booked</span>
              <strong>{analytics.total}</strong>
            </div>

            <div>
              <span>Upcoming</span>
              <strong>{analytics.booked}</strong>
            </div>

            <div>
              <span>Completed</span>
              <strong>{analytics.completed}</strong>
            </div>

            <div>
              <span>Cancelled</span>
              <strong>{analytics.cancelled}</strong>
            </div>
          </div>
        </section>

        <div className="appointmentSearch">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customer, phone, email, service..."
          />
        </div>

        <div className="appointmentWorkspace">
          <section className="appointmentListPanel">
            <div className="appointmentSectionHeading">
              <div>
                <span className="appointmentSectionLabel">
                  UPCOMING
                </span>

                <h2>Upcoming appointments</h2>
              </div>

              <span className="appointmentCount">
                {upcomingAppointments.length}
              </span>
            </div>

            {upcomingAppointments.length === 0 ? (
              <div className="appointmentInnerEmpty">
                <strong>No upcoming appointments</strong>

                <p>
                  New bookings made by your receptionist will appear here.
                </p>
              </div>
            ) : (
              <div className="appointmentHistoryList">
                {upcomingAppointments.map((appointment) => (
                  <button
                    key={appointment.id}
                    type="button"
                    onClick={() =>
                      setSelectedAppointment(appointment)
                    }
                    className={
                      selectedAppointment?.id === appointment.id
                        ? 'appointmentHistoryItem appointmentHistoryItem--active'
                        : 'appointmentHistoryItem'
                    }
                  >
                    <div className="appointmentHistoryMain">
                      <strong>
                        {appointment.customer_name || 'Customer'}
                      </strong>

                      <span>
                        {appointment.service || 'Service not specified'}
                      </span>
                    </div>

                    <div className="appointmentHistorySide">
                      <strong>
                        {appointment.appointment_time
                          ? new Date(
                              appointment.appointment_time
                            ).toLocaleString()
                          : 'Time pending'}
                      </strong>

                      <span className="appointmentStatus appointmentStatus--booked">
                        booked
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="appointmentHistoryDivider" />

            <div className="appointmentSectionHeading">
              <div>
                <span className="appointmentSectionLabel">
                  HISTORY
                </span>

                <h2>Appointment history</h2>
              </div>

              <span className="appointmentCount">
                {appointmentHistory.length}
              </span>
            </div>

            {appointmentHistory.length === 0 ? (
              <div className="appointmentInnerEmpty">
                <strong>No appointment history</strong>
              </div>
            ) : (
              <div className="appointmentHistoryList">
                {appointmentHistory.map((appointment) => (
                  <button
                    key={appointment.id}
                    type="button"
                    onClick={() =>
                      setSelectedAppointment(appointment)
                    }
                    className={
                      selectedAppointment?.id === appointment.id
                        ? 'appointmentHistoryItem appointmentHistoryItem--active'
                        : 'appointmentHistoryItem'
                    }
                  >
                    <div className="appointmentHistoryMain">
                      <strong>
                        {appointment.customer_name || 'Customer'}
                      </strong>

                      <span>
                        {appointment.service || 'Service not specified'}
                      </span>
                    </div>

                    <div className="appointmentHistorySide">
                      <strong>
                        {appointment.appointment_time
                          ? new Date(
                              appointment.appointment_time
                            ).toLocaleString()
                          : 'Time unavailable'}
                      </strong>

                      <span
                        className={`appointmentStatus appointmentStatus--${appointment.status}`}
                      >
                        {appointment.status}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="appointmentDetailPanel">
            <div className="appointmentSectionHeading">
              <div>
                <span className="appointmentSectionLabel">
                  DETAILS
                </span>

                <h2>Appointment details</h2>
              </div>
            </div>

            {!selectedAppointment ? (
              <div className="appointmentInnerEmpty">
                <strong>Select an appointment</strong>

                <p>
                  Choose an appointment to view the customer and booking
                  information.
                </p>
              </div>
            ) : (
              <div className="appointmentDetailContent">
                <div className="appointmentDetailHero">
                  <div>
                    <span>CUSTOMER</span>

                    <strong>
                      {selectedAppointment.customer_name || 'Customer'}
                    </strong>

                    <small>
                      {selectedAppointment.service ||
                        'Service not specified'}
                    </small>
                  </div>

                  <span
                    className={`appointmentStatus appointmentStatus--${selectedAppointment.status}`}
                  >
                    {selectedAppointment.status}
                  </span>
                </div>

                <div className="appointmentDetailGrid">
                  <div>
                    <span>Date & time</span>

                    <strong>
                      {selectedAppointment.appointment_time
                        ? new Date(
                            selectedAppointment.appointment_time
                          ).toLocaleString()
                        : 'Not scheduled'}
                    </strong>
                  </div>

                  <div>
                    <span>Service</span>

                    <strong>
                      {selectedAppointment.service ||
                        'Not specified'}
                    </strong>
                  </div>

                  <div>
                    <span>Customer phone</span>

                    <strong>
                      {selectedAppointment.customer_phone ||
                        'Not provided'}
                    </strong>
                  </div>

                  <div>
                    <span>Customer email</span>

                    <strong>
                      {selectedAppointment.customer_email ||
                        'Not provided'}
                    </strong>
                  </div>

                  <div>
                    <span>Status</span>

                    <strong>{selectedAppointment.status}</strong>
                  </div>

                  <div>
                    <span>Booking source</span>

                    <strong>Recepta AI</strong>
                  </div>
                </div>

                <div className="appointmentDetailNotice">
                  <span>BOOKING INFORMATION</span>

                  <p>
                    This appointment is part of the same live employee calendar used by your Recepta AI receptionist.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}
