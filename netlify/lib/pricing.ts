export const MAX_MONTHLY_MINUTES =
  100_000_000

export const PII_REDACTION_PER_MINUTE_CAD =
  0.014

export const SAFETY_GUARDRAILS_PER_MINUTE_CAD =
  0.007

export const EXTRA_PHONE_NUMBER_MONTHLY_CAD =
  20

export const calculateMonthlyPriceCad = ({
  planName,
  monthlyMinutes,
  modelPricePerMinuteCad,
  piiRedactionEnabled,
  safetyGuardrailsEnabled,
  extraPhoneNumbers = 0,
}: {
  planName: 'Recepta Standard' | 'Recepta Pro'
  monthlyMinutes: number
  modelPricePerMinuteCad: number
  piiRedactionEnabled: boolean
  safetyGuardrailsEnabled: boolean
  extraPhoneNumbers?: number
}) => {
  const minutes = Math.floor(monthlyMinutes)
  const basePrice =
    planName === 'Recepta Pro' ? 300 : 200

  const total =
    basePrice +
    minutes * modelPricePerMinuteCad +
    (piiRedactionEnabled
      ? minutes *
        PII_REDACTION_PER_MINUTE_CAD
      : 0) +
    (safetyGuardrailsEnabled
      ? minutes *
        SAFETY_GUARDRAILS_PER_MINUTE_CAD
      : 0) +
    extraPhoneNumbers *
      EXTRA_PHONE_NUMBER_MONTHLY_CAD

  return Math.round(total * 100) / 100
}
