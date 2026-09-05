import type { SupabaseClient } from '@supabase/supabase-js'
import { getStoredBusinessSchedule } from './employeeSchedule'

export type CalendarEmployee = {
  id: string
  name: string
  role: string | null
  email: string | null
  is_active: boolean
}

export type CalendarAppointment = {
  id: string
  employee_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_email: string | null
  company_name: string | null
  service: string | null
  notes: string | null
  internal_notes: string | null
  appointment_time: string
  appointment_end_time: string | null
  duration_minutes: number
  status: string
  source: string
}

export type CalendarBlock = {
  id: string
  employee_id: string
  title: string
  details: string | null
  block_type: string
  starts_at: string
  ends_at: string
}

type EmployeeSchedule = {
  employee_id: string
  day_of_week: number
  is_working: boolean
  start_time: string | null
  end_time: string | null
}

export type AvailableSlot = {
  employeeId: string
  employeeName: string
  employeeRole: string | null
  start: string
  end: string
  display: string
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

export const normalizeCalendarDate = (value: unknown) => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error('Use a date in YYYY-MM-DD format.')
  }

  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error('Choose a valid calendar date.')
  }

  return value
}

export const normalizeCalendarTime = (value: unknown) => {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new Error('Use a time in 24-hour HH:MM format.')
  }

  return value
}

export const normalizeDuration = (value: unknown) => {
  const duration = Number(value)

  if (!Number.isInteger(duration) || duration < 5 || duration > 480) {
    throw new Error('Duration must be between 5 and 480 minutes.')
  }

  return duration
}

const datePartsInTimeZone = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  )

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  }
}

export const localDateTimeToUtc = (
  dateValue: string,
  timeValue: string,
  timeZone: string
) => {
  const date = normalizeCalendarDate(dateValue)
  const time = normalizeCalendarTime(timeValue)
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const desiredWallClock = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0
  )
  let candidate = desiredWallClock

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = datePartsInTimeZone(new Date(candidate), timeZone)
    const actualWallClock = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    )
    const difference = desiredWallClock - actualWallClock

    if (difference === 0) break
    candidate += difference
  }

  const result = new Date(candidate)
  const finalParts = datePartsInTimeZone(result, timeZone)

  if (
    finalParts.year !== year ||
    finalParts.month !== month ||
    finalParts.day !== day ||
    finalParts.hour !== hour ||
    finalParts.minute !== minute
  ) {
    throw new Error(
      'That local time does not exist in the business timezone. Choose another time.'
    )
  }

  return result
}

const addDays = (dateValue: string, days: number) => {
  const [year, month, day] = dateValue.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

const formatTime = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)

const intervalOverlaps = (
  start: Date,
  end: Date,
  busyStart: string,
  busyEnd: string
) => {
  const existingStart = new Date(busyStart)
  const existingEnd = new Date(busyEnd)

  return existingStart < end && existingEnd > start
}

const appointmentEnd = (appointment: CalendarAppointment) => {
  if (appointment.appointment_end_time) {
    return appointment.appointment_end_time
  }

  return new Date(
    new Date(appointment.appointment_time).getTime() +
      Math.max(appointment.duration_minutes || 30, 1) * 60_000
  ).toISOString()
}

const timeToMinutes = (value: string) => {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number)
  return hour * 60 + minute
}

const minutesToTime = (minutes: number) => {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

const findEmployee = (
  employees: CalendarEmployee[],
  employeeName?: string | null
) => {
  if (!employeeName?.trim()) return employees

  const query = employeeName.trim().toLowerCase()
  const exact = employees.find(
    (employee) => employee.name.trim().toLowerCase() === query
  )

  if (exact) return [exact]

  return employees.filter((employee) =>
    employee.name.toLowerCase().includes(query)
  )
}

export const getClientCalendar = async ({
  supabase,
  clientId,
  date,
}: {
  supabase: SupabaseClient
  clientId: string
  date: string
}) => {
  const calendarDate = normalizeCalendarDate(date)
  const [agentResult, employeeResult, clientResult] = await Promise.all([
    supabase
      .from('agents')
      .select('business_hours')
      .eq('client_id', clientId)
      .maybeSingle(),
    supabase
      .from('employees')
      .select('id, name, role, email, is_active')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true }),
    supabase
      .from('clients')
      .select('company_name, contact_email')
      .eq('id', clientId)
      .maybeSingle(),
  ])

  if (agentResult.error) throw agentResult.error
  if (employeeResult.error) throw employeeResult.error
  if (clientResult.error) throw clientResult.error

  const schedule = getStoredBusinessSchedule(
    agentResult.data?.business_hours ?? null
  )
  const dayStart = localDateTimeToUtc(
    calendarDate,
    '00:00',
    schedule.timeZone
  )
  const dayEnd = localDateTimeToUtc(
    addDays(calendarDate, 1),
    '00:00',
    schedule.timeZone
  )
  const appointmentQueryStart = new Date(
    dayStart.getTime() - 8 * 60 * 60 * 1000
  )
  const employees = (employeeResult.data ?? []) as CalendarEmployee[]
  const employeeIds = employees.map((employee) => employee.id)
  let employeeSchedules: EmployeeSchedule[] = []
  let appointments: CalendarAppointment[] = []
  let blocks: CalendarBlock[] = []

  if (employeeIds.length > 0) {
    const [scheduleResult, appointmentResult, blockResult] =
      await Promise.all([
        supabase
          .from('employee_schedules')
          .select(
            'employee_id, day_of_week, is_working, start_time, end_time'
          )
          .in('employee_id', employeeIds),
        supabase
          .from('appointments')
          .select(
            'id, employee_id, customer_name, customer_phone, customer_email, company_name, service, notes, internal_notes, appointment_time, appointment_end_time, duration_minutes, status, source'
          )
          .eq('client_id', clientId)
          .gte('appointment_time', appointmentQueryStart.toISOString())
          .lt('appointment_time', dayEnd.toISOString())
          .order('appointment_time', { ascending: true }),
        supabase
          .from('employee_calendar_blocks')
          .select(
            'id, employee_id, title, details, block_type, starts_at, ends_at'
          )
          .eq('client_id', clientId)
          .lt('starts_at', dayEnd.toISOString())
          .gt('ends_at', dayStart.toISOString())
          .order('starts_at', { ascending: true }),
      ])

    if (scheduleResult.error) throw scheduleResult.error
    if (appointmentResult.error) throw appointmentResult.error
    if (blockResult.error) throw blockResult.error

    employeeSchedules = (scheduleResult.data ?? []) as EmployeeSchedule[]
    appointments = (
      (appointmentResult.data ?? []) as CalendarAppointment[]
    ).filter(
      (appointment) =>
        new Date(appointmentEnd(appointment)) > dayStart
    )
    blocks = (blockResult.data ?? []) as CalendarBlock[]
  }

  return {
    date: calendarDate,
    timeZone: schedule.timeZone,
    businessSchedule: schedule,
    business: clientResult.data,
    employees,
    employeeSchedules,
    appointments,
    blocks,
  }
}

export const findAvailableSlots = async ({
  supabase,
  clientId,
  date,
  employeeName,
  durationMinutes,
  preferredTime,
  limit = 6,
}: {
  supabase: SupabaseClient
  clientId: string
  date: string
  employeeName?: string | null
  durationMinutes: number
  preferredTime?: string | null
  limit?: number
}) => {
  const duration = normalizeDuration(durationMinutes)
  const calendar = await getClientCalendar({
    supabase,
    clientId,
    date,
  })
  const activeEmployees = calendar.employees.filter(
    (employee) => employee.is_active
  )
  const matchingEmployees = findEmployee(activeEmployees, employeeName)

  if (employeeName?.trim() && matchingEmployees.length === 0) {
    throw new Error(`No active employee matches “${employeeName.trim()}”.`)
  }

  const [year, month, day] = calendar.date.split('-').map(Number)
  const dayOfWeek = new Date(
    Date.UTC(year, month - 1, day, 12)
  ).getUTCDay()
  const dayName = DAY_NAMES[dayOfWeek]
  const storeDay = calendar.businessSchedule.hours.find(
    (item) => item.day === dayName
  )
  const slots: AvailableSlot[] = []

  for (const employee of matchingEmployees) {
    const employeeDay = calendar.employeeSchedules.find(
      (item) =>
        item.employee_id === employee.id &&
        item.day_of_week === dayOfWeek
    )

    if (
      !employeeDay?.is_working ||
      !employeeDay.start_time ||
      !employeeDay.end_time
    ) {
      continue
    }

    let windowStart = timeToMinutes(employeeDay.start_time)
    let windowEnd = timeToMinutes(employeeDay.end_time)

    if (windowEnd <= windowStart) windowEnd += 1440

    if (calendar.businessSchedule.mode === 'custom') {
      if (!storeDay?.open) continue

      const storeStart = timeToMinutes(storeDay.start)
      let storeEnd = timeToMinutes(storeDay.end)

      if (storeEnd <= storeStart) storeEnd += 1440

      windowStart = Math.max(windowStart, storeStart)
      windowEnd = Math.min(windowEnd, storeEnd)
    }

    if (windowEnd - windowStart < duration) continue

    const candidates: number[] = []

    if (preferredTime) {
      candidates.push(timeToMinutes(normalizeCalendarTime(preferredTime)))
    }

    for (
      let startMinutes = Math.ceil(windowStart / 30) * 30;
      startMinutes + duration <= windowEnd;
      startMinutes += 30
    ) {
      if (!candidates.includes(startMinutes)) candidates.push(startMinutes)
    }

    for (const startMinutes of candidates) {
      if (
        startMinutes < windowStart ||
        startMinutes + duration > windowEnd
      ) {
        continue
      }

      const slotDate =
        startMinutes >= 1440 ? addDays(calendar.date, 1) : calendar.date
      const start = localDateTimeToUtc(
        slotDate,
        minutesToTime(startMinutes),
        calendar.timeZone
      )
      const end = new Date(start.getTime() + duration * 60_000)

      if (start <= new Date()) continue

      const busyAppointment = calendar.appointments.some(
        (appointment) =>
          appointment.employee_id === employee.id &&
          appointment.status === 'booked' &&
          intervalOverlaps(
            start,
            end,
            appointment.appointment_time,
            appointmentEnd(appointment)
          )
      )
      const busyBlock = calendar.blocks.some(
        (block) =>
          block.employee_id === employee.id &&
          intervalOverlaps(start, end, block.starts_at, block.ends_at)
      )

      if (!busyAppointment && !busyBlock) {
        slots.push({
          employeeId: employee.id,
          employeeName: employee.name,
          employeeRole: employee.role,
          start: start.toISOString(),
          end: end.toISOString(),
          display: `${employee.name} — ${formatTime(
            start,
            calendar.timeZone
          )}`,
        })
      }
    }
  }

  const unique = Array.from(
    new Map(
      slots.map((slot) => [
        `${slot.employeeId}:${slot.start}`,
        slot,
      ])
    ).values()
  )

  unique.sort((left, right) => left.start.localeCompare(right.start))

  return {
    ...calendar,
    slots: unique.slice(0, Math.max(1, Math.min(limit, 20))),
  }
}

export const assertExactSlotAvailable = async ({
  supabase,
  clientId,
  employeeId,
  date,
  time,
  durationMinutes,
}: {
  supabase: SupabaseClient
  clientId: string
  employeeId: string
  date: string
  time: string
  durationMinutes: number
}) => {
  const calendar = await getClientCalendar({ supabase, clientId, date })
  const employee = calendar.employees.find(
    (item) => item.id === employeeId && item.is_active
  )

  if (!employee) {
    throw new Error('The selected employee is not active.')
  }

  const result = await findAvailableSlots({
    supabase,
    clientId,
    date,
    employeeName: employee.name,
    durationMinutes,
    preferredTime: time,
    limit: 20,
  })
  const expectedStart = localDateTimeToUtc(
    date,
    time,
    result.timeZone
  ).toISOString()
  const available = result.slots.find(
    (slot) =>
      slot.employeeId === employeeId && slot.start === expectedStart
  )

  if (!available) {
    throw new Error(
      `${employee.name} is not available at that time. Check availability again.`
    )
  }

  return {
    employee,
    start: expectedStart,
    end: available.end,
    timeZone: result.timeZone,
    business: result.business,
  }
}
