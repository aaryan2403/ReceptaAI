export default function Agent() {
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

          <a
            href="/dashboard/agent"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Agent
          </a>

          <a href="/dashboard/billing" className="dashboardNavItem">
            Billing
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">YOUR AGENT</p>
            <h1>AI Receptionist</h1>
            <p>
              View the status and configuration of your Recepta receptionist.
            </p>
          </div>

          <div
            className="agentLiveBadge"
            style={{
              color: '#f5b942',
              borderColor: 'rgba(245,185,66,0.25)',
              background: 'rgba(245,185,66,0.08)',
            }}
          >
            <span
              style={{
                background: '#f5b942',
                boxShadow: '0 0 12px rgba(245,185,66,0.6)',
              }}
            />
            Setup in progress
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>We're building your receptionist</h2>

          <p>
            Our team is configuring your business information, call handling
            rules, appointment preferences, and AI receptionist before your
            service goes live.
          </p>

          <p>
            Once setup is complete, your agent status, business phone number,
            operating hours, and other information will appear here.
          </p>
        </div>
      </section>
    </main>
  )
}
