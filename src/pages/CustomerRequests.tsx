import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type RequestStatus = 'new' | 'in_progress' | 'resolved'

type CustomerRequest = {
  id: string
  request_type: string
  title: string
  details: string
  status: RequestStatus
  email_sent_at: string | null
  created_at: string
  updated_at: string
}

const REQUEST_TYPES = [
  ['website_change', 'Website change'],
  ['ai_agent_change', 'AI agent change'],
  ['question', 'Question'],
  ['meeting', 'Meeting request'],
  ['billing', 'Billing request'],
  ['other', 'Other request'],
] as const

const REQUEST_TYPE_LABELS = Object.fromEntries(REQUEST_TYPES)

const STATUS_LABELS: Record<RequestStatus, string> = {
  new: 'Received',
  in_progress: 'In progress',
  resolved: 'Resolved',
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))

export default function CustomerRequests() {
  const [isPro, setIsPro] = useState(false)
  const [requests, setRequests] = useState<CustomerRequest[]>([])
  const [requestType, setRequestType] = useState('website_change')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const bookingUrl = useMemo(() => {
    const params = new URLSearchParams()

    if (title.trim()) {
      params.set('notes', `Recepta request: ${title.trim()}`)
    }

    const query = params.toString()
    return `https://cal.com/recepta/30min${query ? `?${query}` : ''}`
  }, [title])

  const getSession = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      throw new Error('Your session has expired. Please sign in again.')
    }

    return session
  }

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        const user = session?.user

        if (!user || !session.access_token) {
          throw new Error('Your session has expired. Please sign in again.')
        }

        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('plan_name')
          .eq('client_id', user.id)
          .maybeSingle()

        const response = await fetch(
          '/.netlify/functions/customer-requests',
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
          setIsPro(subscription?.plan_name === 'Recepta Pro')
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

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSuccess('')

    if (title.trim().length < 3) {
      setError('Add a short title explaining what you need.')
      return
    }

    if (details.trim().length < 10) {
      setError('Add at least 10 characters of request details.')
      return
    }

    setSubmitting(true)

    try {
      const session = await getSession()
      const response = await fetch('/.netlify/functions/customer-requests', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestType,
          title: title.trim(),
          details: details.trim(),
        }),
      })
      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(result?.error || 'Could not submit the request.')
      }

      if (result?.request) {
        setRequests((current) => [result.request, ...current])
      }

      setRequestType('website_change')
      setTitle('')
      setDetails('')
      setSuccess(
        result?.notificationSent
          ? 'Request submitted. Recepta has been notified and will respond within 2–3 business days.'
          : 'Request submitted and saved. Recepta will respond within 2–3 business days.'
      )
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : 'Could not submit the request.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem">
            Overview
          </a>
          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>
          {isPro && (
            <a href="/dashboard/appointments" className="dashboardNavItem">
              Appointments
            </a>
          )}
          <a href="/dashboard/employees" className="dashboardNavItem">
            Employees
          </a>
          <a href="/dashboard/agent" className="dashboardNavItem">
            Agent
          </a>
          <a
            href="/dashboard/requests"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Customer Requests
          </a>
          <a href="/dashboard/billing" className="dashboardNavItem">
            Billing
          </a>
          <a href="/dashboard/settings" className="dashboardNavItem">
            Settings
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">CUSTOMER REQUESTS</p>
            <h1>How can Recepta help?</h1>
            <p>
              Request a website change, AI-agent update, billing change,
              answer or meeting. Requests are normally resolved within 2–3
              business days.
            </p>
          </div>
        </div>

        <div className="customerRequestGrid">
          <form className="customerRequestPanel" onSubmit={handleSubmit}>
            <span className="dashboardEyebrow">NEW REQUEST</span>
            <h2>Tell us what you need</h2>

            <label>
              <span>Request type</span>
              <select
                value={requestType}
                onChange={(event) => setRequestType(event.target.value)}
              >
                {REQUEST_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Title or reason</span>
              <input
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Example: Update our greeting and business hours"
              />
            </label>

            <label>
              <span>Request details</span>
              <textarea
                value={details}
                maxLength={5000}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="Describe the change, question or help you need."
                rows={7}
              />
            </label>

            {error && <p className="customerRequestError">{error}</p>}
            {success && <p className="customerRequestSuccess">{success}</p>}

            <button
              type="submit"
              className="btn btnPrimary"
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </form>

          <section className="customerRequestPanel customerRequestMeeting">
            <span className="dashboardEyebrow">BOOK A CALL</span>
            <h2>Need to talk it through?</h2>
            <p>
              Book a 15-minute Recepta support call. Cal.com only displays
              available times from Recepta’s connected calendar, preventing
              overlapping bookings.
            </p>
            <a
              className="btn btnOutline"
              href={bookingUrl}
              target="_blank"
              rel="noreferrer"
            >
              Book a 15-minute Call
            </a>
            <small>
              Add your meeting reason in the title above or in the Cal.com
              booking form.
            </small>
          </section>
        </div>

        <section className="customerRequestHistory">
          <div className="customerRequestHistoryHeader">
            <div>
              <span className="dashboardEyebrow">REQUEST HISTORY</span>
              <h2>Your requests</h2>
            </div>
          </div>

          {loading ? (
            <div className="dashboardEmptyState">Loading requests...</div>
          ) : requests.length === 0 ? (
            <div className="dashboardEmptyState">No requests submitted yet.</div>
          ) : (
            <div className="customerRequestList">
              {requests.map((item) => (
                <article className="customerRequestCard" key={item.id}>
                  <div className="customerRequestCardTop">
                    <div>
                      <span>{REQUEST_TYPE_LABELS[item.request_type] || 'Request'}</span>
                      <h3>{item.title}</h3>
                    </div>
                    <span className={`customerRequestStatus customerRequestStatus--${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>
                  <p>{item.details}</p>
                  <small>Submitted {formatDate(item.created_at)}</small>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
