import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

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

    const { error } = await supabase
      .from('clients')
      .update({ status })
      .eq('id', clientId)

    if (!error) {
      setClients((current) =>
        current.map((client) =>
          client.id === clientId
            ? { ...client, status }
            : client
        )
      )
    }

    setUpdatingId(null)
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
              Manage client onboarding and agent status.
            </p>
          </div>
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
                    {new Date(
                      client.created_at
                    ).toLocaleDateString()}
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
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
