import { useEffect, useState } from 'react'
import { Phone, PhoneMissed } from 'lucide-react'
import { supabase } from '../lib/supabase'
import './CallbackQueue.css'

const statuses = {
  pending: 'Pending callback',
  contacted: 'Contacted',
  resolved: 'Resolved',
  unreachable: 'Unreachable',
}

type CallbackStatus = keyof typeof statuses
type Callback = {
  id: string
  caller_number: string | null
  reason: string
  status: CallbackStatus
  created_at: string
}

const reasons: Record<string, string> = {
  agent_unavailable: 'Receptionist unavailable',
  outside_answering_hours: 'Outside AI answering hours',
  allowance_unavailable: 'Paid minutes unavailable or reserved by another call',
  admission_unavailable: 'Temporary call routing issue',
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const previewLength = 4

async function requestCallbacks(update?: { id: string; status: CallbackStatus }, signal?: AbortSignal) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Please sign in again.')

  const response = await fetch('/.netlify/functions/callback-requests', {
    method: update ? 'PATCH' : 'GET',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: update ? JSON.stringify(update) : undefined,
    signal,
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Could not load callbacks.')
  return body.callbacks as Callback[]
}

export default function CallbackQueue() {
  const [callbacks, setCallbacks] = useState<Callback[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (saving) return

    const controller = new AbortController()
    let timer: number
    async function load() {
      try {
        const results = await requestCallbacks(undefined, controller.signal)
        if (controller.signal.aborted) return
        setCallbacks(results)
        setLoadError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        setLoadError(failure instanceof Error ? failure.message : 'Could not load callbacks.')
      }
      timer = window.setTimeout(load, 30_000)
    }

    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [saving])

  async function update(id: string, status: CallbackStatus) {
    if (saving) return
    setSaving(id)
    setSaveError('')
    try {
      setCallbacks(await requestCallbacks({ id, status }))
      setLoadError('')
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : 'Could not update callback.')
    } finally {
      setSaving(null)
    }
  }

  const pendingCount = callbacks?.filter(callback => callback.status === 'pending').length ?? 0
  // Keep the newest calls first within each group.
  const ordered = [
    ...(callbacks?.filter(callback => callback.status === 'pending') ?? []),
    ...(callbacks?.filter(callback => callback.status !== 'pending') ?? []),
  ]
  const visible = showAll ? ordered : ordered.slice(0, previewLength)

  return (
    <section className="callbackQueue" aria-labelledby="callback-queue-title">
      <header className="callbackQueueHeader">
        <div className="callbackQueueTitle">
          <PhoneMissed aria-hidden="true" size={19} />
          <div>
            <h2 id="callback-queue-title">Missed calls &amp; callbacks</h2>
            <p>Follow up on calls the AI couldn’t answer. These calls use no AI minutes.</p>
          </div>
        </div>
        {callbacks && <span className="callbackQueueCount" data-pending={pendingCount > 0}>{pendingCount} pending</span>}
      </header>

      {(saveError || loadError) && <p className="callbackQueueError" role="alert">{saveError || loadError}</p>}
      {!callbacks && !loadError && <p className="callbackQueueMessage" role="status">Loading missed calls…</p>}
      {callbacks?.length === 0 && <p className="callbackQueueMessage">No missed calls recorded.</p>}

      {visible.length > 0 && (
        <ul className="callbackQueueList" id="callback-queue-list">
          {visible.map(callback => {
            const date = new Date(callback.created_at)
            const caller = callback.caller_number
            const displayNumber = caller?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3')

            return (
              <li className="callbackQueueRow" key={callback.id}>
                <div>
                  <strong>{displayNumber || 'Caller ID unavailable'}</strong>
                  <div className="callbackQueueMeta">
                    <span>{reasons[callback.reason] ?? 'Receptionist unavailable'}</span>
                    <time dateTime={callback.created_at}>{dateFormat.format(date)}</time>
                  </div>
                </div>
                <div className="callbackQueueActions">
                  {caller && (
                    <a className="callbackQueueCall" href={`tel:${caller}`} aria-label={`Call back ${displayNumber}`}>
                      <Phone aria-hidden="true" size={14} />
                      <span>Call back</span>
                    </a>
                  )}
                  <select
                    aria-label={`Follow-up status for ${displayNumber || 'unknown caller'}, ${dateFormat.format(date)}`}
                    value={callback.status}
                    data-status={callback.status}
                    disabled={saving !== null}
                    onChange={event => void update(callback.id, event.target.value as CallbackStatus)}
                  >
                    {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {ordered.length > previewLength && (
        <button className="callbackQueueToggle" type="button" aria-expanded={showAll} aria-controls="callback-queue-list" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer calls' : `Show all ${ordered.length} calls`}
        </button>
      )}
    </section>
  )
}
