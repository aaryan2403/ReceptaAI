import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { EMAIL_FIELDS, normalizeCallEmailSettings, type CallEmailSettings, type EmailField } from '../lib/callEmailSettings'

export default function AdminCallEmailSettings({ clientId }: { clientId: string }) {
  const [settings, setSettings] = useState<CallEmailSettings>(() => normalizeCallEmailSettings(null))
  const [ownerEmail, setOwnerEmail] = useState('')
  const [isPro, setIsPro] = useState(false)
  const [featureEnabled, setFeatureEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [previews, setPreviews] = useState<{ owner: { text: string }; caller: { text: string } } | null>(null)
  const [customText, setCustomText] = useState('')
  const api = async (method: string, body?: Record<string, unknown>) => {
    const { data } = await supabase.auth.getSession()
    const response = await fetch(`/.netlify/functions/admin-call-email?clientId=${encodeURIComponent(clientId)}`, {
      method, signal: AbortSignal.timeout(25_000), headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify({ ...body, clientId }) } : {}),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Email operation failed.')
    return result
  }
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data } = await supabase.auth.getSession()
        const response = await fetch(`/.netlify/functions/admin-call-email?clientId=${encodeURIComponent(clientId)}`, { signal: AbortSignal.timeout(25_000), headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` } })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load email settings.')
        if (cancelled) return
        const value = normalizeCallEmailSettings(result.settings)
        setSettings(value); setCustomText(value.customFields.join('\n')); setOwnerEmail(result.ownerEmail || 'Account email'); setIsPro(result.planName === 'Recepta Pro'); setLoaded(true); setFeatureEnabled(result.enabled === true)
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not load email settings.') }
    }
    void load()
    return () => { cancelled = true }
  }, [clientId])
  const action = async (kind: string, role?: string) => {
    setBusy(true); setError(''); setMessage(''); setPreviews(null)
    try {
      const value = normalizeCallEmailSettings({ ...settings, customFields: customText.split('\n') })
      const result = await api(kind === 'save' ? 'PUT' : 'POST', { action: kind, role, settings: value })
      if (kind === 'preview') setPreviews(result)
      else setMessage(result.message || 'Done.')
      if (kind === 'save') setSettings(normalizeCallEmailSettings(result.settings))
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Email operation failed.') }
    finally { setBusy(false) }
  }
  const toggle = (role: 'ownerFields' | 'callerFields', field: EmailField, checked: boolean) => setSettings(current => ({ ...current,
    [role]: checked ? [...current[role], field] : current[role].filter(item => item !== field),
  }))
  return <section className="adminNotificationPanel" style={{ gridColumn: '1 / -1' }} aria-label="Call email settings">
    <div className="adminNotificationHeading"><div><strong>Email notifications after each call</strong>
      <p>Choose each detail separately for this business and its callers. Owner emails stay on. Caller receipts start off until you enable them.</p></div><span>PER CLIENT</span></div>
    {loaded && !featureEnabled && <p role="status">Email controls are awaiting activation. You can preview emails, check Resend and send samples to your admin inbox.</p>}
    <p>Business owner: {ownerEmail}. Edit the client contact email above and save the client to change this destination.</p>
    <fieldset disabled={!loaded || busy} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 16 }}>
      <label style={{ display: 'flex', gap: 10 }}><input type="checkbox" style={{ width: 18, minHeight: 18, flexShrink: 0 }} checked={settings.callerEnabled} onChange={event => setSettings(current => ({ ...current, callerEnabled: event.target.checked }))} />Send the caller a receipt after the AI confirms their email address and agreement to receive it</label>
      <p>Standard receives basic call details. Pro adds summaries, appointment details and custom answers. Caller summaries exclude internal staff notes. PII redaction blocks caller receipts.</p>
      <div className="adminNotificationGrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}>{(['ownerFields', 'callerFields'] as const).map(role => <div key={role} style={{ display: 'grid', gap: 10 }}>
        <strong>{role === 'ownerFields' ? 'Business owner email contains' : 'Caller email contains'}</strong>
        {(Object.entries(EMAIL_FIELDS) as Array<[EmailField, string]>).map(([field, label]) => <label key={field} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={settings[role].includes(field)} disabled={!isPro && ['summary', 'appointment', 'custom'].includes(field)} onChange={event => toggle(role, field, event.target.checked)} />{label}
        </label>)}
      </div>)}</div>
      <label><span>Custom details — one question or field per line</span><textarea rows={5} value={customText} onChange={event => setCustomText(event.target.value)} placeholder={'Number of windows\nProperty address\nPreferred callback time'} /><small>Up to 20 fields. The AI asks one at a time when relevant. Pro emails list each captured answer separately; missing answers say “Not provided”.</small></label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button type="button" className="btn btnPrimary" disabled={!featureEnabled} onClick={() => void action('save')}>Save Email Settings &amp; Update Agent</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('preview')}>Preview Both Emails</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('check_provider')}>Check Resend Connection</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('send_test', 'owner')}>Test Owner Email to My Inbox</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('send_test', 'caller')}>Test Caller Email to My Inbox</button>
      </div>
    </fieldset>
    {busy && <p role="status">Working…</p>}{message && <p role="status">{message}</p>}{error && <p className="adminFormMessage adminFormMessage--error" role="alert">{error}</p>}
    {previews && <div className="adminNotificationGrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}>{(['owner', 'caller'] as const).map(role => <div key={role} style={{ display: 'block' }}><strong>{role === 'owner' ? 'Owner preview' : 'Caller preview'}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{previews[role].text}</pre></div>)}</div>}
  </section>
}
