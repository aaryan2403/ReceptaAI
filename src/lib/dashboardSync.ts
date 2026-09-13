import { supabase } from './supabase'

type DashboardSyncResponse = {
  error?: string
  retellSynced?: boolean
  warning?: string | null
}

/**
 * Publishes the current dashboard context to the customer's assigned agent.
 * Appointments themselves remain live data served by the calendar tools, so
 * the agent always checks the current Supabase calendar before booking.
 */
export const syncDashboardContextWithRetell = async () => {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Please sign in again.')
  }

  const response = await fetch('/.netlify/functions/sync-dashboard-context', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  })

  const body = (await response.json()) as DashboardSyncResponse

  if (!response.ok || body.retellSynced !== true) {
    throw new Error(
      body.error || 'Could not synchronize the dashboard with the AI agent.'
    )
  }

  return true
}
