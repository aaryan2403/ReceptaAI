import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import './AdminRetellAgentPicker.css'

type AvailableAgent = { id: string; name: string; suspended: boolean; transferOnly: boolean }

export default function AdminRetellAgentPicker({ agentId, onSelect, disabled = false }: {
  agentId: string
  onSelect: (id: string) => void
  disabled?: boolean
}) {
  const [agents, setAgents] = useState<AvailableAgent[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState('')
  const [checkedFor, setCheckedFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)

  const check = async (loadMore = false, browse = false) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    const checkId = !loadMore && !browse ? agentId.trim() : ''
    setCheckedFor(checkId || null)
    if (!loadMore) { setAgents([]); setCheckedAt(''); setNextCursor(null) }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Admin session expired. Sign in again.')
      const query = loadMore && nextCursor
        ? `?cursor=${encodeURIComponent(nextCursor)}`
        : checkId ? `?agentId=${encodeURIComponent(checkId)}` : ''
      const response = await fetch(`/.netlify/functions/admin-retell-agents${query}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not check the Retell connection.')
      if (!Array.isArray(result.agents) || typeof result.checkedAt !== 'string') {
        throw new Error('The connection check returned an unexpected response. Refresh Recepta and try again.')
      }
      setAgents(previous => Array.from(new Map(
        [...(loadMore ? previous : []), ...result.agents].map(agent => [agent.id, agent])
      ).values()))
      setNextCursor(result.nextCursor ?? null)
      setCheckedAt(result.checkedAt)
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : 'Connection check timed out. Try again.')
    } finally { busy.current = false; setLoading(false) }
  }

  const match = agents.find(agent => agent.id === agentId.trim())
  const unavailable = Boolean(checkedAt && agentId.trim() && !match && !nextCursor)
  const current = checkedFor === null || checkedFor === agentId.trim()

  return <div className="adminRetellPicker">
    <div className="adminRetellPickerHeader">
      <div><strong>Find your Retell agent</strong><p>{agentId.trim() ? 'Check the entered Agent ID directly with Recepta’s server key, or browse accessible agents.' : 'Check which agents Recepta can access, then select yours.'}</p></div>
      <button type="button" className="btn btnOutline" disabled={disabled || loading} onClick={() => void check()}>
        {loading ? 'Checking Retell…' : checkedAt ? 'Refresh Retell connection' : 'Check Retell connection'}
      </button>
    </div>
    {agentId.trim() && <button type="button" className="btn btnOutline" disabled={disabled || loading} onClick={() => void check(false, true)}>Browse available agents</button>}
    {error && current && <p role="alert" className="adminRetellNotice adminRetellNotice--error">{error}</p>}
    {checkedAt && current && <>
      <p role="status" className={`adminRetellNotice ${unavailable || !agents.length ? 'adminRetellNotice--warning' : 'adminRetellNotice--success'}`}>
        {!agents.length
          ? 'Retell accepted the server key, but returned no voice agents. Check the workspace that owns your receptionist. A deleted agent will not appear.'
          : unavailable
            ? 'Retell accepted the server key, but your entered Agent ID is not in its accessible voice agents. Select your agent below. If it is missing, check the agent’s workspace and Netlify’s RETELL_API_KEY, then redeploy.'
            : match
              ? `Agent found: ${match.name}. Access confirmed; saving still verifies and synchronizes the agent.`
              : `${agents.length} accessible voice agent${agents.length === 1 ? '' : 's'} loaded. Choose the correct receptionist below.`}
      </p>
      {agents.length > 0 && <label>
        <span>Accessible Retell agents</span>
        <select value={match ? match.id : ''} disabled={disabled || loading} onChange={event => onSelect(event.target.value)}>
          <option value="" disabled>Select your receptionist</option>
          {agents.map(agent => <option key={agent.id} value={agent.id} disabled={agent.suspended || agent.transferOnly}>
            {agent.name} · {agent.id}{agent.suspended ? ' · Suspended' : agent.transferOnly ? ' · Transfer agent only' : ''}
          </option>)}
        </select>
      </label>}
      {nextCursor && <button type="button" className="btn btnOutline" disabled={disabled || loading} onClick={() => void check(true)}>Load more agents</button>}
      <p className="adminRetellPickerFootnote">Checked {new Date(checkedAt).toLocaleTimeString()}. This checks access only; it does not activate calls or change agent settings.</p>
    </>}
  </div>
}
