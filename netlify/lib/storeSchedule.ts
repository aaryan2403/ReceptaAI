import type { RetellOperatingDay } from './retell'

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

const isTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)

export const normalizeTimeZone = (value: unknown) => {
  const timeZone =
    typeof value === 'string' && value.trim()
      ? value.trim()
      : 'America/Toronto'

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return timeZone
  } catch {
    throw new Error('Select a valid business timezone.')
  }
}

export const normalizeHours = (value: unknown): RetellOperatingDay[] => {
  if (!Array.isArray(value) || value.length !== DAYS.length) {
    throw new Error('Custom hours are required for all seven days.')
  }

  return DAYS.map((day) => {
    const item = value.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        'day' in candidate &&
        candidate.day === day
    ) as Partial<RetellOperatingDay> | undefined

    if (
      !item ||
      typeof item.open !== 'boolean' ||
      !isTime(item.start) ||
      !isTime(item.end)
    ) {
      throw new Error(`Enter valid hours for ${day}.`)
    }

    if (item.open && item.start === item.end) {
      throw new Error(
        `${day}'s opening and closing times cannot be the same.`
      )
    }

    return {
      day,
      open: item.open,
      start: item.start,
      end: item.end,
    }
  })
}
