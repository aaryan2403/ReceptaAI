import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const inputStyle = {
  width: '100%',
  background: '#111c18',
  color: '#f2f7f4',
  padding: '12px 14px',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
  marginTop: 8,
} as const

export default function CallTransferSettings() {
  const [transferPhone, setTransferPhone] = useState('')
  const [businessPhone, setBusinessPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let mounted = true
    supabase.auth.getUser().then(({ data }) => {
      if (!mounted) return
      setTransferPhone(data.user?.user_metadata?.recepta_transfer_phone_number ?? '')
      setBusinessPhone(data.user?.user_metadata?.recepta_existing_business_number ?? '')
      setLoaded(true)
    }).catch(() => {
      if (mounted) setLoaded(true)
    })
    return () => { mounted = false }
  }, [])

  const save = async () => {
    setError('')
    setMessage('')
    setSaving(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')

      const response = await fetch('/.netlify/functions/configure-call-transfer', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + session.access_token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transferPhoneNumber: transferPhone.trim() || null,
          existingBusinessNumber: businessPhone.trim() || null,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Could not update transfer settings.')
      setTransferPhone(payload.transferPhoneNumber ?? '')
      setBusinessPhone(payload.existingBusinessNumber ?? '')
      setMessage(payload.enabled
        ? 'Warm transfer configured in Retell. Call your Recepta number from another phone and ask for a human to verify it works.'
        : 'Human call transfer disabled in Retell.')
      await supabase.auth.refreshSession()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save transfer settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="agentPanel" aria-label="Call transfer configuration">
      <div className="agentPanelHeading">
        <div>
          <span className="agentSectionLabel">HUMAN HANDOFF</span>
          <h2>Transfer calls to a worker</h2>
          <p>
            When a caller needs a real person, Recepta can call a direct worker line,
            brief them privately, and connect the caller.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 18, maxWidth: 620 }}>
        <label style={{ display: 'block' }}>
          <strong>Worker or front desk direct number</strong>
          <input
            aria-label="Worker direct number"
            type="tel"
            autoComplete="tel"
            placeholder="+1 416 555 0123"
            value={transferPhone}
            onChange={(event) => setTransferPhone(event.target.value)}
            style={inputStyle}
            disabled={saving || !loaded}
          />
          <small style={{ display: 'block', opacity: 0.8, marginTop: 5 }}>
            Leave empty and save to disable transfers. US and Canadian numbers only for this first release.
          </small>
        </label>
        <label style={{ display: 'block' }}>
          <strong>Existing advertised business number (if forwarding calls)</strong>
          <input
            aria-label="Existing business phone number"
            type="tel"
            placeholder="+1 647 555 0199"
            value={businessPhone}
            onChange={(event) => setBusinessPhone(event.target.value)}
            style={inputStyle}
            disabled={saving || !loaded}
          />
          <small style={{ display: 'block', opacity: 0.8, marginTop: 5 }}>
            Enter the number customers originally call, if different from the Recepta number.
          </small>
        </label>
        <p style={{
          border: '1px solid rgba(245,185,66,.35)',
          borderRadius: 10,
          padding: 12,
          color: '#f5cd74',
          margin: 0,
        }}>
          Important: The transfer number must ring the worker directly. Never use a
          phone number that forwards back to Recepta — that can create a call loop.
          Only configure a number you own or are authorized to use.
        </p>
        {error && <p role="alert" style={{ color: '#ff9b86', margin: 0 }}>{error}</p>}
        {message && <p role="status" style={{ color: '#8aefb0', margin: 0 }}>{message}</p>}
        <div>
          <button
            type="button"
            className="btn btnPrimary"
            onClick={save}
            disabled={saving || !loaded}
          >
            {saving ? 'Saving to Retell…' : 'Save and sync transfer'}
          </button>
        </div>
      </div>
    </section>
  )
}
