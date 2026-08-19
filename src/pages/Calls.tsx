export default function Calls() {
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
          <a href="/dashboard/calls" className="dashboardNavItem dashboardNavItemActive">
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
            <p className="dashboardEyebrow">CALLS</p>
            <h1>Call history</h1>
            <p>Every call handled by your Recepta receptionist will appear here.</p>
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>No calls yet</h2>
          <p>
            Once your AI receptionist starts handling calls, you’ll see caller details,
            duration, summaries, and outcomes here.
          </p>
        </div>
      </section>
    </main>
  )
}
