import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import AdminReceptionistReadiness from './AdminReceptionistReadiness'
import './AdminServiceAccess.css'

type Mode = 'automatic' | 'manual' | 'internal_test' | 'paused' | 'pending'
type Plan = 'Recepta Standard' | 'Recepta Pro'
type Action = 'save' | 'activate_test' | 'pause' | 'revoke'
type Access = {
  business_name: string
  mode: Mode
  status: string
  source: 'stripe' | 'manual_admin' | 'internal_test'
  reason: string
  plan: Plan | null
  billing_status: string | null
  has_stripe_subscription: boolean
  agent_id: string | null
  assignment_valid: boolean
  phone_number: string | null
  remaining_seconds: number
  expires_at: string | null
  max_minutes: number | null
  admin_reason: string | null
  updated_at: string | null
  updated_by: string | null
  revision: number
}

const sources = { stripe: 'Stripe', manual_admin: 'Manual Admin', internal_test: 'Internal Test' }
const statusLabels: Record<string, string> = {
  active: 'Active', pending: 'Pending', paused: 'Paused', expired: 'Expired',
  unavailable: 'Unavailable', inactive: 'Inactive', appointment_test: 'Appointment test only',
}
const minutes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const formatDate = (value: string | null) => value ? new Date(value).toLocaleString(undefined, {
  dateStyle: 'medium', timeStyle: 'short',
}) : '—'
const localInput = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

const requestAccess = async (clientId: string, options: RequestInit = {}): Promise<Access> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const response = await fetch('/.netlify/functions/admin-service-access?' + new URLSearchParams({ clientId }), {
    ...options,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.access) throw new Error(result?.error || 'Service access could not be loaded.')
  return result.access
}

export default function AdminServiceAccess({ clientId, onSaved }: { clientId: string; onSaved: () => void }) {
  const [access, setAccess] = useState<Access | null>(null)
  const [mode, setMode] = useState<Mode>('automatic')
  const [plan, setPlan] = useState<Plan>('Recepta Standard')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [allowance, setAllowance] = useState('60')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)

  const show = (saved: Access) => {
    setAccess(saved)
    setMode(saved.mode)
    setPlan(saved.plan ?? 'Recepta Standard')
    setReason(saved.admin_reason ?? '')
    setExpires(localInput(saved.expires_at))
    setAllowance(saved.mode === 'internal_test' && saved.max_minutes ? String(saved.max_minutes) : '60')
  }

  useEffect(() => {
    const controller = new AbortController()
    requestAccess(clientId, { signal: controller.signal }).then(saved => {
      if (!controller.signal.aborted) show(saved)
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message)
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false)
    })
    return () => controller.abort()
  }, [clientId, refresh])

  const reload = () => {
    setBusy(true)
    setError('')
    setNotice('')
    setRefresh(current => current + 1)
  }

  const save = async (action: Action) => {
    if (!access || busy) return
    if (action === 'activate_test' && mode !== 'internal_test') {
      setMode('internal_test')
      setError('')
      setNotice('Enter the reason, expiration and minute limit to activate temporary access.')
      return
    }
    const granting = action === 'activate_test' || (action === 'save' && (mode === 'manual' || mode === 'internal_test'))
    const expiryTime = expires ? new Date(expires) : null
    if (granting && (!reason.trim() || !expiryTime || !(expiryTime.getTime() > Date.now()))) {
      setError('Enter an authorization reason and a future expiration.')
      setNotice('')
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await requestAccess(clientId, {
        method: 'PUT',
        body: JSON.stringify({
          action, mode, plan, reason, expiresAt: expiryTime?.toISOString(), maxMinutes: Number(allowance),
          agentId: access.agent_id, revision: access.revision,
        }),
      })
      show(saved)
      onSaved()
      if (action === 'revoke') setNotice('Manual access revoked. New calls are blocked while service is pending.')
      else if (saved.mode === 'paused') setNotice('Service paused. New calls are blocked.')
      else if (granting && saved.status === 'active') setNotice('Service authorization is active. Review the readiness results before placing a test call.')
      else setNotice('Service access saved.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Service access could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const granting = mode === 'manual' || mode === 'internal_test'
  const canRevoke = access && (['manual', 'internal_test'].includes(access.mode) ||
    (access.mode === 'automatic' && access.source !== 'stripe'))
  const billingStatus = access?.billing_status?.replaceAll('_', ' ') ?? 'Unavailable'

  return <section className="adminServiceAccess adminRetellPicker adminEditFullWidth" aria-labelledby="service-access-title" aria-busy={busy}>
    <header className="adminRetellPickerHeader">
      <div><h3 id="service-access-title">Subscription &amp; Service Access</h3><p>Manage this business’s access to inbound calls and appointment tools.</p></div>
      <button type="button" className="btn btnOutline" disabled={busy} onClick={reload}>Refresh Status</button>
    </header>
    {busy && !access && <p role="status">Loading service access…</p>}
    {error && <p role="alert" className="adminRetellNotice adminRetellNotice--error">{error}</p>}
    {notice && <p role="status" className="adminRetellNotice adminRetellNotice--success">{notice}</p>}
    {access && <>
      <dl className="adminServiceAccessSummary">
        <div><dt>Business</dt><dd>{access.business_name}</dd></div>
        <div><dt>Billing</dt><dd className="adminServiceBilling">{billingStatus}{!access.has_stripe_subscription && ' · No Stripe payment'}</dd></div>
        <div><dt>Service Access</dt><dd className={access.status === 'active' ? 'adminServiceActive' : undefined}>{statusLabels[access.status] ?? access.status} · {sources[access.source]}</dd></div>
        <div><dt>Service Plan</dt><dd>{access.plan ?? 'Unassigned'}</dd></div>
        <div><dt>Retell Agent</dt><dd>{access.agent_id ?? 'Unassigned'}{access.agent_id && !access.assignment_valid && ' · Check assignment'}</dd></div>
        <div><dt>Phone Number</dt><dd>{access.phone_number ?? 'Unassigned'}</dd></div>
        <div><dt>{access.mode === 'internal_test' && access.source === 'internal_test' ? 'Remaining Test Minutes' : 'Available Minutes'}</dt><dd>{minutes.format(access.remaining_seconds / 60)}</dd></div>
        <div><dt>Access Expires</dt><dd>{formatDate(access.expires_at)}</dd></div>
        <div><dt>Last Administrative Change</dt><dd title={access.updated_by ?? undefined}>{access.updated_at ? formatDate(access.updated_at) : 'No changes recorded'}</dd></div>
      </dl>

      <fieldset className="adminServiceAccessFields" disabled={busy}>
        <label>
          <span>Service Access</span>
          <select value={mode} onChange={event => setMode(event.target.value as Mode)}>
            <option value="automatic">Automatic — Follow Stripe</option>
            <option value="manual">Manually Active — Admin authorization</option>
            <option value="internal_test">Temporarily Active — Internal testing</option>
            <option value="paused">Paused — Disable service</option>
            <option value="pending">Pending — Awaiting activation</option>
          </select>
        </label>
        <label>
          <span>Subscription Plan</span>
          <select value={granting ? plan : access.plan ?? 'Recepta Standard'} disabled={!granting} onChange={event => setPlan(event.target.value as Plan)}>
            <option value="Recepta Standard">Recepta Standard</option>
            <option value="Recepta Pro">Recepta Pro</option>
          </select>
          {!granting && <small>Automatic access follows the paid plan. Use Checkout plan above to prepare a billing change.</small>}
        </label>
        {granting && <>
          <label className="adminEditFullWidth"><span>Authorization reason</span>
            <input value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} placeholder="Why this business needs access" />
          </label>
          <label><span>Access expiration (your local time)</span>
            <input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} />
          </label>
          {mode === 'internal_test' && <label><span>Maximum test minutes</span>
            <input type="number" min="1" max="100000000" step="1" value={allowance} onChange={event => setAllowance(event.target.value)} />
          </label>}
        </>}
      </fieldset>
      <p className="adminRetellPickerFootnote">Manual and test access authorize Recepta service. Stripe payment status changes only through Stripe.</p>
      <div className="adminServiceAccessActions">
        <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void save('save')}>Save Service Access</button>
        <button type="button" className="btn btnOutline" disabled={busy || !access.assignment_valid} onClick={() => void save('activate_test')}>Activate Temporary Test Access</button>
        <button type="button" className="btn btnOutline" disabled={busy || access.mode === 'paused'} onClick={() => void save('pause')}>Pause Service</button>
        {canRevoke && <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void save('revoke')}>Revoke Manual Access</button>}
      </div>
    </>}
    <AdminReceptionistReadiness key={access?.revision ?? 0} clientId={clientId}
      autoCheck={access?.status === 'active' && (access.mode === 'internal_test' || access.mode === 'manual') && access.source !== 'stripe'} />
  </section>
}
