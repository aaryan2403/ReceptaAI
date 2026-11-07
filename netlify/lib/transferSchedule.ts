import { normalizeTransferSchedule } from '../../src/lib/transferSchedule'
import { isBusinessOpen } from './businessHours'
import { getStoredBusinessSchedule } from './employeeSchedule'

// Retell's native transfer tool does not have a per-attempt authorization API.
// Only issue its destination when the ENTIRE enforced maximum call lifetime is
// inside permitted hours. Never end a call early to enforce a transfer cutoff.
export const transferWindowOpen = (raw: unknown, businessHours: string | null, seconds: number, now = new Date()) => {
  try {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) return false
    const setting = normalizeTransferSchedule(raw)
    const schedule = setting.mode === 'business_hours' ? getStoredBusinessSchedule(businessHours)
      : { ...setting, mode: setting.mode === '24/7' ? '24/7' as const : 'custom' as const }
    // Cover provider admission/answer setup latency as well as agent lifetime.
    // Retell inbound attempts time out after 10 seconds; successful retries
    // compute a fresh window. Keep a full minute of additional safety.
    const end = now.getTime() + (seconds + 60) * 1000
    if (!isBusinessOpen(schedule, now) || !isBusinessOpen(schedule, new Date(end))) return false
    // Check each local-minute boundary, including DST transitions and overnight
    // windows. Limits also prevent an untrusted duration from creating work.
    for (let at = Math.floor(now.getTime() / 60000) * 60000 + 60000; at < end; at += 60000) {
      if (!isBusinessOpen(schedule, new Date(at))) return false
    }
    return true
  } catch { return false }
}
