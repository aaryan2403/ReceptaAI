import { supabase } from './supabase'

export const callScheduling = async <T,>(clientId?: string, params: Record<string, string> = {}, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const query = new URLSearchParams(clientId ? { ...params, clientId } : params)
  const response = await fetch('/.netlify/functions/appointment-scheduling?' + query.toString(), {
    method,
    signal,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Appointment scheduling is unavailable.')
  return data
}
