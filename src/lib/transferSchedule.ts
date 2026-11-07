export const transferDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export type TransferSchedule = {
  mode: '24/7' | 'business_hours' | 'custom'
  timeZone: string
  hours: Array<{ day: string; open: boolean; start: string; end: string }>
}
export const defaultTransferSchedule = (): TransferSchedule => ({
  mode: '24/7', timeZone: 'America/Toronto',
  hours: transferDays.map(day => ({ day, open: true, start: '09:00', end: '21:00' })),
})
export const normalizeTransferSchedule = (raw: unknown): TransferSchedule => {
  if (raw === undefined || raw === null) return defaultTransferSchedule()
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Choose valid transfer hours.')
  const value = raw as Record<string, unknown>
  if (!['24/7', 'business_hours', 'custom'].includes(String(value.mode))) throw new Error('Choose 24/7, business hours, or custom transfer hours.')
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 100 || !value.timeZone.includes('/')) throw new Error('Choose a local time zone, such as America/Toronto.')
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format() } catch { throw new Error('Choose a valid local time zone.') }
  const hours = value.hours
  if (!Array.isArray(hours) || hours.length !== 7) throw new Error('Configure all seven days of transfer hours.')
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  const normalized = transferDays.map(day => {
    const matches = hours.filter(row => row && row.day === day)
    if (matches.length !== 1) throw new Error('Configure each transfer day once.')
    const row = matches[0]
    if (typeof row.open !== 'boolean' || typeof row.start !== 'string' || typeof row.end !== 'string' || !time.test(row.start) || !time.test(row.end) || (row.open && row.start === row.end)) throw new Error('Use valid start and cutoff times. Choose 24/7 for all-day transfers.')
    return { day, open: row.open, start: row.start as string, end: row.end as string }
  })
  return { mode: value.mode as TransferSchedule['mode'], timeZone: value.timeZone, hours: normalized }
}
