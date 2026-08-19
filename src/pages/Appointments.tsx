export default function Appointments() {
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
          <a
            href="/dashboard/appointments"
            className="dashboardNavItem dashboardNavItemActive"
          >
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
            <p className="dashboardEyebrow">APPOINTMENTS</p>
            <h1>Appointments</h1>
            <p>
              Appointments booked by your Recepta receptionist will appear here.
            </p>
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>No appointments booked yet</h2>
          <p>
            Once your AI receptionist starts scheduling customers, you’ll see
            their name, contact details, appointment time, and booking status here.
          </p>
        </div>
      </section>
    </main>
  )
}
