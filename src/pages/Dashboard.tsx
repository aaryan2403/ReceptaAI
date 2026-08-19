import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type Client = {
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
}

export default function Dashboard() {
  const [client, setClient] = useState<Client | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadClient = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('clients')
        .select('company_name, contact_email, status')
        .eq('id', user.id)
        .single()

      if (!error && data) {
        setClient(data)
      }

      setLoading(false)
    }

    loadClient()
  }, [])

  const getStatusInfo = () => {
    switch (client?.status) {
      case 'live':
        return {
          label: 'Agent Live',
          color: '#00c853',
          background: 'rgba(0, 200, 83, 0.10)',
          border: 'rgba(0, 200, 83, 0.20)',
          shadow: 'rgba(0, 200, 83, 0.7)',
        }

      case 'testing':
        return {
          label: 'Agent Testing',
          color: '#3da5ff',
          background: 'rgba(61, 165, 255, 0.10)',
          border: 'rgba(61, 165, 255, 0.20)',
          shadow: 'rgba(61, 165, 255, 0.7)',
        }

      case 'paused':
        return {
          label: 'Agent Paused',
          color: '#a0a0a0',
          background: 'rgba(160, 160, 160, 0.10)',
          border: 'rgba(160, 160, 160, 0.20)',
          shadow: 'rgba(160, 160, 160, 0.5)',
        }

      default:
        return {
          label: 'Setup in progress',
          color: '#f5b942',
          background: 'rgba(245, 185, 66, 0.08)',
          border: 'rgba(245, 185, 66, 0.25)',
          shadow: 'rgba(245, 185, 66, 0.6)',
        }
    }
  }

  const status = getStatusInfo()

  if (loading) {
    return (
      <main className="dashboardPage">
        <section
          className="dashboardMain"
          style={{
            display: 'grid',
            placeItems: 'center',
            minHeight: '100vh',
          }}
        >
          Loading your Recepta dashboard...
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a
            href="/dashboard"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Overview
          </a>

          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>

          <a href="/dashboard/appointments" className="dashboardNavItem">
            Appointments
          </a>

          <a href="/dashboard/agent" className="dashboardNavItem">
            Agent
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
            <p className="dashboardEyebrow">OVERVIEW</p>

            <h1>
              {client?.company_name || 'Your AI receptionist'}
            </h1>

            <p>
              Track how Recepta is handling your customer calls.
            </p>
          </div>

          <div
            className="agentLiveBadge"
            style={{
              color: status.color,
              borderColor: status.border,
              background: status.background,
            }}
          >
            <span
              style={{
                background: status.color,
                boxShadow: `0 0 12px ${status.shadow}`,
              }}
            />

            {status.label}
          </div>
        </div>

        <div className="dashboardStats">
          <div className="dashboardStatCard">
            <span>Calls Answered</span>
            <strong>0</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Appointments Booked</span>
            <strong>0</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Minutes Talked</span>
            <strong>0 min</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Avg. Call Duration</span>
            <strong>—</strong>
          </div>
        </div>

        {client?.status === 'live' ? (
          <div className="dashboardEmptyState">
            <h2>No call activity yet</h2>

            <p>
              Your Recepta receptionist is live. Once calls begin coming in,
              your activity and performance will automatically appear here.
            </p>
          </div>
        ) : (
          <div className="dashboardEmptyState">
            <h2>Your Recepta setup is underway</h2>

            <p>
              Our team is configuring your business information, call handling
              rules, appointment preferences, and AI receptionist.
            </p>

            <p>
              Once your receptionist is activated, calls, appointments,
              minutes talked, and performance data will appear here
              automatically.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
