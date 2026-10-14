export type AppointmentStatus = 'pending' | 'booked' | 'cancelled' | 'completed'

export type AppointmentPreference = {
  requested_date?: string | null
  requested_time?: string | null
  requested_timezone?: string | null
}

export const formatAppointmentPreference = (request: AppointmentPreference) =>
  [request.requested_date, request.requested_time, request.requested_timezone]
    .filter(Boolean).join(' · ') || 'Not provided'

export const isConfirmedAppointment = (appointment: {
  status: string
  appointment_time: string | null
}) => (appointment.status === 'booked' || appointment.status === 'completed') &&
  Boolean(appointment.appointment_time && Number.isFinite(Date.parse(appointment.appointment_time)))

export const appointmentCallId = (value: string | null) => value?.split(':')[0] ?? null
