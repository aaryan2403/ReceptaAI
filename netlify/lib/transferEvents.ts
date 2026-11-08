import { getRetellApiKey } from './retellEnvironment'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const TRANSFER_EVENTS = new Set(['transfer_started', 'transfer_bridged', 'transfer_cancelled', 'transfer_ended'])
export const storeTransferEvent = async (db: SupabaseClient, payload: {
  event?: string
  start_timestamp?: number
  transfer_destination?: unknown
  call?: { call_id?: string; agent_id?: string; start_timestamp?: number }
}) => {
  const callId = payload.call?.call_id
  if (!callId || !/^[-\w]{1,160}$/.test(callId) || !TRANSFER_EVENTS.has(payload.event ?? '')) return new Response(null, { status: 400 })
  // Some transfer webhooks contain only a call ID. Retrieve the canonical call,
  // never trust an incoming customer ID or an arbitrary destination as ownership.
  let agentId = payload.call?.agent_id
  if (!agentId) {
    const response = await fetch('https://api.retellai.com/v2/get-call/' + encodeURIComponent(callId), {
      headers: { Authorization: 'Bearer ' + getRetellApiKey() }, signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return new Response(null, { status: 503 })
    const call = await response.json()
    if (call.call_id !== callId) return new Response(null, { status: 409 })
    agentId = call.agent_id
  }
  if (!agentId) return new Response(null, { status: 400 })
  const owner = await db.from('agents').select('client_id').eq('retell_agent_id', agentId).maybeSingle()
  if (owner.error || !owner.data?.client_id) return new Response(null, { status: 409 })
  const eventKey = createHash('sha256').update(JSON.stringify([
    callId, payload.event, payload.start_timestamp ?? payload.call?.start_timestamp ?? null, payload.transfer_destination ?? null,
  ])).digest('hex')
  const saved = await db.from('call_transfer_events').upsert({ event_key: eventKey, client_id: owner.data.client_id,
    retell_call_id: callId, event: payload.event }, { onConflict: 'event_key', ignoreDuplicates: true })
  // Transfer notifications never change lifecycle rank, duration, appointments,
  // minute reservations, or delivery state. Retries cannot regress a finished call.
  return new Response(null, { status: saved.error ? 503 : 204 })
}
