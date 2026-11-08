export const EMAIL_FIELDS = {
  callerName: 'Caller name', callerNumber: 'Caller phone', callerEmail: 'Caller email',
  startedAt: 'Call date and time', duration: 'Call duration', outcome: 'Call outcome',
  summary: 'AI call summary', appointment: 'Appointment request / confirmed booking',
  custom: 'Custom details collected by the AI',
} as const
export type EmailField = keyof typeof EMAIL_FIELDS
export type CallEmailSettings = {
  callerEnabled: boolean
  ownerFields: EmailField[]
  callerFields: EmailField[]
  customFields: string[]
}
export const normalizeCallEmailSettings = (value: unknown): CallEmailSettings => {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const fields = (key: string, defaults: EmailField[]) => Array.isArray(input[key])
    ? [...new Set((input[key] as unknown[]).filter((item): item is EmailField => typeof item === 'string' && Object.hasOwn(EMAIL_FIELDS, item)))]
    : defaults
  const customFields = Array.isArray(input.customFields) ? [...new Map(input.customFields
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.replace(/[\r\n\t]/g, ' ').trim().slice(0, 60)).filter(Boolean)
    .map(item => [item.toLowerCase(), item])).values()].slice(0, 20) : []
  return {
    callerEnabled: input.callerEnabled === true,
    ownerFields: fields('ownerFields', ['callerName', 'callerNumber', 'callerEmail', 'startedAt', 'duration', 'outcome', 'summary', 'appointment', 'custom']),
    callerFields: fields('callerFields', ['callerName', 'startedAt', 'summary', 'appointment', 'custom']),
    customFields,
  }
}
export const isEmailAddress = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())
