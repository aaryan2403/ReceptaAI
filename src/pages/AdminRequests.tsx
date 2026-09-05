import { useEffect, useMemo, useState } from 'react'
import AdminRequestsNavItem from '../components/AdminRequestsNavItem'
import { supabase } from '../lib/supabase'

type RequestStatus = 'new' | 'in_progress' | 'resolved'

type AdminRequest = {
  id: string
  client_id: string
  request_type: string
  title: string
  details: string
  status: RequestStatus
  email_sent_at: string | null
  created_at: string
  updated_at: string
  clients:
    | {
        company_name: string | null
        contact_email: string | null
      }
    | Array<{
        company_name: string | null
        contact_email: string | null
      }>
    | null
}

const REQUEST_TYPE_LABELS: Record<string, string> = {
  website_change: 'Website change',
  ai_agent_change: 'AI agent change',
  question: 'Question',
  meeting: 'Meeting request',
  billing: 'Billing request',
  other: 'Other request',
}

const STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'New',
  in_progress: 'In progress',
  resolved: 'Resolved',
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))

const getClient = (item: AdminRequest) =>
  Array.isArray(item.clients) ? item.clients[0] : item.clients

export default function AdminRequests() {
  const [requests, setRequests] = useState<AdminRequest[]>([])
  const [filter, setFilter] = useState<'open' | RequestStatus | 'all'>('open')
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const newCount = requests.filter((item) => item.status === 'new').length

  const visibleRequests = useMemo(() => {
    if (filter === 'all') return requests
    if (filter === 'open') {
      return requests.filter((item) => item.status !== 'resolved')
    }
    return requests.filter((item) => item.status === filter)
  }, [filter, requests])

  const getSession = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error('Admin session expired. Sign in again.')
    }

    return session
  }

  const loadRequests = async () => {
    setLoading(true)
    setError('')

    try {
      const session = await getSession()
      const response = await fetch(
        '/.netlify/functions/admin-customer-requests',
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      )
      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(result?.error || 'Could not load customer requests.')
      }

      setRequests(Array.isArray(result?.requests) ? result.requests : [])
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Could not load customer requests.'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const loadInitialRequests = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        if (!session?.access_token) {
          throw new Error('Admin session expired. Sign in again.')
        }

        const response = await fetch(
          '/.netlify/functions/admin-customer-requests',
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          }
        )
        const result = await response.json().catch(() => ({}))

        if (!response.ok) {
          throw new Error(
            result?.error || 'Could not load customer requests.'
          )
        }

        if (!cancelled) {
          setRequests(
            Array.isArray(result?.requests) ? result.requests : []
          )
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Could not load customer requests.'
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadInitialRequests()

    return () => {
      cancelled = true
    }
  }, [])

  const updateStatus = async (
    requestId: string,
    status: RequestStatus
  ) => {
    setUpdatingId(requestId)
    setError('')

    try {
      const session = await getSession()
      const response = await fetch(
        '/.netlify/functions/admin-customer-requests',
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requestId, status }),
        }
      )
      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(result?.error || 'Could not update the request.')
      }

      setRequests((current) =>
        current.map((item) =>
          item.id === requestId
            ? {
                ...item,
                status,
                updated_at:
                  result?.request?.updated_at || new Date().toISOString(),
              }
            : item
        )
      )
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : 'Could not update the request.'
      )
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <main className="adminPage">
      <aside className="adminSidebar">
        <div>
          <a href="/" className="adminBrand">
            <img src="/components/logoR.png" alt="Recepta" />
            <div>
              <strong>Recepta</strong>
              <span>ADMIN</span>
            </div>
          </a>

          <nav className="adminNav">
            <a href="/admin" className="adminNavItem">
              Clients
            </a>
            <AdminRequestsNavItem active count={newCount} />
          </nav>
        </div>
      </aside>

      <section className="adminMain">
        <header className="adminHeader">
          <div>
            <span className="adminEyebrow">CUSTOMER REQUESTS</span>
            <h1>Request Inbox</h1>
            <p>
              Review every customer request and track it from new to resolved.
            </p>
          </div>
          <button type="button" className="btn btnOutline" onClick={loadRequests}>
            Refresh
          </button>
        </header>

        <div className="adminRequestSummary">
          <div>
            <span>New requests</span>
            <strong>{newCount}</strong>
          </div>
          <div>
            <span>In progress</span>
            <strong>
              {requests.filter((item) => item.status === 'in_progress').length}
            </strong>
          </div>
          <div>
            <span>Resolved</span>
            <strong>
              {requests.filter((item) => item.status === 'resolved').length}
            </strong>
          </div>
        </div>

        <div className="adminRequestFilters" role="group" aria-label="Request filter">
          {(
            [
              ['open', 'Open'],
              ['new', 'New'],
              ['in_progress', 'In progress'],
              ['resolved', 'Resolved'],
              ['all', 'All'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'btn btnPrimary' : 'btn btnOutline'}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <p className="customerRequestError">{error}</p>}

        {loading ? (
          <div className="adminEmpty">Loading customer requests...</div>
        ) : visibleRequests.length === 0 ? (
          <div className="adminEmpty">No requests match this filter.</div>
        ) : (
          <div className="adminRequestList">
            {visibleRequests.map((item) => {
              const client = getClient(item)

              return (
                <article className="adminRequestCard" key={item.id}>
                  <div className="adminRequestCardHead">
                    <div>
                      <span className="adminEyebrow">
                        {REQUEST_TYPE_LABELS[item.request_type] || 'Request'}
                      </span>
                      <h2>{item.title}</h2>
                      <p>
                        {client?.company_name || 'Unknown company'} ·{' '}
                        {client?.contact_email || 'No email'}
                      </p>
                    </div>
                    <span className={`customerRequestStatus customerRequestStatus--${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>

                  <p className="adminRequestDetails">{item.details}</p>

                  <div className="adminRequestMeta">
                    <span>Submitted {formatDate(item.created_at)}</span>
                    <span>
                      {item.email_sent_at
                        ? 'Email notification sent'
                        : 'Email notification not confirmed'}
                    </span>
                  </div>

                  <div className="adminRequestActions">
                    {item.status !== 'new' && (
                      <button
                        type="button"
                        className="btn btnOutline"
                        disabled={updatingId === item.id}
                        onClick={() => updateStatus(item.id, 'new')}
                      >
                        Mark New
                      </button>
                    )}
                    {item.status !== 'in_progress' && (
                      <button
                        type="button"
                        className="btn btnOutline"
                        disabled={updatingId === item.id}
                        onClick={() => updateStatus(item.id, 'in_progress')}
                      >
                        Start Working
                      </button>
                    )}
                    {item.status !== 'resolved' && (
                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={updatingId === item.id}
                        onClick={() => updateStatus(item.id, 'resolved')}
                      >
                        Mark Resolved
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </main>
  )
}
