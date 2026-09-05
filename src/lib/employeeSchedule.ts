import { supabase } from './supabase'

export type EmployeeScheduleSyncPayload = {
  employeeId: string
  schedules: Array<{
    dayOfWeek: number
    isWorking: boolean
    startTime: string | null
    endTime: string | null
  }>
}

export const syncEmployeeScheduleWithRetell = async (
  payload?: EmployeeScheduleSyncPayload
) => {
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
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
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
