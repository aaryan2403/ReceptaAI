export default function DashboardLoader({
  text = 'Loading your Recepta workspace...',
}: {
  text?: string
}) {
  return (
    <main className="dashboardPage">
      <section className="dashboardMain dashboardLoaderPage">
        <div className="dashboardLoader">
          <div className="dashboardLoaderOrb">
            <span />
          </div>

          <strong>RECEPTA</strong>
          <p>{text}</p>
        </div>
      </section>
    </main>
  )
}
