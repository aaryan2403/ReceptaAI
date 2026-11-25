import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Route = {
  ingress_number: string
  ai_number: string
  human_number: string
  business_number: string | null
}

const blankRoute = { ingress_number: '', ai_number: '', human_number: '', business_number: '' }
const fields = [
  ['ingress_number', 'Existing Twilio number'],
  ['ai_number', 'Assigned Retell number'],
  ['human_number', 'After-hours human number'],
  ['business_number', 'Original business number, if forwarding'],
] as const

async function requestRoutes(clientId: string, route?: Route, signal?: AbortSignal) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Please sign in again.')
  const response = await fetch('/.netlify/functions/admin-inbound-route?' + new URLSearchParams({ clientId }), {
    method: route ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: route ? JSON.stringify(route) : undefined,
    signal,
  })
  const data = await response.json() as { available?: boolean; routes?: Route[]; route?: Route; error?: string }
  if (!response.ok) throw new Error(data.error || 'Could not load inbound routing.')
  return data
}

export default function AdminInboundRouting({ clientId }: { clientId: string }) {
  const [routes, setRoutes] = useState<Route[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<Route>(blankRoute)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void requestRoutes(clientId, undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return
      const existing = data.routes ?? []
      setRoutes(existing)
      setAvailable(data.available === true)
      if (existing[0]) {
        setSelected(existing[0].ingress_number)
        setDraft(existing[0])
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load inbound routing.')
    })
    return () => controller.abort()
  }, [clientId])

  async function save() {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const { route } = await requestRoutes(clientId, draft)
      if (!route) throw new Error('Reload to check the routing setup.')
      setRoutes(current => [...current.filter(item => item.ingress_number !== route.ingress_number), route])
      setDraft(route)
      setSelected(route.ingress_number)
      setMessage('Number connected. Calls follow the saved AI answering hours.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save inbound routing.')
    } finally {
      setSaving(false)
    }
  }

  return <section className="adminNotificationPanel adminStoreHours adminEditFullWidth" aria-label="Inbound phone routing">
    <div className="adminNotificationHeading">
      <div>
        <strong>Inbound phone routing</strong>
        <p>Calls to a connected Twilio number follow the AI answering hours above. Outside those hours, the human phone rings and unanswered calls can leave voicemail.</p>
      </div>
    </div>
    {available === false && <p>Programmable Voice setup is pending for this deployment.</p>}
    {available === null && !error && <p role="status">Checking phone routing…</p>}
    {available && <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 12 }}>
      {routes.length > 0 && <label>
        <span>Routing line</span>
        <select value={selected} onChange={event => {
          setSelected(event.target.value)
          setDraft(routes.find(route => route.ingress_number === event.target.value) ?? blankRoute)
          setError('')
          setMessage('')
        }}>
          <option value="">Connect another existing number</option>
          {routes.map(route => <option key={route.ingress_number} value={route.ingress_number}>{route.ingress_number}</option>)}
        </select>
      </label>}
      {fields.map(([field, label]) => <label key={field}>
        <span>{label}</span>
        <input type="tel" value={draft[field] ?? ''} readOnly={field === 'ingress_number' && Boolean(selected)}
          onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))} />
      </label>)}
      <small>Use a direct human number that never forwards back to Recepta. If keeping the original business line, configure its carrier to forward to the Twilio number above.</small>
      <button type="button" className="btn btnPrimary" disabled={!draft.ingress_number || !draft.ai_number || !draft.human_number}
        onClick={() => void save()}>{saving ? 'Connecting…' : 'Save Phone Routing'}</button>
    </fieldset>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
