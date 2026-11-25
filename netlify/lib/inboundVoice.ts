import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { getStoredBusinessSchedule } from './employeeSchedule'
import { isBusinessOpen } from './businessHours'
import type { VoiceDeployment } from './voiceEnvironment'

export const voicePath = '/.netlify/functions/voice-inbound'
export const isCallSid = (value: string | null): value is string => /^CA[0-9a-f]{32}$/i.test(value ?? '')
export const isRecordingSid = (value: string | null): value is string => /^RE[0-9a-f]{32}$/i.test(value ?? '')
export const isUuid = (value: string | null): value is string =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')

export const readVoiceNumber = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 40 || !/^[+\d\s().-]+$/.test(value)) return null
  const phone = parsePhoneNumberFromString(value, 'CA')
  return phone?.isPossible() ? phone.number : null
}

export const readHumanNumber = (value: unknown) => {
  const number = readVoiceNumber(value)
  if (!number) return null
  const phone = parsePhoneNumberFromString(number)
  const type = phone?.getType()
  if (!phone?.isValid() || !['CA', 'US'].includes(phone.country ?? '') ||
      !type || !['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE', 'VOIP'].includes(type) ||
      phone.nationalNumber.slice(3, 6) === '976') return null
  return phone.number
}

export const usesAiReception = (hours: string | null, now = new Date()) => {
  const schedule = getStoredBusinessSchedule(hours)
  return schedule.answeringMode !== 'business_hours' || isBusinessOpen(schedule, now)
}

export const twilioVoiceRequest = (deployment: VoiceDeployment, path: string, options: RequestInit = {}) =>
  fetch(`https://api.twilio.com/2010-04-01/Accounts/${deployment.account}/${path}`, {
    ...options,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${deployment.account}:${deployment.token}`).toString('base64'),
      ...options.headers,
    },
    signal: AbortSignal.timeout(5000),
  })
