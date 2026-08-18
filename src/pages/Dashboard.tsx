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
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">OVERVIEW</p>
            <h1>Your AI receptionist</h1>
            <p>Track how Recepta is handling your calls.</p>
          </div>

          <div className="agentLiveBadge">
            <span />
            Agent Live
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
            <strong>0m 00s</strong>
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>No call activity yet</h2>
          <p>
            Once your Recepta agent starts handling calls, your activity will appear here automatically.
          </p>
        </div>
      </section>
    </main>
  )
}
