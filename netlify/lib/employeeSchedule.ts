import type {
  RetellOperatingDay,
  RetellSchedule,
} from './retell'

export type EmployeeScheduleEmployee = {
  id: string
  name: string
  role: string | null
  is_active: boolean
}

export type EmployeeScheduleRow = {
  employee_id: string
  day_of_week: number
  is_working: boolean
  start_time: string | null
  end_time: string | null
}

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const DEFAULT_OPERATING_HOURS: RetellOperatingDay[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
].map((day) => ({
  day,
  open: !['Saturday', 'Sunday'].includes(day),
  start: '09:00',
  end: '17:00',
}))

const formatTime = (value?: string | null) =>
  value?.slice(0, 5) || 'time not set'

export const getBusinessTimeZone = (
  businessHours?: string | null
) => {
  if (!businessHours) return 'America/Toronto'

  try {
    const parsed = JSON.parse(businessHours) as {
      timeZone?: unknown
    }

    return typeof parsed?.timeZone === 'string' &&
      parsed.timeZone.trim()
      ? parsed.timeZone.trim()
      : 'America/Toronto'
  } catch {
    return 'America/Toronto'
  }
}

export const getStoredBusinessSchedule = (
  businessHours?: string | null
): RetellSchedule => {
  const timeZone = getBusinessTimeZone(businessHours)
  const fallback: RetellSchedule = {
    mode: '24/7',
    timeZone,
    hours: DEFAULT_OPERATING_HOURS,
  }

  if (!businessHours) return fallback

  try {
    const parsed = JSON.parse(businessHours) as
      | RetellOperatingDay[]
      | Partial<RetellSchedule>
    const hours = Array.isArray(parsed) ? parsed : parsed.hours
    const mode = Array.isArray(parsed) ? 'custom' : parsed.mode

    if (mode === '24/7') return fallback

    if (
      mode !== 'custom' ||
      !Array.isArray(hours) ||
      hours.length !== 7
    ) {
      return fallback
    }

    return {
      mode: 'custom',
      timeZone,
      hours,
    }
  } catch {
    return fallback
  }
}

export const buildEmployeeScheduleContext = ({
  employees,
  schedules,
  timeZone,
}: {
  employees: EmployeeScheduleEmployee[]
  schedules: EmployeeScheduleRow[]
  timeZone: string
}) => {
  const activeEmployees = employees.filter(
    (employee) => employee.is_active
  )

  if (activeEmployees.length === 0) {
    return `Business timezone: ${timeZone}. No active employees are configured.`
  }

  const employeeLines = activeEmployees.map((employee) => {
    const employeeSchedule = schedules.filter(
      (schedule) => schedule.employee_id === employee.id
    )

    if (employeeSchedule.length === 0) {
      return `- ${employee.name}${
        employee.role ? ` (${employee.role})` : ''
      }: weekly hours have not been configured.`
    }

    const dayParts = DAYS.map((day, dayOfWeek) => {
      const schedule = employeeSchedule.find(
        (item) => item.day_of_week === dayOfWeek
      )

      if (!schedule?.is_working) {
        return `${day}: unavailable`
      }

      return `${day}: ${formatTime(
        schedule.start_time
      )}-${formatTime(schedule.end_time)}`
    })

    return `- ${employee.name}${
      employee.role ? ` (${employee.role})` : ''
    }: ${dayParts.join('; ')}.`
  })

  return [
    `Business timezone: ${timeZone}.`,
    'Current active employee availability:',
    ...employeeLines,
  ].join('\n')
}
