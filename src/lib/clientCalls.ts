import { supabase } from './supabase'

export type ClientCallRecord = {
  id: string
  retell_call_id?: string | null
  caller_name: string | null
  caller_number: string | null
  started_at: string
  duration_seconds: number
  outcome: string | null
  summary: string | null
  appointment_booked: boolean
  call_status: string | null
  transcript: string | null
  recording_url: string | null
}

export type ClientCallsResult = {
  calls: ClientCallRecord[]
  activeCalls: number
  scheduleMode: '24/7' | 'custom' | null
  scheduleEnabled: boolean | null
  warning: string | null
}

type ClientCallsResponse = {
  calls?: ClientCallRecord[]
  activeCalls?: number
  scheduleMode?: '24/7' | 'custom' | null
  scheduleEnabled?: boolean | null
  storageWarning?: string | null
  integrationWarning?: string | null
  error?: string
}

export const fetchClientCalls = async (): Promise<ClientCallsResult> => {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Please sign in again.')
  }

  const response = await fetch(
    '/.netlify/functions/client-calls',
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    }
  )

  const body = (await response.json()) as ClientCallsResponse

  if (!response.ok && !Array.isArray(body.calls)) {
    throw new Error(body.error || 'Could not load Retell calls.')
  }

  const calls = Array.isArray(body.calls) ? body.calls : []

  return {
    calls,
    activeCalls:
      typeof body.activeCalls === 'number'
        ? body.activeCalls
        : calls.filter(
            (call) =>
              call.call_status === 'ongoing' ||
              call.call_status === 'registered'
          ).length,
    scheduleMode:
      body.scheduleMode === '24/7' ||
      body.scheduleMode === 'custom'
        ? body.scheduleMode
        : typeof body.scheduleEnabled === 'boolean'
          ? body.scheduleEnabled
            ? 'custom'
            : '24/7'
          : null,
    scheduleEnabled:
      typeof body.scheduleEnabled === 'boolean'
        ? body.scheduleEnabled
        : null,
    warning:
      body.storageWarning ||
      body.integrationWarning ||
      body.error ||
      null,
  }
}

export const saveSchedulePreference = async (
  scheduleMode: '24/7' | 'custom',
  options?: {
    operatingHours?: Array<{
      day: string
      open: boolean
      start: string
      end: string
    }>
    timeZone?: string
  }
) => {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Please sign in again.')
  }

  const response = await fetch(
    '/.netlify/functions/update-call-preferences',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scheduleMode,
        operatingHours: options?.operatingHours,
        timeZone: options?.timeZone,
      }),
    }
  )

  const body = (await response.json()) as {
    error?: string
    scheduleMode?: '24/7' | 'custom'
    scheduleEnabled?: boolean
    businessHours?: string
    timeZone?: string
    retellSynced?: boolean
  }

  if (!response.ok) {
    throw new Error(
      body.error || 'Could not save the schedule preference.'
    )
  }

  return {
    scheduleMode:
      body.scheduleMode ??
      (body.scheduleEnabled ? 'custom' : '24/7'),
    businessHours: body.businessHours ?? null,
    timeZone: body.timeZone ?? null,
    retellSynced: body.retellSynced === true,
  }
}
