export default function Billing() {
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

          <a
            href="/dashboard/billing"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Billing
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">BILLING</p>
            <h1>Billing & Plan</h1>
            <p>
              View your Recepta subscription and manage billing information.
            </p>
          </div>
        </div>

        <div className="dashboardEmptyState">
          <h2>Billing setup pending</h2>

          <p>
            Your plan and billing information will appear here once your
            Recepta onboarding is completed.
          </p>

          <p>
            You’ll be able to view your plan, payment status, billing date,
            and manage your subscription here.
          </p>
        </div>
      </section>
    </main>
  )
}
