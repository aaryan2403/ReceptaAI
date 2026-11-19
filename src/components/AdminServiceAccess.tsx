import { useEffect, useState } from 'react'
import type { AgentStatus, ServiceAccess, ServiceMode, ServicePlan } from '../lib/serviceAccess'
import { supabase } from '../lib/supabase'
import AdminReceptionistReadiness from './AdminReceptionistReadiness'
import './AdminServiceAccess.css'

type Action = 'save' | 'activate_test' | 'revoke' | 'activate' | 'deactivate' | 'reactivate'
type Audit = {
  id: string
  actor_id: string
  action: string
  occurred_at: string
  previous_state: ServiceAccess
  new_state: ServiceAccess
}

const serviceModes: Record<ServiceMode, string> = {
  automatic: 'Automatic — Follow Stripe', manual: 'Active — Manual authorization',
  internal_test: 'Active — Temporary test', pending: 'Pending', paused: 'Paused',
  suspended: 'Suspended', cancelled: 'Cancelled',
}
const agentStatuses: Record<AgentStatus, string> = { setup: 'Setup', testing: 'Testing', live: 'Live', paused: 'Paused' }
const sources = { stripe: 'Stripe', manual_admin: 'Admin', internal_test: 'Internal Test' }
const statusLabels: Record<string, string> = {
  active: 'Active', pending: 'Pending', paused: 'Paused', suspended: 'Suspended', cancelled: 'Cancelled',
  expired: 'Expired', unavailable: 'Unavailable', inactive: 'Inactive', appointment_test: 'Appointment test only',
}
const auditActions: Record<string, string> = {
  save: 'Saved settings', activate: 'Activated client', deactivate: 'Deactivated client',
  reactivate: 'Reactivated client', activate_test: 'Authorized temporary test', pause: 'Paused service', revoke: 'Revoked authorization',
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

const requestAccess = async (clientId: string, options: RequestInit = {}, history = false): Promise<{ access: ServiceAccess; history?: Audit[] }> => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('Please sign in again.')
  const params = new URLSearchParams({ clientId })
  if (history) params.set('history', '1')
  const response = await fetch('/.netlify/functions/admin-service-access?' + params, {
    ...options,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.access) throw new Error(result?.error || 'Service access could not be loaded.')
  return result
}

export default function AdminServiceAccess({ clientId, onSaved }: { clientId: string; onSaved: () => void }) {
  const [access, setAccess] = useState<ServiceAccess | null>(null)
  const [history, setHistory] = useState<Audit[]>([])
  const [mode, setMode] = useState<ServiceMode>('automatic')
  const [plan, setPlan] = useState<ServicePlan | ''>('')
  const [agentStatus, setAgentStatus] = useState<AgentStatus | ''>('')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')
  const [allowance, setAllowance] = useState('60')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)

  const show = (saved: ServiceAccess) => {
    setAccess(saved)
    setMode(saved.mode)
    setPlan(saved.plan_override ?? '')
    setAgentStatus(saved.agent_status_override ?? '')
    setReason(saved.admin_reason ?? '')
    setExpires(localInput(saved.saved_grant_expires_at))
    setAllowance(String(saved.max_minutes ?? 60))
  }

  useEffect(() => {
    const controller = new AbortController()
    requestAccess(clientId, { signal: controller.signal }, true).then(result => {
      if (!controller.signal.aborted) {
        show(result.access)
        setHistory(result.history ?? [])
      }
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
    const enabling = action === 'activate' || action === 'reactivate'
    let nextMode = mode
    if (action === 'activate_test') nextMode = 'internal_test'
    if (action === 'deactivate') nextMode = 'paused'
    if (action === 'revoke') nextMode = 'pending'
    if (enabling && nextMode !== 'manual' && nextMode !== 'internal_test') {
      nextMode = mode === 'automatic' && access.billing_current
        ? 'automatic'
        : access.saved_grant_mode ?? (access.billing_current ? 'automatic' : 'manual')
    }
    const granting = nextMode === 'manual' || nextMode === 'internal_test'
    const expiryTime = granting && expires ? new Date(expires) : null
    if (granting && (!reason.trim() || (expiryTime && !(expiryTime.getTime() > Date.now())) ||
      (nextMode === 'internal_test' && !expiryTime))) {
      setMode(nextMode)
      setError(expiryTime && !(expiryTime.getTime() > Date.now())
        ? 'Choose a future expiration for this authorization.'
        : nextMode === 'internal_test' ? 'Enter a reason and expiration for temporary test access.' : 'Enter a reason for manual authorization.')
      setNotice('')
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { access: saved } = await requestAccess(clientId, {
        method: 'PUT',
        body: JSON.stringify({
          action, mode: nextMode, servicePlan: plan || null,
          agentStatus: enabling ? 'live' : action === 'activate_test' ? 'testing' : agentStatus || null,
          reason, expiresAt: expiryTime?.toISOString() ?? null, maxMinutes: Number(allowance),
          agentId: access.agent_id, revision: access.revision,
        }),
      })
      show(saved)
      onSaved()
      if (action === 'revoke') setNotice('Manual authorization revoked. Service is pending.')
      else if (saved.mode === 'paused') setNotice('Service paused. Recepta is blocking new calls and appointment tools.')
      else if (saved.reason === 'ready') setNotice('Service is active. Review agent readiness and place a test call.')
      else setNotice('Service settings saved. See the effective access and readiness checks below.')
      try {
        const audited = await requestAccess(clientId, {}, true)
        setHistory(audited.history ?? [])
      } catch {
        setError('Settings were saved. Refresh Status to reload the audit history.')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Service access could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const granting = mode === 'manual' || mode === 'internal_test'
  const canRevoke = access && (access.saved_grant_mode || (access.mode === 'automatic' && access.source !== 'stripe'))
  const billingStatus = access?.billing_status?.replaceAll('_', ' ') ?? 'Unavailable'
  const canReactivate = access && (['paused', 'suspended', 'cancelled', 'expired'].includes(access.status) ||
    access.agent_status_override === 'paused')
  const active = access?.reason === 'ready'
  const effectiveStatus = access?.status === 'active' && !active
    ? access.reason === 'allowance_unavailable' ? 'Calls temporarily unavailable' : 'Awaiting agent readiness'
    : access && (statusLabels[access.status] ?? access.status)

  return <section className="adminServiceAccess adminRetellPicker adminEditFullWidth" aria-labelledby="service-access-title" aria-busy={busy}>
    <header className="adminRetellPickerHeader">
      <div><h3 id="service-access-title">Subscription &amp; Service Access</h3><p>Manage this business’s AI receptionist and plan.</p></div>
      <button type="button" className="btn btnOutline" disabled={busy} onClick={reload}>Refresh Status</button>
    </header>
    {busy && !access && <p role="status">Loading service access…</p>}
    {error && <p role="alert" className="adminRetellNotice adminRetellNotice--error">{error}</p>}
    {notice && <p role="status" className="adminRetellNotice adminRetellNotice--success">{notice}</p>}
    {access && <>
      <dl className="adminServiceAccessSummary">
        <div><dt>Effective Service Access</dt><dd className={active ? 'adminServiceActive' : undefined}>{effectiveStatus} · {sources[access.source]}</dd></div>
        <div><dt>Effective Service Plan</dt><dd>{access.plan ?? 'Unassigned'}</dd></div>
        <div><dt>Stripe Subscription</dt><dd>{access.billing_plan ?? 'Unassigned'}</dd></div>
        <div><dt>Stripe Payment Status</dt><dd className="adminServiceBilling">{billingStatus}{!access.has_stripe_subscription && ' · No Stripe subscription'}</dd></div>
        <div><dt>Retell Agent</dt><dd>{agentStatuses[access.agent_status] ?? 'Setup'}{access.agent_id && ` · ${access.agent_id}`}</dd></div>
        <div><dt>Phone Number</dt><dd>{access.phone_number ?? 'Unassigned'}</dd></div>
        <div><dt>{access.mode === 'internal_test' ? 'Remaining Test Minutes' : 'Available Minutes'}</dt><dd>{minutes.format(access.remaining_seconds / 60)}</dd></div>
        <div><dt>Access Expires</dt><dd>{access.mode === 'manual' && access.status === 'active' && !access.expires_at ? 'Ongoing' : formatDate(access.expires_at)}</dd></div>
      </dl>

      <fieldset className="adminServiceAccessFields" disabled={busy}>
        <label>
          <span>Subscription Plan</span>
          <select value={plan} onChange={event => setPlan(event.target.value as ServicePlan | '')}>
            <option value="">Follow the billing plan</option>
            <option value="Recepta Standard">Recepta Standard</option>
            <option value="Recepta Pro">Recepta Pro</option>
          </select>
        </label>
        <label>
          <span>Service Status</span>
          <select value={mode} onChange={event => setMode(event.target.value as ServiceMode)}>
            {Object.entries(serviceModes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Retell Agent Status</span>
          <select value={agentStatus} onChange={event => setAgentStatus(event.target.value as AgentStatus | '')}>
            <option value="">Follow Recepta provisioning</option>
            {Object.entries(agentStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <small>Setup and Paused block inbound service. Testing requires temporary test access.</small>
        </label>
        {granting && <>
          <label className="adminEditFullWidth"><span>Authorization reason</span>
            <input value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} placeholder="Why this business needs access" />
          </label>
          <label><span>{mode === 'manual' ? 'Expiration (optional)' : 'Test expiration'} · Your local time</span>
            <input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} />
            {mode === 'manual' && <small>Leave blank for ongoing access with a monthly minute allowance.</small>}
          </label>
          {(mode === 'internal_test' || !access.configured_minutes) && <label><span>{mode === 'internal_test' ? 'Maximum test minutes' : 'Minute allowance'}</span>
            <input type="number" min="1" max="100000000" step="1" value={allowance} onChange={event => setAllowance(event.target.value)} />
          </label>}
        </>}
      </fieldset>
      <p className="adminRetellPickerFootnote">These settings control Recepta service. Manage Stripe charges and subscriptions in Billing.</p>
      <div className="adminServiceAccessActions">
        <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void save('save')}>Save &amp; Sync</button>
        {canReactivate
          ? <button type="button" className="btn btnOutline" disabled={busy || !access.assignment_valid} onClick={() => void save('reactivate')}>Reactivate Client</button>
          : <button type="button" className="btn btnOutline" disabled={busy || !access.assignment_valid} onClick={() => void save('activate')}>Activate Client</button>}
        <button type="button" className="btn btnOutline" disabled={busy || access.mode === 'paused'} onClick={() => void save('deactivate')}>Deactivate Client</button>
        <button type="button" className="btn btnOutline" disabled={busy || !access.assignment_valid} onClick={() => void save('activate_test')}>Activate Temporary Test Access</button>
        {canRevoke && <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void save('revoke')}>Revoke Manual Access</button>}
      </div>
      <details className="adminServiceAudit">
        <summary>Audit history</summary>
        {history.length ? <ul aria-label="Recent service changes">{history.map(entry => <li key={entry.id}>
          <strong>{auditActions[entry.action] ?? entry.action}</strong>
          <span title={entry.actor_id}>{formatDate(entry.occurred_at)}</span>
          <span>{serviceModes[entry.previous_state.mode]} → {serviceModes[entry.new_state.mode]} · {entry.new_state.plan ?? 'Unassigned'}</span>
        </li>)}</ul> : <p>No administrative changes recorded.</p>}
      </details>
    </>}
    <AdminReceptionistReadiness key={access?.revision ?? 0} clientId={clientId} autoCheck={Boolean(active && access?.revision)} />
  </section>
}
