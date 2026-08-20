import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type ClientRecord = {
  id: string
  company_name: string | null
  contact_email: string | null
  status: 'setup' | 'testing' | 'live' | 'paused'
  created_at: string
}

export default function Admin() {
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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

    loadClients()
  }, [])

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
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">ADMIN</p>
            <h1>Client Management</h1>
            <p>
              Manage Recepta clients, onboarding status, agents, and subscriptions.
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
            <p>
              Your manually onboarded Recepta clients will appear here.
            </p>
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
                    Client ID: {client.id}
                  </span>

                  <span>
                    Added: {new Date(client.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
