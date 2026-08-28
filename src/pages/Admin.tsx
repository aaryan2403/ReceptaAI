import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

type PlanName = 'Recepta Standard' | 'Recepta Pro'
type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'cancelled'

type ClientRecord = {
  id: string
  company_name: string | null
  contact_email: string | null
  created_at: string
}

type SubscriptionRecord = {
  client_id: string
  plan_name: string | null
  monthly_price: number | null
  monthly_minutes: number | null
  ai_model_id: string | null
  status: SubscriptionStatus
}

type AIModel = {
  id: string
  display_name: string
  provider: string
  tier_name: string
  sort_order: number
}

type ClientWithSubscription = ClientRecord & {
  subscription: SubscriptionRecord | null
}

export default function Admin() {
  const [clients, setClients] =
    useState<ClientWithSubscription[]>([])
  const [models, setModels] =
    useState<AIModel[]>([])
  const [loading, setLoading] = useState(true)

  const [checkingAdmin, setCheckingAdmin] =
    useState(true)
  const [isAdmin, setIsAdmin] =
    useState(false)
  const [adminEmail, setAdminEmail] =
    useState('')
  const [adminPassword, setAdminPassword] =
    useState('')
  const [loginError, setLoginError] =
    useState('')
  const [loggingIn, setLoggingIn] =
    useState(false)

  const [companyName, setCompanyName] =
    useState('')
  const [email, setEmail] =
    useState('')
  const [password, setPassword] =
    useState('')
  const [planName, setPlanName] =
    useState<PlanName>('Recepta Standard')
  const [monthlyMinutes, setMonthlyMinutes] =
    useState('300')
  const [aiModelId, setAiModelId] =
    useState('')
  const [retellAgentId, setRetellAgentId] =
    useState('')
  const [creating, setCreating] =
    useState(false)
  const [createError, setCreateError] =
    useState('')
  const [createSuccess, setCreateSuccess] =
    useState('')

  const [deletingId, setDeletingId] =
    useState<string | null>(null)
  const [actionError, setActionError] =
    useState('')
  const [actionSuccess, setActionSuccess] =
    useState('')

  const [search, setSearch] =
    useState('')

  const loadData = async () => {
    setLoading(true)

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setLoading(false)
      return
    }

    const [adminClientsResponse, modelsResult] =
      await Promise.all([
        fetch('/.netlify/functions/admin-clients', {
          headers: {
            Authorization:
              `Bearer ${session.access_token}`,
          },
        }),

        supabase
          .from('ai_models')
          .select(
            `
            id,
            display_name,
            provider,
            tier_name,
            sort_order
            `
          )
          .eq('is_active', true)
          .order('sort_order', {
            ascending: true,
          }),
      ])

    const adminClientsResult =
      await adminClientsResponse
        .json()
        .catch(() => ({}))

    if (
      !adminClientsResponse.ok ||
      modelsResult.error
    ) {
      console.error(
        adminClientsResult?.error ||
          modelsResult.error
      )
      setLoading(false)
      return
    }

    const subscriptions =
      (adminClientsResult.subscriptions ||
        []) as SubscriptionRecord[]

    const clientRows =
      (adminClientsResult.clients ||
        []) as ClientRecord[]

    const combined =
      clientRows.map((client) => ({
        ...client,
        subscription:
          subscriptions.find(
            (subscription) =>
              subscription.client_id === client.id
          ) || null,
      }))

    const aiModels =
      (modelsResult.data ||
        []) as AIModel[]

    setClients(combined)
    setModels(aiModels)

    setAiModelId((current) =>
      current || aiModels[0]?.id || ''
    )

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
          user?.email
            ?.trim()
            .toLowerCase() ===
          ADMIN_EMAIL.toLowerCase()
        ) {
          setIsAdmin(true)
          await loadData()
        } else {
          setIsAdmin(false)

          if (user) {
            await supabase.auth.signOut()
          }
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
        setLoginError(
          'Invalid email or password.'
        )
        return
      }

      if (
        data.user.email
          ?.trim()
          .toLowerCase() !==
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
      await loadData()
    } catch {
      setLoginError(
        'Could not connect to the server.'
      )
    } finally {
      setLoggingIn(false)
    }
  }

  const handleAdminLogout = async () => {
    await supabase.auth.signOut()
    setIsAdmin(false)
    setClients([])
  }

  const handleCreateClient = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setCreating(true)
    setCreateError('')
    setCreateSuccess('')
    setActionError('')
    setActionSuccess('')

    try {
      const minutes = Number(monthlyMinutes)

      if (
        !Number.isFinite(minutes) ||
        minutes < 1
      ) {
        throw new Error(
          'Monthly minutes must be at least 1.'
        )
      }

      if (!aiModelId) {
        throw new Error(
          'Choose an AI model.'
        )
      }

      const normalizedRetellId =
        retellAgentId.trim()

      if (
        normalizedRetellId &&
        !normalizedRetellId.startsWith(
          'agent_'
        )
      ) {
        throw new Error(
          'Retell Agent ID must start with agent_.'
        )
      }

      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error(
          'Admin session expired. Sign in again.'
        )
      }

      const response = await fetch(
        '/.netlify/functions/create-client',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            companyName:
              companyName.trim(),
            email:
              email.trim().toLowerCase(),
            password,
            planName,
            monthlyMinutes:
              Math.floor(minutes),
            aiModelId,
            retellAgentId:
              normalizedRetellId || null,
          }),
        }
      )

      const result =
        await response
          .json()
          .catch(() => ({}))

      if (!response.ok) {
        throw new Error(
          result?.error ||
            'Could not create client.'
        )
      }

      setCreateSuccess(
        `${companyName.trim()} created successfully.`
      )

      setCompanyName('')
      setEmail('')
      setPassword('')
      setPlanName(
        'Recepta Standard'
      )
      setMonthlyMinutes('300')
      setAiModelId(
        models[0]?.id || ''
      )
      setRetellAgentId('')

      await loadData()
    } catch (error) {
      setCreateError(
        error instanceof Error
          ? error.message
          : 'Could not create client.'
      )
    } finally {
      setCreating(false)
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
        `Permanently delete ${clientName}?`
      )
    ) {
      return
    }

    setDeletingId(client.id)
    setActionError('')
    setActionSuccess('')

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error(
          'Admin session expired. Sign in again.'
        )
      }

      const response = await fetch(
        '/.netlify/functions/delete-client',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            clientId: client.id,
          }),
        }
      )

      const result =
        await response
          .json()
          .catch(() => ({}))

      if (!response.ok) {
        throw new Error(
          result?.error ||
            'Could not delete client.'
        )
      }

      setActionSuccess(
        `${clientName} deleted.`
      )

      await loadData()
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Could not delete client.'
      )
    } finally {
      setDeletingId(null)
    }
  }

  const filteredClients = useMemo(() => {
    const query =
      search.trim().toLowerCase()

    if (!query) return clients

    return clients.filter(
      (client) =>
        client.company_name
          ?.toLowerCase()
          .includes(query) ||
        client.contact_email
          ?.toLowerCase()
          .includes(query)
    )
  }, [clients, search])

  const stats = useMemo(() => {
    return {
      total: clients.length,
      active: clients.filter(
        (client) =>
          client.subscription?.status ===
          'active'
      ).length,
      pro: clients.filter(
        (client) =>
          client.subscription?.plan_name ===
          'Recepta Pro'
      ).length,
    }
  }, [clients])

  const modelName = (
    id: string | null | undefined
  ) =>
    models.find(
      (model) => model.id === id
    )?.display_name || 'Not assigned'

  if (checkingAdmin) {
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#030a06',
          color: '#fff',
        }}
      >
        Checking admin access...
      </main>
    )
  }

  if (!isAdmin) {
    return (
      <main
        style={{
          minHeight: '100vh',
          width: '100%',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: '#030a06',
          color: '#fff',
          boxSizing: 'border-box',
        }}
      >
        <section
          style={{
            width: '100%',
            maxWidth: '480px',
            padding: '36px',
            border:
              '1px solid rgba(0,230,118,0.15)',
            borderRadius: '24px',
            background:
              'rgba(8,25,16,0.95)',
            boxSizing: 'border-box',
          }}
        >
          <span className="adminEyebrow">
            RECEPTA ADMIN
          </span>

          <h1
            style={{
              margin:
                '10px 0 8px',
            }}
          >
            Admin login
          </h1>

          <p
            style={{
              margin:
                '0 0 24px',
              opacity: 0.7,
            }}
          >
            Sign in to the Recepta
            administration portal.
          </p>

          <form
            onSubmit={handleAdminLogin}
            style={{
              display: 'grid',
              gap: '16px',
            }}
          >
            <label
              style={{
                display: 'grid',
                gap: '8px',
              }}
            >
              <span>Email</span>

              <input
                type="email"
                value={adminEmail}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setAdminEmail(
                    event.target.value
                  )
                }
                required
                style={{
                  width: '100%',
                  boxSizing:
                    'border-box',
                }}
              />
            </label>

            <label
              style={{
                display: 'grid',
                gap: '8px',
              }}
            >
              <span>Password</span>

              <input
                type="password"
                value={adminPassword}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setAdminPassword(
                    event.target.value
                  )
                }
                required
                style={{
                  width: '100%',
                  boxSizing:
                    'border-box',
                }}
              />
            </label>

            {loginError && (
              <p className="adminFormMessage adminFormMessage--error">
                {loginError}
              </p>
            )}

            <button
              type="submit"
              className="btn btnPrimary"
              disabled={loggingIn}
              style={{
                width: '100%',
              }}
            >
              {loggingIn
                ? 'Signing in...'
                : 'Sign in'}
            </button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className="adminPage">
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
              <strong>Recepta</strong>
              <span>ADMIN</span>
            </div>
          </a>

          <nav className="adminNav">
            <a
              href="/admin"
              className="adminNavItem adminNavItem--active"
            >
              Clients
            </a>
          </nav>
        </div>
      </aside>

      <section className="adminMain">
        <header className="adminHeader">
          <div>
            <span className="adminEyebrow">
              RECEPTA ADMIN
            </span>

            <h1>
              Client Control Center
            </h1>

            <p>
              Create a client once. Their
              plan, dashboard, billing
              configuration and AI model are
              assigned immediately.
            </p>
          </div>

          <button
            type="button"
            className="btn btnOutline"
            onClick={handleAdminLogout}
          >
            Sign out
          </button>
        </header>

        <div className="adminStats">
          <div className="adminStatCard">
            <span>TOTAL CLIENTS</span>
            <strong>{stats.total}</strong>
          </div>

          <div className="adminStatCard">
            <span>ACTIVE</span>
            <strong>{stats.active}</strong>
          </div>

          <div className="adminStatCard">
            <span>PRO CLIENTS</span>
            <strong>{stats.pro}</strong>
          </div>
        </div>

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
                Standard gets Overview,
                Calls, Agent, Billing and
                Settings. Pro also gets
                Appointments and Employees.
              </p>
            </div>
          </div>

          <form
            className="adminNewClientForm"
            onSubmit={handleCreateClient}
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '16px',
              alignItems: 'end',
            }}
          >
            <label>
              <span>Company name</span>
              <input
                value={companyName}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setCompanyName(
                    event.target.value
                  )
                }
                placeholder="ABC Plumbing"
                required
              />
            </label>

            <label>
              <span>Client email</span>
              <input
                type="email"
                value={email}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
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
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setPassword(
                    event.target.value
                  )
                }
                minLength={8}
                required
              />
            </label>

            <label>
              <span>Plan</span>
              <select
                value={planName}
                onChange={(
                  event: ChangeEvent<HTMLSelectElement>
                ) =>
                  setPlanName(
                    event.target.value as PlanName
                  )
                }
              >
                <option value="Recepta Standard">
                  Standard — C$200
                </option>
                <option value="Recepta Pro">
                  Pro — C$300
                </option>
              </select>
            </label>

            <label>
              <span>
                Monthly Minutes
              </span>
              <input
                type="number"
                min="1"
                step="1"
                value={monthlyMinutes}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setMonthlyMinutes(
                    event.target.value
                  )
                }
                required
              />
            </label>

            <label>
              <span>AI Model</span>
              <select
                value={aiModelId}
                onChange={(
                  event: ChangeEvent<HTMLSelectElement>
                ) =>
                  setAiModelId(
                    event.target.value
                  )
                }
                required
              >
                <option
                  value=""
                  disabled
                >
                  Choose AI model
                </option>

                {models.map(
                  (model) => (
                    <option
                      key={model.id}
                      value={model.id}
                    >
                      {model.display_name}
                    </option>
                  )
                )}
              </select>
            </label>

            <label>
              <span>
                Retell Agent ID{' '}
                <small>(optional)</small>
              </span>
              <input
                value={retellAgentId}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
                  setRetellAgentId(
                    event.target.value
                  )
                }
                placeholder="agent_xxxxxxxxx"
              />
            </label>

            <div className="adminCreateAction">
              <button
                className="btn btnPrimary"
                type="submit"
                disabled={
                  creating ||
                  models.length === 0
                }
              >
                {creating
                  ? 'Creating...'
                  : 'Create & Activate Client'}
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

        {actionError && (
          <p className="adminFormMessage adminFormMessage--error">
            {actionError}
          </p>
        )}

        {actionSuccess && (
          <p className="adminFormMessage adminFormMessage--success">
            {actionSuccess}
          </p>
        )}

        <section className="adminPanel">
          <div className="adminClientHeader">
            <div>
              <span className="adminEyebrow">
                CLIENTS
              </span>
              <h2>Current clients</h2>
            </div>

            <div className="adminSearch">
              <input
                type="search"
                value={search}
                onChange={(
                  event: ChangeEvent<HTMLInputElement>
                ) =>
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
          ) : filteredClients.length ===
            0 ? (
            <div className="adminEmpty">
              No clients found.
            </div>
          ) : (
            <div className="adminSubscriptionList">
              {filteredClients.map(
                (client) => (
                  <div
                    key={client.id}
                    className="adminSubscriptionCard"
                  >
                    <div className="adminSubscriptionClient">
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

                        <small>
                          {client.subscription
                            ?.plan_name ||
                            'No plan'}
                          {' · '}
                          {client.subscription
                            ?.status ||
                            'pending'}
                          {' · '}
                          {modelName(
                            client.subscription
                              ?.ai_model_id
                          )}
                        </small>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        justifyContent:
                          'flex-end',
                        alignItems:
                          'center',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btnOutline employeeDeleteButton"
                        disabled={
                          deletingId ===
                          client.id
                        }
                        onClick={() =>
                          handleDeleteClient(
                            client
                          )
                        }
                      >
                        {deletingId ===
                        client.id
                          ? 'Deleting...'
                          : 'Delete Client'}
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
