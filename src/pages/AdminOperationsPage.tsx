import AdminOperations from '../components/AdminOperations'
import AdminRequestsNavItem from '../components/AdminRequestsNavItem'

export default function AdminOperationsPage() {
  return <main className="adminPage">
    <aside className="adminSidebar">
      <div>
        <a href="/" className="adminBrand">
          <img src="/components/logoR.png" alt="Recepta" />
          <div><strong>Recepta</strong><span>ADMIN</span></div>
        </a>
        <nav className="adminNav">
          <a href="/admin" className="adminNavItem">Clients</a>
          <AdminRequestsNavItem />
          <a href="/admin#demo-links" className="adminNavItem">Demo links</a>
          <a href="/admin/operations" className="adminNavItem adminNavItem--active" aria-current="page">Operations</a>
        </nav>
      </div>
    </aside>
    <section className="adminMain">
      <header className="adminHeader">
        <div>
          <span className="adminEyebrow">RECEPTA ADMIN</span>
          <h1>Operations</h1>
          <p>Manage delivery tracking, provider cleanup, and call content retention.</p>
        </div>
        <a href="/admin" className="btn btnOutline">Back to clients</a>
      </header>
      <AdminOperations />
    </section>
  </main>
}
