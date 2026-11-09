export const EMAIL_FIELDS = {
  callerName: 'Caller name', callerNumber: 'Caller phone', callerEmail: 'Caller email',
  startedAt: 'Call date and time', duration: 'Call duration', outcome: 'Call outcome',
  summary: 'AI call summary', appointment: 'Appointment request / confirmed booking',
  custom: 'Custom details collected by the AI',
} as const
export type EmailField = keyof typeof EMAIL_FIELDS
export type CustomCallField = { label: string; analysisKey: string; owner: boolean; caller: boolean }
export type CallEmailSettings = {
  callerEnabled: boolean
  ownerFields: EmailField[]
  callerFields: EmailField[]
  customFields: string[] // Ordered label projection retained for existing agents and older admin tabs.
  customFieldOptions?: CustomCallField[]
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
  const options = new Map((Array.isArray(input.customFieldOptions) ? input.customFieldOptions : [])
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    .filter(row => typeof row.label === 'string')
    .map(row => [String(row.label).trim().toLowerCase(), row] as const))
  return {
    callerEnabled: input.callerEnabled === true,
    ownerFields: fields('ownerFields', ['callerName', 'callerNumber', 'callerEmail', 'startedAt', 'duration', 'outcome', 'summary', 'appointment', 'custom']),
    callerFields: fields('callerFields', ['callerName', 'startedAt', 'summary', 'appointment', 'custom']),
    customFields,
    customFieldOptions: customFields.map(label => {
      const option = options.get(label.toLowerCase())
      return { label, analysisKey: typeof option?.analysisKey === 'string' ? option.analysisKey.trim() : '',
        owner: option ? option.owner !== false : true, caller: option ? option.caller === true : true }
    }),
  }
}
export const customCallFields = (settings: CallEmailSettings): CustomCallField[] => settings.customFieldOptions
  ?? settings.customFields.map(label => ({ label, analysisKey: '', owner: true, caller: true }))
export const activeCallEmailSettings = (metadata?: Record<string, unknown>) => metadata?.recepta_call_email_sync_required === true
  ? metadata.recepta_call_email_active : metadata?.recepta_call_email_active ?? metadata?.recepta_call_email
export const isRetellFieldKey = (key: string) => key.length > 0 && key.length <= 100 && key === key.trim() && !Array.from(key).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  && !key.startsWith('recepta_caller_') && !['__proto__', 'constructor', 'prototype'].includes(key)
export const customCallFieldError = (fields: CustomCallField[]) => {
  if (fields.length > 20) return 'Use no more than 20 call detail fields.'
  if (fields.some(field => !field.label.trim() || field.label.trim().length > 60)) return 'Each field needs a name of 1–60 characters.'
  if (new Set(fields.map(field => field.label.trim().toLowerCase())).size !== fields.length) return 'Each call detail field needs a different name.'
  if (fields.some(field => field.analysisKey && !isRetellFieldKey(field.analysisKey))) return 'Choose a valid Retell extraction field.'
  const mapped = fields.filter(field => field.analysisKey).map(field => field.analysisKey)
  if (new Set(mapped).size !== mapped.length) return 'Use each existing Retell extraction field only once.'
  return null
}
export const capturedCallFields = (snapshot: unknown): Array<{ label: string; value: string }> => {
  if (!snapshot || typeof snapshot !== 'object') return []
  const rows = (snapshot as Record<string, unknown>).customDetails
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    .filter(row => typeof row.label === 'string' && typeof row.value === 'string')
    .slice(0, 20).map(row => ({ label: String(row.label).slice(0, 60), value: String(row.value).slice(0, 2000) }))
}
export const isEmailAddress = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())
