import { useState } from 'react'
import { phoneSetupRequest } from '../lib/phoneSetup'
import './PhoneSetup.css'

export default function AdminPhoneLink({ clientId, ownerEmail }: { clientId: string; ownerEmail: string | null }) {
  const [agent, setAgent] = useState('')
  const [phone, setPhone] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  return <div className="phoneSetup" style={{ gridColumn: '1 / -1', border: '1px solid #284733', padding: 20, borderRadius: 14 }}>
    <h3>Link an already purchased number</h3><p>Selected owner: <strong>{ownerEmail || 'No account email'}</strong>. This checks the login owner, Retell workspace, and conflicting assignments before writing. It never buys numbers, creates agents, or activates billing.</p>
    <div className="phoneGrid"><label className="phoneLabel">Existing Retell agent ID<input value={agent} disabled={busy} onChange={e => setAgent(e.target.value)} placeholder="agent_…" /></label>
      <label className="phoneLabel">Already purchased AI number<input type="tel" value={phone} disabled={busy} onChange={e => setPhone(e.target.value)} placeholder="+1…" /></label></div>
    <label className="phoneCheck" style={{ marginTop: 15 }}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I checked that this selected account owns the number and agent, and authorized their connection.</label>
    {error && <p className="phoneAlert phoneError" role="alert">{error}</p>}{message && <p className="phoneAlert phoneSuccess" role="status">{message}</p>}
    <button type="button" className="btn btnOutline" disabled={busy || !confirmed || !agent || !phone || !ownerEmail} onClick={async () => {
      setBusy(true); setError(''); setMessage('')
      try {
        const result = await phoneSetupRequest<{ message: string }>({ clientId, ownerEmail, agentId: agent.trim(), phoneNumber: phone.trim(), ownershipConfirmed: confirmed }, 'admin-link-phone')
        setMessage(result.message)
      } catch (e) { setError(e instanceof Error ? e.message : 'Could not link the number.') }
      finally { setBusy(false) }
    }}>{busy ? 'Verifying and linking…' : 'Verify ownership & link existing resources'}</button>
  </div>
}
