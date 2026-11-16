import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import './AdminRetellAgentPicker.css'

type TestGrant = {
  id: string
  expires_at: string
  revoked_at: string | null
  used_calls: number
  max_calls: number
  used_invocations: number
  max_invocations: number
}

export default function InternalAppointmentTestAccess({
  clientId, agentId,
}: { clientId: string; agentId: string | null }) {
  const [grants, setGrants] = useState<TestGrant[]>([])
  const [expiry, setExpiry] = useState('')
  const [maxCalls, setMaxCalls] = useState(3)
  const [maxInvocations, setMaxInvocations] = useState(15)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const endpoint = '/.netlify/functions/admin-appointment-test-entitlement'
  const authenticatedHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error('Admin sign-in is required.')
    return { Authorization: `Bearer ${session.access_token}` }
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!agentId) return
    try {
      const headers = await authenticatedHeaders()
      const query = new URLSearchParams({ clientId, agentId })
      const response = await fetch(endpoint + '?' + query, { headers, signal })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'Unable to check internal appointment access.')
      if (!signal?.aborted) setGrants(Array.isArray(data?.grants) ? data.grants : [])
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Unable to load test access.')
    }
  }, [agentId, clientId])

  useEffect(() => {
    const controller = new AbortController()
    setGrants([])
    setError('')
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const change = async (method: 'POST' | 'DELETE') => {
    if (!agentId) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const headers = await authenticatedHeaders()
      const body = method === 'POST'
        ? {
            clientId, agentId, expiresAt: new Date(expiry).toISOString(),
            maxCalls, maxInvocations,
          }
        : { clientId, agentId }
      const response = await fetch(endpoint, {
        method, headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || 'Internal test access could not be updated.')
      setMessage(method === 'POST'
        ? 'Internal appointment-only test access granted. No subscription or inbound call authorization was changed.'
        : 'Internal appointment test access revoked.')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Internal test access could not be updated.')
    } finally { setBusy(false) }
  }

  const active = grants.find(g => !g.revoked_at && Date.parse(g.expires_at) > Date.now())
  const expiryValid = Number.isFinite(Date.parse(expiry)) &&
    Date.parse(expiry) >= Date.now() + 15 * 60000 &&
    Date.parse(expiry) <= Date.now() + 48 * 3600000

  return <details className="adminEditFullWidth appointmentAdminPanel">
    <summary>Internal appointment QA access (admin only)</summary>
    <p>Temporary appointment-tool testing only. This does not activate Stripe billing, paid call admission, phone routing, or transfers. A new grant replaces any earlier active internal test grant.</p>
    <p><strong>Client:</strong> {clientId}</p>
    <p><strong>Assigned Retell agent:</strong> {agentId || 'Assign an agent first'}</p>
    {active
      ? <p role="status">Active until {new Date(active.expires_at).toLocaleString()} ·
        calls {active.used_calls}/{active.max_calls} ·
        tool invocations {active.used_invocations}/{active.max_invocations}</p>
      : <p>No active internal test grant for this client and agent.</p>}
    <label>Exact expiry (local time)
      <input type="datetime-local" value={expiry} onChange={e => setExpiry(e.target.value)} disabled={busy || !agentId} />
    </label>
    <label>Maximum distinct calls
      <select value={maxCalls} onChange={e => setMaxCalls(Number(e.target.value))} disabled={busy || !agentId}>
        {[1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    <label>Maximum appointment tool invocations
      <select value={maxInvocations} onChange={e => setMaxInvocations(Number(e.target.value))} disabled={busy || !agentId}>
        {[10, 15, 20, 30, 50].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button className="btn btnOutline" type="button" disabled={busy || !agentId || !expiryValid}
        onClick={() => void change('POST')}>Grant temporary test access</button>
      <button className="btn btnOutline" type="button" disabled={busy || !agentId || !active}
        onClick={() => void change('DELETE')}>Revoke now</button>
    </div>
    {error && <p role="alert" className="adminRetellNotice adminRetellNotice--error">{error}</p>}
    {message && <p role="status" className="adminRetellNotice adminRetellNotice--success">{message}</p>}
  </details>
}
