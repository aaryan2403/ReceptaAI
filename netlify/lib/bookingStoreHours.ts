import type { BookingDay } from '../../src/lib/appointmentScheduling'
import type { RetellSchedule } from './retell'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/

// Store hours, not another dashboard calendar, determine when bookings may start.
// Fail closed on missing/ambiguous or overnight hours. Overnight shifts need a
// separate supported interval model; silently truncating them risks false bookings.
export type BookingHoursMode = 'store_hours' | 'anytime'

export const bookingCalendarFromStoreHours = (schedule: RetellSchedule, bookingMode: BookingHoursMode = 'store_hours'): {
  weekly: Record<string, BookingDay>
  exceptions: Record<string, BookingDay>
  time_zone: string
} => {
  if (bookingMode !== 'store_hours' && bookingMode !== 'anytime') {
    throw new Error('Select when the AI can book appointments.')
  }
  if (bookingMode === 'store_hours' && schedule.mode === 'unconfigured') {
    throw new Error('Configure the client’s store hours before enabling appointment booking.')
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }) }
  catch { throw new Error('Configure a valid store-hours timezone before booking.') }

  const weekly = Object.fromEntries(DAYS.map((dayName, index): [string, BookingDay] => {
    if (bookingMode === 'anytime' || schedule.mode === '24/7') {
      return [String(index + 1), { open: true, start: '00:00', end: '24:00', blocks: [] }]
    }
    const day = schedule.hours.find(item => item.day === dayName)
    if (!day || typeof day.open !== 'boolean' || !TIME.test(day.start) || !TIME.test(day.end)) {
      throw new Error('The client’s store hours are incomplete. Set all seven days in Store Hours.')
    }
    if (day.open && day.start >= day.end) {
      throw new Error('Overnight store hours are not yet supported for bookings. Use same-day opening and closing times.')
    }
    return [String(index + 1), { open: day.open, start: day.open ? day.start : '09:00',
      end: day.open ? day.end : '17:00', blocks: [] }]
  }))
  return { weekly, exceptions: {}, time_zone: schedule.timeZone }
}
