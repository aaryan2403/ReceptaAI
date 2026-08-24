import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

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

  // Admin authentication
  const [checkingAdmin, setCheckingAdmin] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

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

  const [clientActionId, setClientActionId] = useState<string | null>(null)
  const [clientActionError, setClientActionError] = useState('')
  const [clientActionSuccess, setClientActionSuccess] = useState('')

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
    let mounted = true

    const checkAdmin = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!mounted) return

        if (
          user?.email?.toLowerCase() ===
          ADMIN_EMAIL.toLowerCase()
        ) {
          setIsAdmin(true)
          await loadClients()
        } else {
          setIsAdmin(false)

          if (user) {
            await supabase.auth.signOut()
          }
        }
      } catch {
        if (mounted) {
          setIsAdmin(false)
        }
      } finally {
        if (mounted) {
          setCheckingAdmin(false)
        }
      }
    }

    checkAdmin()

    return () => {
      mounted = false
    }
  }, [])

  const handleAdminLogin = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setLoggingIn(true)
    setLoginError('')

    try {
      const { data, error } =
        await supabase.auth.signInWithPassword({
          email: adminEmail.trim(),
          password: adminPassword,
        })

      if (error || !data.user) {
        setLoginError('Invalid email or password.')
        return
      }

      if (
        data.user.email?.toLowerCase() !==
        ADMIN_EMAIL.toLowerCase()
      ) {
        await supabase.auth.signOut()

        setLoginError(
          'This account does not have admin access.'
        )

        return
      }

      setIsAdmin(true)
      setAdminPassword('')
      setCheckingAdmin(false)

      await loadClients()
    } catch {
      setLoginError(
        'Could not connect to the server. Please try again.'
      )
    } finally {
      setLoggingIn(false)
    }
  }

  const handleAdminLogout = async () => {
    await supabase.auth.signOut()

    setIsAdmin(false)
    setAdminEmail('')
    setAdminPassword('')
    setClients([])
  }

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

  const getAdminSession = async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) {
      throw new Error(
        'Your admin session has expired. Please sign in again.'
      )
    }

    return session
  }

  const handleClientPlanAction = async (
    client: ClientWithSubscription,
    action: 'standard' | 'pro' | 'cancel'
  ) => {
    const label =
      action === 'standard'
        ? 'activate the C$200 Standard plan for'
        : action === 'pro'
          ? 'activate the C$300 Pro plan for'
          : 'cancel the subscription for'

    if (
      !window.confirm(
        `Are you sure you want to ${label} ${
          client.company_name || client.contact_email || 'this client'
        }?`
      )
    ) {
      return
    }

    setClientActionId(client.id)
    setClientActionError('')
    setClientActionSuccess('')

    try {
      const session = await getAdminSession()

      const response = await fetch(
        '/.netlify/functions/update-client-plan',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            clientId: client.id,
            action,
          }),
        }
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.error || 'Could not update subscription.'
        )
      }

      setClientActionSuccess(
        action === 'cancel'
          ? 'Subscription cancelled.'
          : action === 'pro'
            ? 'C$300 Pro activated.'
            : 'C$200 Standard activated.'
      )

      await loadClients()
    } catch (error) {
      setClientActionError(
        error instanceof Error
          ? error.message
          : 'Could not update subscription.'
      )
    } finally {
      setClientActionId(null)
    }
  }

  const handleDeleteClient = async (
    client: ClientWithSubscription
  ) => {
    const clientName =
      client.company_name ||
      client.contact_email ||
      'this client'

    if (
      !window.confirm(
        `Remove ${clientName}? This action may permanently delete the client's Recepta account and data.`
      )
    ) {
      return
    }

    setClientActionId(client.id)
    setClientActionError('')
    setClientActionSuccess('')

    try {
      const session = await getAdminSession()

      const response = await fetch(
        '/.netlify/functions/delete-client',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            clientId: client.id,
          }),
        }
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(
          result.error || 'Could not remove client.'
        )
      }

      setClientActionSuccess(
        `${clientName} was removed.`
      )

      await loadClients()
    } catch (error) {
      setClientActionError(
        error instanceof Error
          ? error.message
          : 'Could not remove client.'
      )
    } finally {
      setClientActionId(null)
    }
  }

  if (checkingAdmin) {
    return (
      <main className="adminPage">
        <section className="adminMain">
          <div className="adminPanel">
            <div className="adminEmpty">
              Checking admin access...
            </div>
          </div>
        </section>
      </main>
    )
  }

  if (!isAdmin) {
    return (
      <main className="adminPage">
        <section className="adminMain">
          <div className="adminPanel">
            <div className="adminPanelHeading">
              <div>
                <span className="adminEyebrow">
                  RECEPTA ADMIN
                </span>

                <h2>
                  Admin login
                </h2>

                <p>
                  Sign in with the Recepta administrator
                  account to continue.
                </p>
              </div>
            </div>

            <form
              className="adminNewClientForm"
              onSubmit={handleAdminLogin}
            >
              <label>
                <span>
                  Email
                </span>

                <input
                  type="email"
                  value={adminEmail}
                  onChange={(event) =>
                    setAdminEmail(
                      event.target.value
                    )
                  }
                  autoComplete="email"
                  placeholder="Admin email"
                  required
                />
              </label>

              <label>
                <span>
                  Password
                </span>

                <input
                  type="password"
                  value={adminPassword}
                  onChange={(event) =>
                    setAdminPassword(
                      event.target.value
                    )
                  }
                  autoComplete="current-password"
                  placeholder="Admin password"
                  required
                />
              </label>

              <div className="adminCreateAction">
                <button
                  className="btn btnPrimary"
                  type="submit"
                  disabled={loggingIn}
                >
                  {loggingIn
                    ? 'Signing in...'
                    : 'Sign in'}
                </button>
              </div>
            </form>

            {loginError && (
              <p className="adminFormMessage adminFormMessage--error">
                {loginError}
              </p>
            )}
          </div>
        </section>
      </main>
    )
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

          <div className="adminHeaderActions">
            <a
              href="/"
              className="btn btnOutline"
            >
              View Recepta Website
            </a>

            <button
              type="button"
              className="btn btnOutline"
              onClick={handleAdminLogout}
            >
              Sign out
            </button>
          </div>
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

        {clientActionError && (
          <p className="adminFormMessage adminFormMessage--error">
            {clientActionError}
          </p>
        )}

        {clientActionSuccess && (
          <p className="adminFormMessage adminFormMessage--success">
            {clientActionSuccess}
          </p>
        )}

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

                    <div
                      className="adminClientAction"
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '8px',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btnOutline"
                        disabled={clientActionId === client.id}
                        onClick={() =>
                          handleClientPlanAction(
                            client,
                            'standard'
                          )
                        }
                      >
                        C$200 Standard
                      </button>

                      <button
                        type="button"
                        className="btn btnPrimary"
                        disabled={clientActionId === client.id}
                        onClick={() =>
                          handleClientPlanAction(
                            client,
                            'pro'
                          )
                        }
                      >
                        C$300 Pro
                      </button>

                      <button
                        type="button"
                        className="btn btnOutline"
                        disabled={
                          clientActionId === client.id ||
                          client.subscription?.status ===
                            'cancelled'
                        }
                        onClick={() =>
                          handleClientPlanAction(
                            client,
                            'cancel'
                          )
                        }
                      >
                        Cancel
                      </button>

                      <a
                        href={`/admin/client/${client.id}`}
                        className="btn btnOutline"
                      >
                        Manage
                      </a>

                      <button
                        type="button"
                        className="btn btnOutline"
                        disabled={clientActionId === client.id}
                        onClick={() =>
                          handleDeleteClient(client)
                        }
                      >
                        {clientActionId === client.id
                          ? 'Working...'
                          : 'Remove Client'}
                      </button>
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
