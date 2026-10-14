import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type DemoLink = { id: string; label: string; retell_agent_id: string; expires_at: string; max_attempts: number; attempts: number; revoked: boolean }

export default function AdminDemoLinks() {
  const [links, setLinks] = useState<DemoLink[]>([])
  const [label, setLabel] = useState('')
  const [agentId, setAgentId] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const message = `Here’s a quick Recepta AI receptionist demo: ${url}\nOpen it, allow your microphone, and try asking about opening hours, services, or making a pretend appointment request. Each conversation lasts up to 3 minutes. Let me know what you think!`

  const api = async (method: string, body?: unknown) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Please sign in again.')
    const response = await fetch('/.netlify/functions/admin-demo-links', {
      method, headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Could not manage demos.')
    return result
  }
  useEffect(() => {
    let active = true
    void api('GET').then(result => { if (active) setLinks(result.links) }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice(''); setUrl('')
    try {
      const result = await api('POST', { label, agentId })
      setUrl(result.url)
      setNotice('Created. Save the link or message now; the private link is shown only once.')
      const refreshed = await api('GET')
      setLinks(refreshed.links)
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create demo.') }
    finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    setBusy(true); setError('')
    try {
      await api('PATCH', { id })
      setLinks(current => current.map(link => link.id === id ? { ...link, revoked: true } : link))
      setNotice('Link revoked. New conversations cannot start; an existing call can finish its three minutes.')
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not revoke demo.') }
    finally { setBusy(false) }
  }
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied. Paste it into WhatsApp, email, or your message to the prospect.') }
    catch { setNotice('Select and copy the text below.') }
  }

  return <section className="adminPanel" id="demo-links">
    <div className="adminPanelHeading"><div>
      <span className="adminEyebrow">SALES DEMOS</span><h2>Send a voice demo</h2>
      <p>Publish a separate Retell prompt agent, paste its Agent ID, and copy a link for your prospect. No customer account or phone number needed.</p>
    </div></div>
    <p className="demoHint">Use sample business information. Remove booking, transfer and custom tools; only End Call is allowed. Each link lasts 7 days and allows 3 attempts of up to 3 minutes. Retell usage is billed to your workspace, separately from client minutes.</p>
    <form className="demoAdminForm" onSubmit={create}>
      <label>Demo name<input required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="Example: Dental receptionist demo" /></label>
      <label>Retell Agent ID<input required maxLength={120} value={agentId} onChange={event => setAgentId(event.target.value)} placeholder="Copy from your published demo agent" /></label>
      <button className="btn btnPrimary" disabled={busy} type="submit">{busy ? 'Working…' : 'Create demo link'}</button>
    </form>
    {error && <p className="adminFormMessage adminFormMessage--error" role="alert">{error}</p>}
    {notice && <p className="adminFormMessage adminFormMessage--success" role="status">{notice}</p>}
    {url && <div className="demoShareResult">
      <label>Demo link<input readOnly value={url} onFocus={event => event.target.select()} /></label>
      <div className="demoActions"><button type="button" className="btn btnPrimary" onClick={() => void copy(url)}>Copy link</button><button type="button" className="btn btnOutline" onClick={() => void copy(message)}>Copy message</button><a className="btn btnOutline" href={url} target="_blank" rel="noreferrer">Open demo</a></div>
      <label>Message to send<textarea readOnly rows={4} value={message} onFocus={event => event.target.select()} /></label>
    </div>}
    <div className="demoLinkList">{links.map(link => {
      const expired = Date.parse(link.expires_at) <= Date.now()
      return <div key={link.id} className="demoLinkRow"><div><strong>{link.label}</strong><p>{link.revoked ? 'Revoked' : expired ? 'Expired' : `${Math.max(0, link.max_attempts - link.attempts)} attempts left`} · Expires {new Date(link.expires_at).toLocaleDateString()}</p></div><button type="button" className="btn btnOutline" disabled={busy || link.revoked || expired} onClick={() => void revoke(link.id)}>Revoke link</button></div>
    })}</div>
  </section>
}
