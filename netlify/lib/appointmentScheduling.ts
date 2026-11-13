import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingDay, SchedulingSettings } from '../../src/lib/appointmentScheduling'
import { defaultSchedulingSettings } from '../../src/lib/appointmentScheduling'
import { isEmailAddress } from '../../src/lib/callEmailSettings'

export const textValue = (value: unknown, maximum = 500) => {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maximum) : null
}
export const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false
  const stamp = new Date(value + 'T00:00:00Z')
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value
}
const time = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
export const validTime = (value: unknown): value is string => typeof value === 'string' && time.test(value)
const endTime = (value: unknown): value is string => value === '24:00' || validTime(value)
export const validStart = (value: unknown): value is string =>
  typeof value === 'string' && validDate(value.slice(0,10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::00)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const integer = (value: unknown, min: number, max = 2147483647): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const zoned = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:UTC|[A-Za-z_]+\/[A-Za-z_0-9+/-]+)$/.test(value)) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}

const validateDay = (value: unknown): BookingDay => {
  const day = objectValue(value)
  if (typeof day.open !== 'boolean' || !validTime(day.start) || !endTime(day.end) || day.start >= day.end ||
    !Array.isArray(day.blocks) || day.blocks.length > 24) throw new Error('Enter opening and closing times in order, with up to 24 capacity blocks per day.')
  const blocks = day.blocks.map((entry: unknown) => {
    const block = objectValue(entry)
    if (!validTime(block.start) || !endTime(block.end) || block.start >= block.end || !integer(block.limit, 0)) {
      throw new Error('Each capacity block needs ordered times and a nonnegative whole-number limit.')
    }
    return { start: block.start, end: block.end, limit: block.limit }
  }).sort((a, b) => a.start.localeCompare(b.start))
  if (blocks.some((block, i) => i > 0 && block.start < blocks[i - 1].end)) throw new Error('Capacity blocks cannot overlap on the same day.')
  return { open: day.open, start: day.start, end: day.end, blocks }
}

export const validateSchedulingSettings = (value: unknown): SchedulingSettings => {
  const settings = objectValue(value)
  const { enabled, duration_minutes, start_interval_minutes, buffer_minutes, capacity, hourly_limit, time_zone, email_owner, email_customer } = settings
  if (typeof enabled !== 'boolean' || typeof email_owner !== 'boolean' || typeof email_customer !== 'boolean') throw new Error('Invalid booking or email preferences.')
  if (!integer(duration_minutes, 5, 480) || !integer(start_interval_minutes, 1, 1440) || !integer(buffer_minutes, 0, 120)) {
    throw new Error('Enter a duration of 5–480 minutes, an interval of 1–1,440 minutes and a buffer of 0–120 minutes.')
  }
  if ((capacity !== null && !integer(capacity, 1)) || (hourly_limit !== null && !integer(hourly_limit, 0))) {
    throw new Error('Simultaneous capacity must be positive. The default hourly limit can be zero.')
  }
  if (!zoned(time_zone)) throw new Error('Enter an IANA timezone such as America/Toronto.')
  const week = Object.entries(objectValue(settings.weekly))
  const dates = Object.entries(objectValue(settings.exceptions))
  if (week.length !== 7 || week.some(([day]) => !/^[1-7]$/.test(day))) throw new Error('Include all seven days in the weekly schedule.')
  if (dates.length > 366 || dates.some(([date]) => !validDate(date))) throw new Error('Enter valid dates for up to 366 exceptions.')
  const weekly = Object.fromEntries(week.map(([day, rule]) => [day, validateDay(rule)]))
  const exceptions = Object.fromEntries(dates.map(([day, rule]) => [day, validateDay(rule)]))
  if (enabled && !Object.values(weekly).some(day => day.open) && !Object.values(exceptions).some(day => day.open)) {
    throw new Error('Open at least one booking day before enabling automatic booking.')
  }
  return { enabled, duration_minutes, start_interval_minutes, buffer_minutes,
    capacity: typeof capacity === 'number' ? capacity : null, hourly_limit: typeof hourly_limit === 'number' ? hourly_limit : null, time_zone,
    weekly, exceptions, email_owner, email_customer }
}

export const schedulingSettingsForDashboard = (row: Partial<SchedulingSettings> | null, timeZone?: string) => {
  const defaults = defaultSchedulingSettings(row?.time_zone || timeZone)
  if (!row) return defaults
  return { ...defaults, ...row, weekly: { ...defaults.weekly, ...row.weekly } }
}

export const appointmentIntake = (args: Record<string, unknown>, fields: string[], fromNumber?: unknown) => {
  const configured = new Map(fields.map(label => [label.toLowerCase(), label]))
  const details = new Map<string, string>()
  for (const raw of Array.isArray(args.appointment_details) ? args.appointment_details.slice(0, 40) : []) {
    const entry = objectValue(raw)
    const name = textValue(entry.label, 60)
    const label = name && configured.get(name.toLowerCase())
    const value = textValue(entry.value, 1000)
    if (label && value && !details.has(label)) details.set(label, value)
  }
  const email = textValue(args.customer_email, 320)
  return {
    customer_name: textValue(args.customer_name, 160),
    customer_email: email && isEmailAddress(email) ? email : null,
    customer_phone: textValue(args.customer_phone, 60) || textValue(fromNumber, 60),
    company_name: textValue(args.customer_company, 200),
    service: textValue(args.reason, 300) || 'Appointment request',
    requested_date: textValue(args.preferred_date, 200),
    requested_time: textValue(args.preferred_time, 200),
    requested_timezone: textValue(args.preferred_timezone, 100),
    email_consent: typeof args.customer_email_consent === 'boolean' ? args.customer_email_consent : null,
    notes: JSON.stringify({ version: 1, details: [...details].map(([label, value]) => ({ label, value })) }),
    capturedFields: [...details.keys()],
  }
}

export const isActivePro = async (db: SupabaseClient, clientId: string) => {
  const { data, error } = await db.from('subscriptions').select('status, plan_name').eq('client_id', clientId).maybeSingle()
  if (error) throw new Error('Could not verify appointment access.')
  return data?.status === 'active' && data.plan_name === 'Recepta Pro'
}
