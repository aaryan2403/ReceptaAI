export const ROLLOVER_POLICY = 'Your monthly subscription renews automatically. Unused monthly minutes roll over for one additional billing cycle only. Rollover minutes are used first and expire at the next renewal. Renewal payment is required to use your minutes. Unused minutes are forfeited when your subscription ends.'

const seconds = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0))

export const calculateMinuteBalance = (input: {
  monthly_minutes: number | null
  rollover_seconds?: number | null
  status: string | null
  current_period_start?: string | null
  current_period_end?: string | null
}, usedSeconds: number, now = Date.now()) => {
  const monthlySeconds = seconds(input.monthly_minutes) * 60
  const rolloverSeconds = Math.min(seconds(input.rollover_seconds), monthlySeconds)
  const used = seconds(usedSeconds)
  const start = new Date(input.current_period_start ?? '').getTime()
  const end = new Date(input.current_period_end ?? '').getTime()
  const paid = input.status === 'active' && start <= now && end > now
  const rolloverRemaining = Math.max(0, rolloverSeconds - used)
  const monthlyRemaining = Math.max(0, monthlySeconds - Math.max(0, used - rolloverSeconds))
  return {
    paid,
    monthlySeconds,
    rolloverSeconds,
    totalSeconds: monthlySeconds + rolloverSeconds,
    usedSeconds: used,
    rolloverRemainingSeconds: rolloverRemaining,
    monthlyRemainingSeconds: monthlyRemaining,
    remainingSeconds: paid ? rolloverRemaining + monthlyRemaining : 0,
    nextRolloverSeconds: monthlyRemaining,
    usagePercent: monthlySeconds + rolloverSeconds > 0
      ? Math.min(100, used / (monthlySeconds + rolloverSeconds) * 100) : 0,
  }
}

export const formatMinuteSeconds = (value: number) =>
  (Math.max(0, value) / 60).toLocaleString('en-CA', { maximumFractionDigits: 1 })
