import type { SupabaseClient } from '@supabase/supabase-js'
import { isBusinessOpen } from './businessHours'
import { getStoredBusinessSchedule } from './employeeSchedule'
import { hasPaidSubscription } from './subscriptionConfiguration'

export class BookingError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export const checked = <T>(result: { data: T; error: { message: string } | null }): T => {
  if (result.error) throw new Error(result.error.message)
  return result.data
}
export const loadBookingAccount = async (db: SupabaseClient, clientId: string, requirePaid = false) => {
  const [subscription, agent, settings] = await Promise.all([
    db.from('subscriptions').select('plan_name,status,stripe_subscription_id,current_period_start,current_period_end').eq('client_id', clientId).maybeSingle(),
    db.from('agents').select('retell_agent_id,business_hours').eq('client_id', clientId).maybeSingle(),
    db.from('booking_settings').select('enabled,capacity,duration_minutes,buffer_minutes').eq('client_id', clientId).maybeSingle(),
  ])
  const plan = checked(subscription)
  if (plan?.plan_name !== 'Recepta Pro') throw new BookingError('Bookings are available with Recepta Pro.', 403)
  if (requirePaid && !hasPaidSubscription(plan)) throw new BookingError('Complete Pro billing to enable bookings and use the AI agent.', 403)
  const assigned = checked(agent)
  return {
    paid: hasPaidSubscription(plan), agent: assigned,
    schedule: getStoredBusinessSchedule(assigned?.business_hours),
    settings: checked(settings) ?? { enabled: false, capacity: 1, duration_minutes: 30, buffer_minutes: 0 },
  }
}
export type BookingInput = {
  customer_name: string; customer_phone: string | null; customer_email: string | null
  service: string; start: string; duration_minutes: number; employee_id: string | null; notes: string | null
}
const shortText = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) || null : null
export const normalizeBooking = (input: Record<string, unknown>, defaultDuration: number): BookingInput => {
  const start = shortText(input.start, 50)
  const duration = input.duration_minutes ?? defaultDuration
  if (!start || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(start) || !Number.isFinite(Date.parse(start))) throw new BookingError('A valid date, time and timezone offset are required.')
  if (!Number.isInteger(duration) || Number(duration) < 5 || Number(duration) > 480) throw new BookingError('Duration must be 5–480 minutes.')
  const name = shortText(input.customer_name, 160)
  if (!name) throw new BookingError('Customer name is required.')
  const email = shortText(input.customer_email, 320)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BookingError('Enter a valid customer email.')
  return { customer_name: name, customer_phone: shortText(input.customer_phone, 60), customer_email: email,
    service: shortText(input.service, 300) ?? 'Appointment', start: new Date(start).toISOString(), duration_minutes: Number(duration),
    employee_id: shortText(input.employee_id, 100), notes: shortText(input.notes, 3000) }
}
export const validateBookingTime = async (db: SupabaseClient, clientId: string, account: Awaited<ReturnType<typeof loadBookingAccount>>, input: BookingInput, excludeId?:string) => {
  const start = Date.parse(input.start), end = start + input.duration_minutes * 60000
  if (start <= Date.now() || start > Date.now() + 90 * 86400000) throw new BookingError('Choose a future appointment within 90 days.')
  const buffer = account.settings.buffer_minutes * 60000
  // Check the entire service plus preparation/cleanup, including overnight schedules.
  for (let t = start - buffer; t < end + buffer; t += 60000) {
    if (!isBusinessOpen(account.schedule, new Date(t))) throw new BookingError('That appointment is outside the saved business hours.', 409)
  }
  if (!isBusinessOpen(account.schedule,new Date(end+buffer-1))) throw new BookingError('That appointment is outside the saved business hours.',409)
  if (!input.employee_id) return
  const [employee, hours, blocks, bookings] = await Promise.all([
    db.from('employees').select('id').eq('id', input.employee_id).eq('client_id', clientId).eq('is_active', true).maybeSingle(),
    db.from('employee_schedules').select('day_of_week,is_working,start_time,end_time').eq('employee_id', input.employee_id),
    db.from('employee_calendar_blocks').select('id').eq('client_id', clientId).eq('employee_id', input.employee_id).lt('starts_at', new Date(end + buffer).toISOString()).gt('ends_at', new Date(start - buffer).toISOString()).limit(1),
    db.from('appointments').select('id,appointment_time,appointment_end_time,booking_buffer_minutes').eq('client_id',clientId).eq('employee_id',input.employee_id).eq('status','booked'),
  ])
  if (!checked(employee) || checked(blocks)?.length) throw new BookingError('The selected employee is unavailable.', 409)
  if (checked(bookings)?.some(a=>a.id!==excludeId&&Date.parse(a.appointment_time)-(a.booking_buffer_minutes??0)*60000<end+buffer&&Date.parse(a.appointment_end_time)+(a.booking_buffer_minutes??0)*60000>start-buffer)) throw new BookingError('The selected employee is already booked.',409)
  const rows = checked(hours) ?? []
  const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const schedule = { ...account.schedule, mode: 'custom' as const, hours: names.map((day, i) => {
    const row = rows.find(r => r.day_of_week === i)
    return { day, open: Boolean(row?.is_working), start: row?.start_time?.slice(0,5) ?? '', end: row?.end_time?.slice(0,5) ?? '' }
  }) }
  for (let t = start - buffer; t < end + buffer; t += 60000) {
    if (!isBusinessOpen(schedule, new Date(t))) throw new BookingError('That appointment is outside the selected employee’s working hours.', 409)
  }
  if (!isBusinessOpen(schedule,new Date(end+buffer-1))) throw new BookingError('That appointment is outside the selected employee’s working hours.',409)
}
