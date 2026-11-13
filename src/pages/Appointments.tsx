import AppointmentScheduling from '../components/AppointmentScheduling'
import BillingAccessNotice from '../components/BillingAccessNotice'
import '../App.css'

export default function Appointments() {
  return <main className="dashboardPage">
    <aside className="dashboardSidebar">
      <a href="/" className="dashboardBrand"><img src="/components/logoR.png" alt="Recepta" /></a>
      <nav className="dashboardNav">
        <a href="/dashboard" className="dashboardNavItem">Overview</a>
        <a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
        <a href="/dashboard/appointments" className="dashboardNavItem dashboardNavItemActive" aria-current="page">Appointments</a>
        <a href="/dashboard/agent" className="dashboardNavItem">Agent</a>
        <a href="/dashboard/requests" className="dashboardNavItem">Customer Requests</a>
        <a href="/dashboard/billing" className="dashboardNavItem">Billing</a>
        <a href="/dashboard/settings" className="dashboardNavItem">Settings</a>
      </nav>
    </aside>
    <section className="dashboardMain">
      <BillingAccessNotice />
      <header className="dashboardHeader"><h1>Appointments</h1></header>
      <AppointmentScheduling />
    </section>
  </main>
}
