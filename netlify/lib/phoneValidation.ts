import { parsePhoneNumberFromString } from 'libphonenumber-js/max'

export class PhoneValidationError extends Error {}

export const normalizePhone = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 40 || !/^[+\d\s().-]+$/.test(value)) {
    throw new PhoneValidationError('Enter a US or Canadian phone number without extensions.')
  }
  const phone = parsePhoneNumberFromString(value, 'CA')
  if (!phone?.isValid() || !['CA', 'US'].includes(phone.country ?? '') ||
      ['PREMIUM_RATE', 'TOLL_FREE', 'SHARED_COST', 'PERSONAL_NUMBER'].includes(phone.getType() ?? '') ||
      phone.nationalNumber.slice(3, 6) === '976') {
    throw new PhoneValidationError('Use a standard direct US or Canadian number. International and premium destinations are not supported.')
  }
  return phone.number
}
