import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceDeployment } from './serviceAccess'

export const voiceDeployment = (request: Request) => {
  const { isolated, preview, previewOrigin, key } = serviceDeployment(request)
  if (!isolated) return null
  const account = (preview ? process.env.TWILIO_VOICE_STAGING_ACCOUNT_SID : process.env.TWILIO_VOICE_ACCOUNT_SID)?.trim()
  const token = (preview ? process.env.TWILIO_VOICE_STAGING_AUTH_TOKEN : process.env.TWILIO_VOICE_AUTH_TOKEN)?.trim()
  const stagingNumbers = (process.env.RECEPTA_STAGING_VOICE_NUMBERS ?? '').split(',').map(number => number.trim())
  // A deploy preview can only touch explicitly assigned test numbers in a separate account.
  if (!account || !/^AC[0-9a-f]{32}$/i.test(account) || !token ||
      (preview && (account === process.env.TWILIO_VOICE_ACCOUNT_SID?.trim() || account === process.env.TWILIO_ACCOUNT_SID?.trim() ||
        !stagingNumbers.some(number => /^\+[1-9][0-9]{7,14}$/.test(number))))) return null

  return { account, token, preview, previewOrigin, stagingNumbers, retellKey: key }
}

export type VoiceDeployment = NonNullable<ReturnType<typeof voiceDeployment>>

export const allowsVoiceNumber = (deployment: VoiceDeployment, number: string) =>
  !deployment.preview || deployment.stagingNumbers.includes(number)

export const voiceNumberKind = async (db: SupabaseClient, number: string) => {
  const { data, error } = await db.rpc('recepta_voice_number_kind', { p_number: number })
  if (error) throw error
  return data as 'ingress' | 'ai' | 'business' | null
}
