export type OperatingDay = { day: string; open: boolean; start: string; end: string }
export type StoreHours = {
  mode: '24/7' | 'custom' | null
  answeringMode: '24/7' | 'business_hours'
  timeZone: string
  hours: OperatingDay[]
}

export const readStoreHours = (stored?: string | null): StoreHours => {
  const result: StoreHours = {
    mode: null, answeringMode: '24/7', timeZone: 'America/Toronto',
    hours: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
      .map(day => ({ day, open: !['Saturday', 'Sunday'].includes(day), start: '09:00', end: '17:00' })),
  }
  const value = stored?.trim()
  if (!value || value.toLowerCase() === 'not configured') return result
  if (['24/7', 'not required'].includes(value.toLowerCase())) return { ...result, mode: '24/7' }
  try {
    const parsed = JSON.parse(value)
    const hours = Array.isArray(parsed) ? parsed : parsed?.hours
    if (Array.isArray(hours) && hours.length === 7 && hours.every(day =>
      typeof day?.day === 'string' && typeof day.open === 'boolean' && typeof day.start === 'string' && typeof day.end === 'string')) {
      result.hours = hours
      result.mode = 'custom'
    }
    if (parsed?.mode === '24/7') result.mode = '24/7'
    if (parsed?.answeringMode === 'business_hours') result.answeringMode = 'business_hours'
    if (typeof parsed?.timeZone === 'string' && parsed.timeZone.trim()) result.timeZone = parsed.timeZone
  } catch { /* Unstructured hours stay unconfigured until an admin chooses them. */ }
  return result
}

export const storeHoursSummary = (stored?: string | null) => {
  const schedule = readStoreHours(stored)
  if (!schedule.mode) return 'Awaiting Recepta setup'
  if (schedule.mode === '24/7') return '24/7'
  const openDays = schedule.hours.filter(day => day.open)
  if (!openDays.length) return 'Closed all week'
  const first = openDays[0]
  return openDays.every(day => day.start === first.start && day.end === first.end)
    ? `${openDays.length} ${openDays.length === 1 ? 'day' : 'days'} · ${first.start}–${first.end}`
    : `${openDays.length} days configured`
}
