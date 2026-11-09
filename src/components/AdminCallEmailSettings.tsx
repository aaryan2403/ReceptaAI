import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { normalizeCallEmailSettings, customCallFields, customCallFieldError, type CallEmailSettings, type CustomCallField } from '../lib/callEmailSettings'
import './AdminCallEmailSettings.css'

export default function AdminCallEmailSettings({ clientId }: { clientId: string }) {
  const [settings, setSettings] = useState<CallEmailSettings>(() => normalizeCallEmailSettings(null))
  const [ownerEmail, setOwnerEmail] = useState('')
  const [isPro, setIsPro] = useState(false)
  const [featureEnabled, setFeatureEnabled] = useState(false)
  const [needsSync, setNeedsSync] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [previews, setPreviews] = useState<{ owner: { text: string }; caller: { text: string } } | null>(null)
  const [customFields, setCustomFields] = useState<CustomCallField[]>([])
  const [newField, setNewField] = useState('')
  const [availableFields, setAvailableFields] = useState<Array<{ key: string; label: string; type: string }>>([])
  const [importKey, setImportKey] = useState('')
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
        setSettings({ ...value, contentMode: 'custom' }); setCustomFields(customCallFields(value).map(field => ({ ...field, owner: field.owner && value.ownerFields.includes('custom'), caller: field.caller && value.callerFields.includes('custom') }))); setOwnerEmail(result.ownerEmail || 'Account email'); setIsPro(result.planName === 'Recepta Pro'); setLoaded(true); setFeatureEnabled(result.enabled === true); setNeedsSync(result.needsSync === true)
      } catch (failure) { if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not load email settings.') }
    }
    void load()
    return () => { cancelled = true }
  }, [clientId])
  const action = async (kind: string, role?: string) => {
    setBusy(true); setError(''); setMessage(''); setPreviews(null)
    try {
      if (kind === 'load_agent_fields') {
        const result = await api('POST', { action: kind })
        setAvailableFields(result.availableFields ?? []); setMessage(result.message); return
      }
      const problem = customCallFieldError(customFields)
      if (problem) throw new Error(problem)
      const value = normalizeCallEmailSettings({ ...settings, contentMode: 'custom', customFields: customFields.map(field => field.label), customFieldOptions: customFields,
        ownerFields: customFields.some(field => field.owner) ? ['custom'] : [],
        callerFields: customFields.some(field => field.caller) ? ['custom'] : [] })
      const result = await api(kind === 'save' ? 'PUT' : 'POST', { action: kind, role, settings: value })
      if (kind === 'preview') setPreviews(result)
      else setMessage(result.message || 'Done.')
      if (kind === 'save') { const saved = normalizeCallEmailSettings(result.settings); setSettings(saved); setCustomFields(customCallFields(saved)); setNeedsSync(result.synced !== true) }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Email operation failed.') }
    finally { setBusy(false) }
  }
  const changeMessage = (role: 'ownerMessage' | 'callerMessage', message: string) => {
    setPreviews(null)
    setSettings(current => ({ ...current, [role]: message }))
  }
  const addField = (field: CustomCallField) => {
    const next = [...customFields, { ...field, label: field.label.trim() }]
    const problem = customCallFieldError(next)
    if (problem) { setError(problem); return }
    setCustomFields(next); setNewField(''); setImportKey(''); setError(''); setPreviews(null)
  }
  const changeField = (index: number, changes: Partial<CustomCallField>) => {
    setPreviews(null)
    setCustomFields(current => current.map((field, i) => i === index ? { ...field, ...changes } : field))
  }
  return <section className="adminNotificationPanel adminCallEmail" aria-label="Call email settings">
    <div className="adminNotificationHeading"><div><strong>Email notifications after each call</strong>
      <p>Write each opening message, then add only the fields you want. Your message appears first in that email.</p></div><span>PER CLIENT</span></div>
    {loaded && !featureEnabled && <p className="adminCallEmailStatus" role="status">Previews and test emails are available. Automatic call customization awaits activation; save again afterward to update the AI.</p>}
    {loaded && featureEnabled && needsSync && <p className="adminCallEmailStatus" role="status">Saved changes are awaiting agent sync. Save and update the agent to activate them. Calls continue using the last synchronized settings.</p>}
    <p className="adminCallEmailDestination"><strong>Business email destination:</strong> {ownerEmail}. Change this destination by saving the client contact email above.</p>
    <fieldset disabled={!loaded || busy} className="adminCallEmailControls">
      <div className="adminCallEmailColumns adminEmailMessages">
        <label className="adminCallEmailCustom"><span>Business email opening message</span><textarea rows={5} maxLength={4000} value={settings.ownerMessage ?? ''} onChange={event => changeMessage('ownerMessage', event.target.value)} /><small>This appears before the fields selected for the business email.</small></label>
        <label className="adminCallEmailCustom"><span>Caller email opening message</span><textarea rows={5} maxLength={4000} value={settings.callerMessage ?? ''} onChange={event => changeMessage('callerMessage', event.target.value)} /><small>This appears before the fields selected for the caller email.</small></label>
      </div>
      <label className="adminCallEmailChoice"><input type="checkbox" checked={settings.callerEnabled} onChange={event => { setPreviews(null); setSettings(current => ({ ...current, callerEnabled: event.target.checked })) }} /><span>Send the caller a receipt after the AI confirms their email address and agreement to receive it</span></label>
      <div className="adminCustomFields">
        <div className="adminCustomFieldsHeading"><div><strong>Call detail fields</strong><p>Add fields in the order you want them shown. Choose which email receives each field.</p></div><span>{customFields.length}/20</span></div>
        <div className="adminCustomFieldAdd"><label><span>New field name</span><input value={newField} maxLength={60} onChange={event => setNewField(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (newField.trim()) addField({ label: newField, analysisKey: '', owner: false, caller: false }) } }} /></label>
          <button type="button" className="btn btnOutline" disabled={!newField.trim() || customFields.length >= 20} onClick={() => addField({ label: newField, analysisKey: '', owner: false, caller: false })}>Add field</button></div>
        <div className="adminCustomFieldImport"><button type="button" className="btn btnOutline" onClick={() => void action('load_agent_fields')}>Load existing Retell fields</button><small>Already set up extraction in Retell? Load its published fields to reuse their names and extraction rules.</small></div>
        {availableFields.length > 0 && <div className="adminCustomFieldAdd"><label><span>Existing Retell extraction field</span><select value={importKey} onChange={event => setImportKey(event.target.value)}><option value="">Choose an existing field</option>{availableFields.map(field => <option key={field.key} value={field.key} disabled={customFields.some(row => row.analysisKey === field.key)}>{field.key} · {field.type}</option>)}</select></label><button type="button" className="btn btnOutline" disabled={!importKey || customFields.length >= 20} onClick={() => { const field = availableFields.find(field => field.key === importKey); if (field) addField({ label: field.label, analysisKey: field.key, owner: false, caller: false }) }}>Add existing field</button></div>}
        {customFields.length === 0 && <p className="adminCallEmailHelp">No fields added.</p>}
        {customFields.map((field, index) => <div className="adminCustomFieldRow" key={index}>
          <label><span>Field name</span><input aria-label={`Field name ${index + 1}`} maxLength={60} value={field.label} onChange={event => changeField(index, { label: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} /></label>
          <label><span>Retell extraction</span><select aria-label={`Retell extraction ${index + 1}`} value={field.analysisKey} onChange={event => changeField(index, { analysisKey: event.target.value })}><option value="">Create from this field name</option>{field.analysisKey && !availableFields.some(item => item.key === field.analysisKey) && <option value={field.analysisKey}>{field.analysisKey} · saved mapping</option>}{availableFields.map(item => <option key={item.key} value={item.key} disabled={customFields.some((row, i) => i !== index && row.analysisKey === item.key)}>{item.key} · {item.type}</option>)}</select></label>
          <div className="adminCustomFieldRecipients"><label className="adminCallEmailChoice"><input type="checkbox" aria-label={`Include ${field.label || 'field'} in business email`} checked={field.owner} disabled={!isPro} onChange={event => changeField(index, { owner: event.target.checked })} /><span>Business email</span></label><label className="adminCallEmailChoice"><input type="checkbox" aria-label={`Include ${field.label || 'field'} in caller receipt`} checked={field.caller} disabled={!isPro} onChange={event => changeField(index, { caller: event.target.checked })} /><span>Caller receipt</span></label></div>
          <button type="button" className="btn btnOutline" aria-label={`Remove field ${field.label || index + 1}`} onClick={() => { setPreviews(null); setCustomFields(current => current.filter((_, i) => i !== index)) }}>Remove</button>
        </div>)}
        <small>Field details require Pro. Select each destination yourself; new fields have neither selected. Caller receipts require a confirmed email address and consent. PII redaction blocks caller receipts.</small>
      </div>
      <div className="adminCallEmailActions">
        <button type="button" className="btn btnPrimary" onClick={() => void action('save')}>{featureEnabled ? 'Save Email Settings & Update Agent' : 'Save Email Preferences'}</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('preview')}>Preview Both Emails</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('check_provider')}>Check Resend Connection</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('send_test', 'owner')}>Test Owner Email to My Inbox</button>
        <button type="button" className="btn btnOutline" onClick={() => void action('send_test', 'caller')}>Test Caller Email to My Inbox</button>
      </div>
    </fieldset>
    {busy && <p role="status">Working…</p>}{message && <p role="status">{message}</p>}{error && <p className="adminFormMessage adminFormMessage--error" role="alert">{error}</p>}
    {previews && <div className="adminCallEmailColumns">{(['owner', 'caller'] as const).map(role => <div key={role} className="adminCallEmailPreview"><strong>{role === 'owner' ? 'Owner preview' : 'Caller preview'}</strong><pre>{previews[role].text}</pre></div>)}</div>}
  </section>
}
