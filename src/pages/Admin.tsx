import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import OnboardingForm from '../components/OnboardingForm'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type ClientRecord = {
  id: string
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
  created_at: string
}

export default function Admin() {
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [planName, setPlanName] = useState('Recepta Pro')
  const [monthlyPrice, setMonthlyPrice] = useState('300')

  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  const loadClients = async () => {
    const { data, error } = await supabase
      .from('clients')
      .select('id, company_name, contact_email, status, created_at')
      .order('created_at', { ascending: false })

    if (!error && data) {
      setClients(data)
    }

    setLoading(false)
  }

  useEffect(() => {
    loadClients()
  }, [])

  const updateStatus = async (
    clientId: string,
    status: ClientStatus
  ) => {
    setUpdatingId(clientId)

    const { error: clientError } = await supabase
      .from('clients')
      .update({ status })
      .eq('id', clientId)

    if (clientError) {
      setUpdatingId(null)
      return
    }

    const { error: agentError } = await supabase
      .from('agents')
      .update({ status })
      .eq('client_id', clientId)

    if (agentError) {
      setUpdatingId(null)
      return
    }

    setClients((current) =>
      current.map((client) =>
        client.id === clientId
          ? { ...client, status }
          : client
      )
    )

    setUpdatingId(null)
  }

  const handleCreateClient = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setCreating(true)
    setCreateError('')
    setCreateSuccess('')

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        setCreateError('You are not logged in.')
        setCreating(false)
        return
      }

      const response = await fetch('/.netlify/functions/create-client', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          companyName,
          email,
          password,
          planName,
          monthlyPrice: Number(monthlyPrice),
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        setCreateError(result.error || 'Could not create client.')
        setCreating(false)
        return
      }

      setCreateSuccess('Client created successfully.')

      setCompanyName('')
      setEmail('')
      setPassword('')
      setPlanName('Recepta Pro')
      setMonthlyPrice('300')

      await loadClients()
    } catch {
      setCreateError('Could not connect to the server.')
    }

    setCreating(false)
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a
            href="/admin"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Clients
          </a>

          <a href="/dashboard" className="dashboardNavItem">
            My Dashboard
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">ADMIN</p>
            <h1>Client Management</h1>
            <p>
              Create clients, manage onboarding, and control agent status.
            </p>
          </div>
        </div>

        <div className="adminCreateCard">
          <div>
            <p className="dashboardEyebrow">NEW CLIENT</p>
            <h2>Add Client</h2>
            <p>
              Create a Recepta account after the customer has completed
              your sales process.
            </p>
          </div>

          <form
            className="adminCreateForm"
            onSubmit={handleCreateClient}
          >
            <label>
              Company Name
              <input
                type="text"
                value={companyName}
                onChange={(event) =>
                  setCompanyName(event.target.value)
                }
                placeholder="ABC Plumbing"
                required
              />
            </label>

            <label>
              Client Email
              <input
                type="email"
                value={email}
                onChange={(event) =>
                  setEmail(event.target.value)
                }
                placeholder="owner@company.com"
                required
              />
            </label>

            <label>
              Temporary Password
              <input
                type="password"
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
                placeholder="Minimum 8 characters"
                minLength={8}
                required
              />
            </label>

            <label>
              Plan
              <select
                value={planName}
                onChange={(event) =>
                  setPlanName(event.target.value)
                }
              >
                <option value="Recepta Standard">
                  Recepta Standard
                </option>

                <option value="Recepta Pro">
                  Recepta Pro
                </option>
              </select>
            </label>

            <label>
              Monthly Price
              <input
                type="number"
                min="0"
                step="0.01"
                value={monthlyPrice}
                onChange={(event) =>
                  setMonthlyPrice(event.target.value)
                }
                required
              />
            </label>

            {createError && (
              <p className="loginError">
                {createError}
              </p>
            )}

            {createSuccess && (
              <p className="loginSuccess">
                {createSuccess}
              </p>
            )}

            <button
              className="btn btnPrimary"
              type="submit"
              disabled={creating}
            >
              {creating ? 'Creating Client...' : 'Create Client'}
            </button>
          </form>
        </div>

        <div style={{ marginTop: '36px' }}>
          <p className="dashboardEyebrow">CLIENTS</p>
          <h2>Current Clients</h2>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading clients...</p>
          </div>
        ) : clients.length === 0 ? (
          <div className="dashboardEmptyState">
            <h2>No clients yet</h2>
            <p>Your onboarded Recepta clients will appear here.</p>
          </div>
        ) : (
          <div className="callsList">
            {clients.map((client) => (
              <div className="callCard" key={client.id}>
                <div className="callCardTop">
                  <div>
                    <strong>
                      {client.company_name || 'Unnamed Client'}
                    </strong>

                    <span>
                      {client.contact_email || 'No contact email'}
                    </span>
                  </div>

                  <span className="callDuration">
                    {client.status}
                  </span>
                </div>

                <div className="callMeta">
                  <span>
                    Added:{' '}
                    {new Date(client.created_at).toLocaleDateString()}
                  </span>
                </div>

                <div
                  style={{
                    marginTop: '16px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                  }}
                >
                  <button
                    className="btn btnOutline"
                    type="button"
                    disabled={updatingId === client.id}
                    onClick={() =>
                      updateStatus(client.id, 'setup')
                    }
                  >
                    Setup
                  </button>

                  <button
                    className="btn btnOutline"
                    type="button"
                    disabled={updatingId === client.id}
                    onClick={() =>
                      updateStatus(client.id, 'testing')
                    }
                  >
                    Testing
                  </button>

                  <button
                    className="btn btnPrimary"
                    type="button"
                    disabled={updatingId === client.id}
                    onClick={() =>
                      updateStatus(client.id, 'live')
                    }
                  >
                    Go Live
                  </button>

                  <button
                    className="btn btnOutline"
                    type="button"
                    disabled={updatingId === client.id}
                    onClick={() =>
                      updateStatus(client.id, 'paused')
                    }
                  >
                    Pause
                  </button>
                </div>

                <OnboardingForm
                  clientId={client.id}
                  companyName={client.company_name || 'Client'}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
