import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type AppointmentRecord = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  service: string | null
  appointment_time: string | null
  status: 'booked' | 'cancelled' | 'completed'
}

export default function Appointments() {
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([])
  const [loading, setLoading] = useState(true)

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
      }

      setLoading(false)
    }

    loadAppointments()
  }, [])

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
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">APPOINTMENTS</p>
            <h1>Appointments</h1>
            <p>
              Appointments booked by your Recepta receptionist appear here.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading appointments...</p>
          </div>
        ) : appointments.length === 0 ? (
          <div className="dashboardEmptyState">
            <h2>No appointments booked yet</h2>
            <p>
              Once your AI receptionist starts scheduling customers, their
              appointment information will appear here.
            </p>
          </div>
        ) : (
          <div className="appointmentsList">
            {appointments.map((appointment) => (
              <div className="appointmentCard" key={appointment.id}>
                <div className="appointmentTop">
                  <div>
                    <strong>
                      {appointment.customer_name || 'Customer'}
                    </strong>

                    <span>
                      {appointment.appointment_time
                        ? new Date(appointment.appointment_time).toLocaleString()
                        : 'Time not assigned'}
                    </span>
                  </div>

                  <span className={`appointmentStatus appointmentStatus--${appointment.status}`}>
                    {appointment.status}
                  </span>
                </div>

                <div className="appointmentDetails">
                  <span>
                    Service: {appointment.service || 'Not specified'}
                  </span>

                  <span>
                    Phone: {appointment.customer_phone || 'Not provided'}
                  </span>

                  <span>
                    Email: {appointment.customer_email || 'Not provided'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
