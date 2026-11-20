import { useEffect, useState } from 'react'
import { retentionDays, type AgentStatus, type ServiceAccess, type ServiceMode, type ServicePlan } from '../lib/serviceAccess'
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
const sources = { stripe: 'Stripe', manual_admin: 'Admin', internal_test: 'Internal Test', automatic_pro: 'Automatic Pro' }
const statusLabels: Record<string, string> = {
  active: 'Active', pending: 'Pending', paused: 'Paused', suspended: 'Suspended', cancelled: 'Cancelled',
  expired: 'Expired', unavailable: 'Unavailable', inactive: 'Inactive', appointment_test: 'Appointment test only',
}
const auditActions: Record<string, string> = {
  save: 'Saved settings', activate: 'Activated client', deactivate: 'Deactivated client',
  pro_ongoing: 'Set service to Ongoing', pro_paused: 'Set service to Paused', pro_deadline: 'Adjusted retention deadline',
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
  const [proStatus, setProStatus] = useState<'ongoing' | 'paused'>('paused')
  const [retention, setRetention] = useState('')
  const [retentionReason, setRetentionReason] = useState('')

  const show = (saved: ServiceAccess) => {
    setAccess(saved)
    setProStatus(saved.service_status ?? 'paused')
    setRetention(localInput(saved.retention_deadline ?? null))
    setRetentionReason('')
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

  const provisioning = access?.reason === 'provisioning' &&
    (access.provisioning_status === 'queued' || access.provisioning_status === 'running')
  useEffect(() => {
    if (!provisioning) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void requestAccess(clientId, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted) setAccess(result.access)
      }).catch(() => {})
    }, 5000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [clientId, provisioning])

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
  const savePro = async (status: 'ongoing' | 'paused' | 'deadline') => {
    if (!access || busy) return
    const deadline = retention ? new Date(retention) : null
    if (status === 'deadline' && (!deadline || !Number.isFinite(deadline.getTime()) || !retentionReason.trim())) {
      setError('Choose a retention deadline and enter a reason.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { access: saved } = await requestAccess(clientId,{
        method:'PUT',
        body:JSON.stringify({ action:'pro_lifecycle',serviceStatus:status,agentId:access.agent_id,
          revision:access.lifecycle_revision,retentionDeadline:status==='deadline' ? deadline?.toISOString() : null,
          reason:status==='deadline' ? retentionReason : null }),
      })
      show(saved)
      onSaved()
      setNotice(status==='deadline' ? 'Retention deadline saved.' : saved.service_status==='ongoing'
        ? 'Service is Ongoing. The Retell configuration is synchronized.' : saved.retention_operation==='deleted' && status==='ongoing'
          ? 'Service authorized. Recepta will provision the replacement agent.' : 'Service is Paused.')
      try {
        const audited = await requestAccess(clientId,{},true)
        setHistory(audited.history ?? [])
      } catch { setError('Changes saved. Refresh Status to see the audit history.') }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Service access could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const canRevoke = access && (access.saved_grant_mode || (access.mode === 'automatic' && access.source !== 'stripe'))
  const billingStatus = access?.billing_status?.replaceAll('_', ' ') ?? 'Unavailable'
  const canReactivate = access && (['paused', 'suspended', 'cancelled', 'expired'].includes(access.status) ||
    access.agent_status_override === 'paused')
  const active = access?.reason === 'ready'
  const pro = access?.plan === 'Recepta Pro' && access.service_status !== undefined
  const effectiveStatus = pro ? (access.service_status === 'ongoing' ? 'Ongoing' : 'Paused') : access?.status === 'active' && !active
    ? access.reason === 'allowance_unavailable' ? 'Calls temporarily unavailable' : 'Awaiting agent readiness'
    : access?.reason === 'provisioning'
      ? access.provisioning_status === 'needs_attention' ? 'Setup needs attention' : 'Configuring'
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
        {pro
          ? access.payment_grace_ends_at && <div><dt>Payment grace ends</dt><dd>{formatDate(access.payment_grace_ends_at)}</dd></div>
          : <div><dt>Access Expires</dt><dd>{access.mode === 'manual' && access.status === 'active' && !access.expires_at ? 'Ongoing' : formatDate(access.expires_at)}</dd></div>}
        {pro && access.service_status === 'paused' && access.retention_deadline && access.retention_operation !== 'deleted' && <>
          <div><dt>{access.retention_reason === 'cancellation' ? 'Cancelled' : access.retention_reason === 'admin_pause' ? 'Paused since' : 'Payment due'}</dt><dd>{formatDate(access.retention_started_at ?? null)}</dd></div>
          <div><dt>Days remaining</dt><dd>{retentionDays(access.retention_deadline)}</dd></div>
          <div><dt>Scheduled agent deletion</dt><dd>{formatDate(access.retention_deadline)}</dd></div>
        </>}
      </dl>
      {access.provisioning_error && access.reason === 'provisioning' &&
        <p role="status" className="adminRetellNotice adminRetellNotice--error">{access.provisioning_error}</p>}

      {pro ? <>
        {access.retention_operation && <p className="adminRetellPickerFootnote">
          {access.retention_operation==='deleted' ? 'The previous Retell agent was removed. Reactivation provisions a replacement.'
            : access.retention_operation==='restoring' ? 'The replacement agent is being configured.' : 'The retention job is archiving the existing agent.'}
        </p>}
        {access.retention_error && <p role="status" className="adminRetellNotice adminRetellNotice--error">{access.retention_error}</p>}
        <fieldset className="adminServiceAccessFields" disabled={busy}>
          <label><span>Service Status</span>
            <select value={proStatus} onChange={event => setProStatus(event.target.value as 'ongoing' | 'paused')}>
              <option value="ongoing">Ongoing</option><option value="paused">Paused</option>
            </select>
          </label>
        </fieldset>
        <div className="adminServiceAccessActions">
          <button type="button" className="btn btnPrimary" disabled={busy} onClick={() => void savePro(proStatus)}>Save &amp; Sync</button>
        </div>
        {access.retention_deadline && access.retention_operation !== 'deleted' && <details className="adminServiceAudit">
          <summary>Adjust retention deadline</summary>
          <fieldset className="adminServiceAccessFields" disabled={busy}>
            <label><span>Deletion date · Your local time</span><input type="datetime-local" value={retention} onChange={event => setRetention(event.target.value)} /></label>
            <label><span>Reason</span><input value={retentionReason} maxLength={500} onChange={event => setRetentionReason(event.target.value)} /></label>
          </fieldset>
          <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void savePro('deadline')}>Save deadline</button>
        </details>}
      </> : <>
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
      </>}
      <details className="adminServiceAudit">
        <summary>Audit history</summary>
        {history.length ? <ul aria-label="Recent service changes">{history.map(entry => <li key={entry.id}>
          <strong>{auditActions[entry.action] ?? entry.action}</strong>
          <span title={entry.actor_id}>{formatDate(entry.occurred_at)}</span>
          <span>{entry.previous_state.service_status ?? serviceModes[entry.previous_state.mode]} → {entry.new_state.service_status ?? serviceModes[entry.new_state.mode]} · {entry.new_state.plan ?? 'Unassigned'}</span>
        </li>)}</ul> : <p>No administrative changes recorded.</p>}
      </details>
    </>}
    <AdminReceptionistReadiness key={String(access?.revision ?? 0) + ':' + String(access?.lifecycle_revision ?? 0)} clientId={clientId} autoCheck={Boolean(active && access?.revision)} />
  </section>
}
