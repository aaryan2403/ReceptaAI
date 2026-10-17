import type { RetellSchedule } from './retell'

export const getAnsweringMode = (stored?: string | null): '24/7' | 'business_hours' => {
  try { return JSON.parse(stored ?? '{}')?.answeringMode === 'business_hours' ? 'business_hours' : '24/7' }
  catch { return '24/7' }
}

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const minutes = (value: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

export const isBusinessOpen = (schedule: RetellSchedule, date = new Date()) => {
  if (schedule.mode === '24/7') return true
  if (schedule.mode === 'unconfigured') return false
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(part => [part.type, part.value]))
    const now = Number(values.hour) * 60 + Number(values.minute)
    const today = schedule.hours.find(day => day.day === values.weekday)
    if (today?.open) {
      const start = minutes(today.start), end = minutes(today.end)
      if ((end > start && now >= start && now < end) || (end < start && now >= start)) return true
    }
    const previous = schedule.hours.find(day => day.day === days[(days.indexOf(values.weekday) + 6) % 7])
    return Boolean(previous?.open && minutes(previous.end) < minutes(previous.start) && now < minutes(previous.end))
  } catch { return false }
}
