import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type ClientRecord = {
  id: string
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
  created_at: string
}

type SubscriptionRecord = {
  client_id: string
  plan_name: string | null
  monthly_price: number | null
  status: 'pending' | 'active' | 'past_due' | 'cancelled'
}

type ClientWithSubscription = ClientRecord & {
  subscription: SubscriptionRecord | null
}

export default function Admin() {
  const [clients, setClients] = useState<ClientWithSubscription[]>([])
  const [loading, setLoading] = useState(true)

  const [search, setSearch] = useState('')

  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [planName, setPlanName] =
    useState('Recepta Pro')

  const [monthlyPrice, setMonthlyPrice] =
    useState('300')

  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  const loadClients = async () => {
    setLoading(true)

    const [
      { data: clientData, error: clientError },
      { data: subscriptionData, error: subscriptionError },
    ] = await Promise.all([
      supabase
        .from('clients')
        .select(
          'id, company_name, contact_email, status, created_at'
        )
        .order('created_at', {
          ascending: false,
        }),

      supabase
        .from('subscriptions')
        .select(
          'client_id, plan_name, monthly_price, status'
        ),
    ])

    if (
      clientError ||
      subscriptionError ||
      !clientData
    ) {
      setClients([])
      setLoading(false)
      return
    }

    const subscriptions =
      (subscriptionData || []) as SubscriptionRecord[]

    const combined: ClientWithSubscription[] =
      clientData.map((client) => ({
        ...client,

        subscription:
          subscriptions.find(
            (subscription) =>
              subscription.client_id === client.id
          ) || null,
      }))

    setClients(combined)
    setLoading(false)
  }

  useEffect(() => {
    loadClients()
  }, [])

  const filteredClients = useMemo(() => {
    const query = search
      .trim()
      .toLowerCase()

    if (!query) {
      return clients
    }

    return clients.filter((client) => {
      const company =
        client.company_name?.toLowerCase() || ''

      const email =
        client.contact_email?.toLowerCase() || ''

      const plan =
        client.subscription?.plan_name?.toLowerCase() ||
        ''

      return (
        company.includes(query) ||
        email.includes(query) ||
        plan.includes(query)
      )
    })
  }, [clients, search])

  const stats = useMemo(() => {
    const total = clients.length

    const live = clients.filter(
      (client) => client.status === 'live'
    ).length

    const setup = clients.filter(
      (client) =>
        client.status === 'setup' ||
        client.status === 'testing'
    ).length

    const pro = clients.filter(
      (client) =>
        client.subscription?.plan_name ===
        'Recepta Pro'
    ).length

    return {
      total,
      live,
      setup,
      pro,
    }
  }, [clients])

  const handlePlanChange = (
    value: string
  ) => {
    setPlanName(value)

    if (value === 'Recepta Standard') {
      setMonthlyPrice('200')
    } else {
      setMonthlyPrice('300')
    }
  }

  const handleCreateClient = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setCreating(true)
    setCreateError('')
    setCreateSuccess('')

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        setCreateError(
          'Your admin session has expired. Please log in again.'
        )

        setCreating(false)
        return
      }

      const response = await fetch(
        '/.netlify/functions/create-client',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',

            Authorization:
              `Bearer ${session.access_token}`,
          },

          body: JSON.stringify({
            companyName,
            email,
            password,
            planName,
            monthlyPrice:
              Number(monthlyPrice),
          }),
        }
      )

      const result = await response.json()

      if (!response.ok) {
        setCreateError(
          result.error ||
            'Could not create client.'
        )

        setCreating(false)
        return
      }

      setCreateSuccess(
        `${companyName} was created successfully.`
      )

      setCompanyName('')
      setEmail('')
      setPassword('')
      setPlanName('Recepta Pro')
      setMonthlyPrice('300')

      await loadClients()
    } catch {
      setCreateError(
        'Could not connect to the server.'
      )
    }

    setCreating(false)
  }

  return (
    <main className="adminPage">

      {/* ADMIN SIDEBAR */}

      <aside className="adminSidebar">
        <div>
          <a
            href="/"
            className="adminBrand"
          >
            <img
              src="/components/logoR.png"
              alt="Recepta"
            />

            <div>
              <strong>
                Recepta
              </strong>

              <span>
                ADMIN
              </span>
            </div>
          </a>

          <nav className="adminNav">
            <a
              href="/admin"
              className="adminNavItem adminNavItem--active"
            >
              <span>
                Clients
              </span>
            </a>
          </nav>
        </div>

        <div className="adminSidebarFooter">
          <span>
            INTERNAL
          </span>

          <p>
            Recepta administration
          </p>
        </div>
      </aside>

      {/* MAIN */}

      <section className="adminMain">

        {/* HEADER */}

        <header className="adminHeader">
          <div>
            <span className="adminEyebrow">
              RECEPTA ADMIN
            </span>

            <h1>
              Client Control Center
            </h1>

            <p>
              Manage Recepta customers,
              subscriptions and onboarding.
            </p>
          </div>

          <a
            href="/"
            className="btn btnOutline"
          >
            View Recepta Website
          </a>
        </header>

        {/* STATS */}

        <div className="adminStats">
          <div className="adminStatCard">
            <span>
              TOTAL CLIENTS
            </span>

            <strong>
              {stats.total}
            </strong>
          </div>

          <div className="adminStatCard">
            <span>
              LIVE CLIENTS
            </span>

            <strong>
              {stats.live}
            </strong>
          </div>

          <div className="adminStatCard">
            <span>
              ONBOARDING
            </span>

            <strong>
              {stats.setup}
            </strong>
          </div>

          <div className="adminStatCard">
            <span>
              PRO CLIENTS
            </span>

            <strong>
              {stats.pro}
            </strong>
          </div>
        </div>

        {/* CREATE CLIENT */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                NEW CLIENT
              </span>

              <h2>
                Create client account
              </h2>

              <p>
                Create the customer's Recepta
                login and assign their plan.
              </p>
            </div>
          </div>

          <form
            className="adminNewClientForm"
            onSubmit={handleCreateClient}
          >
            <label>
              <span>
                Company name
              </span>

              <input
                type="text"
                value={companyName}
                onChange={(event) =>
                  setCompanyName(
                    event.target.value
                  )
                }
                placeholder="ABC Plumbing"
                required
              />
            </label>

            <label>
              <span>
                Client email
              </span>

              <input
                type="email"
                value={email}
                onChange={(event) =>
                  setEmail(
                    event.target.value
                  )
                }
                placeholder="owner@company.com"
                required
              />
            </label>

            <label>
              <span>
                Temporary password
              </span>

              <input
                type="password"
                value={password}
                onChange={(event) =>
                  setPassword(
                    event.target.value
                  )
                }
                placeholder="Minimum 8 characters"
                minLength={8}
                required
              />
            </label>

            <label>
              <span>
                Plan
              </span>

              <select
                value={planName}
                onChange={(event) =>
                  handlePlanChange(
                    event.target.value
                  )
                }
              >
                <option value="Recepta Standard">
                  Recepta Standard — C$200
                </option>

                <option value="Recepta Pro">
                  Recepta Pro — C$300
                </option>
              </select>
            </label>

            <label>
              <span>
                Monthly price
              </span>

              <div className="adminPriceInput">
                <span>
                  C$
                </span>

                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={monthlyPrice}
                  onChange={(event) =>
                    setMonthlyPrice(
                      event.target.value
                    )
                  }
                  required
                />
              </div>
            </label>

            <div className="adminCreateAction">
              <button
                className="btn btnPrimary"
                type="submit"
                disabled={creating}
              >
                {creating
                  ? 'Creating...'
                  : 'Create Client'}
              </button>
            </div>
          </form>

          {createError && (
            <p className="adminFormMessage adminFormMessage--error">
              {createError}
            </p>
          )}

          {createSuccess && (
            <p className="adminFormMessage adminFormMessage--success">
              {createSuccess}
            </p>
          )}
        </section>

        {/* CLIENTS */}

        <section className="adminPanel">
          <div className="adminClientHeader">
            <div>
              <span className="adminEyebrow">
                CLIENTS
              </span>

              <h2>
                Current clients
              </h2>

              <p>
                Select a client to manage their
                Recepta setup.
              </p>
            </div>

            <div className="adminSearch">
              <input
                type="search"
                value={search}
                onChange={(event) =>
                  setSearch(
                    event.target.value
                  )
                }
                placeholder="Search clients..."
              />
            </div>
          </div>

          {loading ? (
            <div className="adminEmpty">
              Loading clients...
            </div>
          ) : clients.length === 0 ? (
            <div className="adminEmpty">
              <strong>
                No clients yet
              </strong>

              <p>
                Your Recepta customers will
                appear here.
              </p>
            </div>
          ) : filteredClients.length === 0 ? (
            <div className="adminEmpty">
              <strong>
                No clients found
              </strong>

              <p>
                Try a different search.
              </p>
            </div>
          ) : (
            <div className="adminClientList">

              <div className="adminClientListHeader">
                <span>
                  CLIENT
                </span>

                <span>
                  PLAN
                </span>

                <span>
                  AGENT
                </span>

                <span>
                  BILLING
                </span>

                <span>
                  ADDED
                </span>

                <span />
              </div>

              {filteredClients.map(
                (client) => (
                  <div
                    className="adminClientRow"
                    key={client.id}
                  >
                    <div className="adminClientIdentity">
                      <div className="adminClientAvatar">
                        {(client.company_name ||
                          'C')
                          .slice(0, 2)
                          .toUpperCase()}
                      </div>

                      <div>
                        <strong>
                          {client.company_name ||
                            'Unnamed Client'}
                        </strong>

                        <span>
                          {client.contact_email ||
                            'No email'}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span
                        className={
                          client.subscription
                            ?.plan_name ===
                          'Recepta Pro'
                            ? 'adminPlanBadge adminPlanBadge--pro'
                            : 'adminPlanBadge'
                        }
                      >
                        {client.subscription
                          ?.plan_name ===
                        'Recepta Pro'
                          ? 'Pro'
                          : 'Standard'}
                      </span>
                    </div>

                    <div>
                      <span
                        className={`adminStatusBadge adminStatusBadge--${client.status}`}
                      >
                        {client.status}
                      </span>
                    </div>

                    <div className="adminBillingCell">
                      <strong>
                        {client.subscription
                          ?.monthly_price !==
                          null &&
                        client.subscription
                          ?.monthly_price !==
                          undefined
                          ? `C$${client.subscription.monthly_price.toFixed(
                              0
                            )}`
                          : '—'}
                      </strong>

                      <span>
                        {client.subscription
                          ?.status ||
                          'pending'}
                      </span>
                    </div>

                    <div className="adminDateCell">
                      {new Date(
                        client.created_at
                      ).toLocaleDateString()}
                    </div>

                    <div className="adminClientAction">
                      <a
                        href={`/admin/client/${client.id}`}
                        className="btn btnOutline"
                      >
                        Manage
                      </a>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
