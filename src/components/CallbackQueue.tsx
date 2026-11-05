import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Callback = { id:string; caller_number:string|null; reason:string; status:string; created_at:string; caller_name?:string|null; request_details?:string|null; preferred_callback_time?:string|null; answered_call?:boolean }
const reasons:Record<string,string> = { human_callback:'Human callback requested', agent_unavailable:'Receptionist unavailable', outside_answering_hours:'Outside AI answering hours', allowance_unavailable:'Paid minutes unavailable or reserved by another call', admission_unavailable:'Temporary call admission problem' }

export default function CallbackQueue() {
  const [callbacks, setCallbacks] = useState<Callback[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<string|null>(null)
  const request = async (id?:string, status?:string) => {
    const { data:{ session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Please sign in again.')
    const response = await fetch('/.netlify/functions/callback-requests', {
      method:id ? 'PATCH' : 'GET', headers:{ Authorization:`Bearer ${session.access_token}`, 'Content-Type':'application/json' },
      ...(id ? { body:JSON.stringify({ id,status }) } : {}),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'Could not load callbacks.')
    setCallbacks(body.callbacks)
    setError('')
  }
  useEffect(() => {
    const load = () => request().catch(failure => setError(failure.message))
    void load()
    const timer = window.setInterval(load, 30000)
    return () => window.clearInterval(timer)
  }, [])
  const update = async (id:string,status:string) => {
    setSaving(id)
    try { await request(id,status) } catch(failure) { setError(failure instanceof Error ? failure.message : 'Could not update callback.') }
    finally { setSaving(null) }
  }
  return <section className="agentPanel" aria-label="Callback queue" style={{ marginBottom:24 }}>
    <span className="callsSectionLabel">FOLLOW-UP REQUIRED</span>
    <h2>Missed calls &amp; callbacks</h2>
    <p>Missed calls and requests for human follow-up appear here. Answered AI calls use your normal minutes. Hidden caller IDs require a callback number from the caller.</p>
    {error && <p role="alert">{error}</p>}
    {!callbacks.length && !error && <p>No missed calls waiting for follow-up.</p>}
    {callbacks.map(callback => <article key={callback.id} style={{ display:'flex', flexWrap:'wrap', gap:16, justifyContent:'space-between', padding:'16px 0', borderTop:'1px solid #333' }}>
      <div><strong>{callback.caller_number ? <a href={`tel:${callback.caller_number}`}>{callback.caller_number}</a> : 'Caller ID unavailable'}</strong><p>{callback.answered_call ? 'Human callback requested' : reasons[callback.reason] ?? 'Receptionist unavailable'} · {new Date(callback.created_at).toLocaleString()}</p>{callback.caller_name && <p>{callback.caller_name}</p>}{callback.request_details && <p>{callback.request_details}</p>}{callback.preferred_callback_time && <p>Preferred callback: {callback.preferred_callback_time}</p>}</div>
      <label><span>Follow-up status </span><select value={callback.status} disabled={saving===callback.id} onChange={event => void update(callback.id,event.target.value)}>
        <option value="pending">Pending callback</option><option value="contacted">Contacted</option><option value="resolved">Resolved</option><option value="unreachable">Unreachable</option>
      </select></label>
    </article>)}
  </section>
}
