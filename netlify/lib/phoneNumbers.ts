import { normalizeE164 } from './retell'

export const isMissingAgentPhoneNumbersTable = (
  error: { code?: string; message?: string } | null | undefined
) =>
  error?.code === 'PGRST205' ||
  error?.code === '42P01' ||
  error?.message
    ?.toLowerCase()
    .includes('agent_phone_numbers') === true

export const MAX_TOTAL_PHONE_NUMBERS = 21

export const normalizePhoneNumberList = (value: unknown) => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : []
  const invalid: string[] = []
  const normalized = values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const phoneNumber = normalizeE164(item)

      if (!phoneNumber) invalid.push(item)
      return phoneNumber
    })
    .filter((item): item is string => Boolean(item))

  return {
    phoneNumbers: Array.from(new Set(normalized)),
    invalid,
  }
}

export const normalizePhonePurchase = ({
  count,
  countryCode,
  areaCode,
}: {
  count: unknown
  countryCode: unknown
  areaCode: unknown
}) => {
  const purchaseCount = Number(count ?? 0)

  if (
    !Number.isInteger(purchaseCount) ||
    purchaseCount < 0 ||
    purchaseCount > MAX_TOTAL_PHONE_NUMBERS
  ) {
    throw new Error(
      `Phone-number purchase quantity must be between 0 and ${MAX_TOTAL_PHONE_NUMBERS}.`
    )
  }

  const normalizedCountryCode =
    countryCode === 'US' ? 'US' : 'CA'
  const rawAreaCode =
    typeof areaCode === 'string' ? areaCode.trim() : ''

  if (
    normalizedCountryCode === 'US' &&
    rawAreaCode &&
    !/^\d{3}$/.test(rawAreaCode)
  ) {
    throw new Error('US area code must contain exactly three digits.')
  }

  return {
    purchaseCount,
    countryCode: normalizedCountryCode as 'CA' | 'US',
    areaCode:
      normalizedCountryCode === 'US' && rawAreaCode
        ? Number(rawAreaCode)
        : null,
  }
}
