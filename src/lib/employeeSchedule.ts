import { supabase } from './supabase'

export const syncEmployeeScheduleWithRetell = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Please sign in again.')
  }

  const response = await fetch(
    '/.netlify/functions/sync-employee-schedule',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    }
  )
  const body = (await response.json()) as {
    error?: string
    retellSynced?: boolean
  }

  if (!response.ok || body.retellSynced !== true) {
    throw new Error(
      body.error || 'Could not synchronize employee schedules with Retell.'
    )
  }

  return true
}
