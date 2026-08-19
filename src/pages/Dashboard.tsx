export default function Dashboard() {
  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a href="/dashboard" className="dashboardNavItem dashboardNavItemActive">
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
            <h1>Your AI receptionist</h1>
            <p>
              Track your Recepta receptionist once your onboarding is complete.
            </p>
          </div>

          <div
            className="agentLiveBadge"
            style={{
              color: '#f5b942',
              borderColor: 'rgba(245, 185, 66, 0.25)',
              background: 'rgba(245, 185, 66, 0.08)',
            }}
          >
            <span
              style={{
                background: '#f5b942',
                boxShadow: '0 0 12px rgba(245, 185, 66, 0.6)',
              }}
            />
            Setup in progress
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

        <div className="dashboardEmptyState">
          <h2>Your Recepta setup is underway</h2>

          <p>
            Our team is configuring your business information, call handling
            rules, appointment preferences, and AI receptionist before your
            service goes live.
          </p>

          <p>
            Once your receptionist is activated and starts handling real calls,
            your calls, appointments, minutes talked, and call activity will
            appear here automatically.
          </p>
        </div>
      </section>
    </main>
  )
}
