import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

type Client = {
  company_name: string | null
  contact_email: string | null
}

export default function Settings() {
  const navigate = useNavigate()

  const [client, setClient] = useState<Client | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadSettings = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('clients')
        .select('company_name, contact_email')
        .eq('id', user.id)
        .single()

      if (!error && data) {
        setClient(data)
      }

      setLoading(false)
    }

    loadSettings()
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/login')
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

          <a href="/dashboard/appointments" className="dashboardNavItem">
            Appointments
          </a>

          <a href="/dashboard/agent" className="dashboardNavItem">
            Agent
          </a>

          <a href="/dashboard/billing" className="dashboardNavItem">
            Billing
          </a>

          <a
            href="/dashboard/settings"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Settings
          </a>
        </nav>

        <button
          className="btn btnOutline"
          type="button"
          onClick={handleLogout}
          style={{ width: '100%', marginTop: '28px' }}
        >
          Log out
        </button>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">SETTINGS</p>
            <h1>Account Settings</h1>
            <p>View your Recepta account and business information.</p>
          </div>
        </div>

        {loading ? (
          <div className="dashboardEmptyState">
            <p>Loading account information...</p>
          </div>
        ) : (
          <div className="dashboardStats">
            <div className="dashboardStatCard">
              <span>Business Name</span>
              <strong>{client?.company_name || 'Not assigned'}</strong>
            </div>

            <div className="dashboardStatCard">
              <span>Contact Email</span>
              <strong>{client?.contact_email || 'Not assigned'}</strong>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
