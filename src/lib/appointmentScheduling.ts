export type CapacityBlock = { start: string; end: string; limit: number }
export type BookingDay = { open: boolean; start: string; end: string; blocks: CapacityBlock[] }
export type SchedulingSettings = {
  enabled: boolean
  duration_minutes: number
  start_interval_minutes: number
  buffer_minutes: number
  capacity: number | null
  hourly_limit: number | null
  time_zone: string
  weekly: Record<string, BookingDay>
  exceptions: Record<string, BookingDay>
  email_owner: boolean
  email_customer: boolean
  sync_error?: string | null
  synced_at?: string | null
}

export const bookingDay = (open = false): BookingDay => ({ open, start: '09:00', end: '17:00', blocks: [] })

export const defaultSchedulingSettings = (timeZone = 'America/Toronto'): SchedulingSettings => ({
  enabled: false, duration_minutes: 30, start_interval_minutes: 15, buffer_minutes: 0, capacity: 1,
  hourly_limit: null, time_zone: timeZone, email_owner: false, email_customer: false,
  weekly: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i + 1), bookingDay()])),
  exceptions: {},
})

export type AppointmentSlot = {
  available: boolean
  reason: string | null
  start?: string
  end?: string
  duration_minutes?: number
  time_zone?: string
  wall_time?: string
  hourly_limit?: number | null
  hourly_remaining?: number | null
  simultaneous_remaining?: number | null
}

export const schedulingReason = (reason: string | null | undefined) => ({
  automatic_booking_disabled: 'Automatic booking is off.',
  schedule_not_set: 'Save booking hours before reserving a time.',
  closed: 'Booking is closed on this day.',
  outside_booking_hours: 'The appointment falls outside booking hours.',
  off_start_interval: 'The start falls outside the configured intervals.',
  hourly_capacity_reached: 'This time block has reached its booking limit.',
  simultaneous_capacity_reached: 'Overlapping appointments have reached capacity.',
  ambiguous_local_time: 'This local time occurs twice. Select the displayed time with its UTC offset.',
  nonexistent_local_time: 'This local time is skipped when clocks change.',
  outside_booking_horizon: 'Appointments can be booked up to 366 days ahead.',
  past_time: 'Choose a time in the future.',
  appointment_changed: 'This appointment changed. Refresh and try again.',
  appointment_not_found: 'The appointment could not be found.',
  invalid_appointment_status: 'This action is unavailable for the current appointment status.',
  pro_required: 'An active Recepta Pro plan is required.',
  choose_a_time: 'Choose a start time.',
})[reason ?? ''] || 'The appointment could not be scheduled.'
