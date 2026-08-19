import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

export default function Settings() {
  const navigate = useNavigate()

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
            <p>
              Manage your Recepta account and business information.
            </p>
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>Account settings coming next</h2>
          <p>
            Your business name, contact details, notification preferences,
            and password settings will appear here.
          </p>
        </div>
      </section>
    </main>
  )
}
