import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import './AdminRetellAgentPicker.css'

type ReadinessCheck = {
  label: string
  status: 'ready' | 'blocked' | 'unverified' | 'optional'
  detail: string
}
type Readiness = { checks: ReadinessCheck[]; canRetry: boolean }

const statusText = { ready: 'Verified', blocked: 'Blocked', unverified: 'Test required', optional: 'Optional' }

export default function AdminReceptionistReadiness({ clientId, autoCheck }: { clientId: string; autoCheck: boolean }) {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const run = useCallback(async (retry = false, signal?: AbortSignal) => {
    setBusy(true)
    setError('')
    setMessage('')
    if (!retry) setReadiness(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Please sign in again.')
      const url = '/.netlify/functions/appointment-scheduling?' + new URLSearchParams({ clientId, readiness: '1' })
      const headers = { Authorization: `Bearer ${session.access_token}` }
      if (retry) {
        const repair = await fetch(url, { method: 'POST', headers, signal })
        const result = await repair.json().catch(() => null)
        if (signal?.aborted) return
        if (!repair.ok) setError(result?.error || 'The appointment tools could not be synchronized.')
        else setMessage('The published appointment tools are verified.')
        setReadiness(null)
      }
      const response = await fetch(url, { headers, signal })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result) throw new Error(result?.error || 'Readiness checks could not be loaded.')
      if (!signal?.aborted) setReadiness(result)
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'Readiness checks could not be completed.')
    } finally {
      if (!signal?.aborted) setBusy(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!autoCheck) return
    const controller = new AbortController()
    void run(false, controller.signal)
    return () => controller.abort()
  }, [autoCheck, run])

  return <section className="adminRetellPicker adminEditFullWidth" aria-busy={busy}>
    <div className="adminRetellPickerHeader">
      <div><strong>Receptionist setup</strong><p>Checks service access, phone routing and published appointment tools.</p></div>
      <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void run()}>
        {busy ? 'Checking setup…' : 'Check Agent Readiness'}
      </button>
    </div>
    {error && <p role="alert" className="adminRetellNotice adminRetellNotice--error">{error}</p>}
    {message && <p role="status" className="adminRetellNotice adminRetellNotice--success">{message}</p>}
    {readiness && <>
      <ul aria-label="Receptionist setup checks">{readiness.checks.map(item => <li key={item.label}>
        <strong>{item.label} · {statusText[item.status]}</strong>
        <div>{item.detail}</div>
      </li>)}</ul>
      {readiness.canRetry && <button type="button" className="btn btnOutline" disabled={busy} onClick={() => void run(true)}>
        Retry appointment tool sync
      </button>}
    </>}
  </section>
}
