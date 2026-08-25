import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'cancelled'

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
  monthly_minutes: number | null
  ai_model_id: string | null
  status: SubscriptionStatus
}

type AIModel = {
  id: string
  display_name: string
  provider: string
  tier_name: string
  customer_price_per_minute_cad: number | null
  sort_order: number
}

type AgentRecord = {
  client_id: string
  retell_agent_id: string | null
}

type ClientWithSubscription = ClientRecord & {
  subscription: SubscriptionRecord | null
  agent: AgentRecord | null
}

type ClientDraft = {
  plan_name: 'Recepta Standard' | 'Recepta Pro'
  monthly_minutes: string
  ai_model_id: string
  retell_agent_id: string
}

export default function Admin() {
  const [clients, setClients] =
    useState<ClientWithSubscription[]>([])

  const [models, setModels] =
    useState<AIModel[]>([])

  const [drafts, setDrafts] =
    useState<Record<string, ClientDraft>>({})

  const [loading, setLoading] = useState(true)

  // ADMIN AUTH
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

  // SEARCH
  const [search, setSearch] =
    useState('')

  // CREATE CLIENT
  const [companyName, setCompanyName] =
    useState('')

  const [email, setEmail] =
    useState('')

  const [password, setPassword] =
    useState('')

  const [creating, setCreating] =
    useState(false)

  const [createError, setCreateError] =
    useState('')

  const [createSuccess, setCreateSuccess] =
    useState('')

  // CLIENT ACTIONS
  const [clientActionId, setClientActionId] =
    useState<string | null>(null)

  const [
    clientActionError,
    setClientActionError,
  ] = useState('')

  const [
    clientActionSuccess,
    setClientActionSuccess,
  ] = useState('')

  const loadData = async () => {
    setLoading(true)

    const [
      clientsResult,
      subscriptionsResult,
      modelsResult,
      agentsResult,
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
          `
          client_id,
          plan_name,
          monthly_price,
          monthly_minutes,
          ai_model_id,
          status
          `
        ),

      supabase
        .from('ai_models')
        .select(
          `
          id,
          display_name,
          provider,
          tier_name,
          customer_price_per_minute_cad,
          sort_order
          `
        )
        .eq('is_active', true)
        .order('sort_order', {
          ascending: true,
        }),

      supabase
        .from('agents')
        .select(
          'client_id, retell_agent_id'
        ),
    ])

    if (
      clientsResult.error ||
      subscriptionsResult.error ||
      modelsResult.error ||
      agentsResult.error
    ) {
      console.error(
        clientsResult.error ||
          subscriptionsResult.error ||
          modelsResult.error ||
          agentsResult.error
      )

      setLoading(false)
      return
    }

    const subscriptions =
      (subscriptionsResult.data ||
        []) as SubscriptionRecord[]

    const aiModels =
      (modelsResult.data ||
        []) as AIModel[]

    const agents =
      (agentsResult.data ||
        []) as AgentRecord[]

    const combined =
      (clientsResult.data ||
        []).map((client) => ({
        ...client,

        subscription:
          subscriptions.find(
            (subscription) =>
              subscription.client_id ===
              client.id
          ) || null,

        agent:
          agents.find(
            (agent) =>
              agent.client_id ===
              client.id
          ) || null,
      })) as ClientWithSubscription[]

    setClients(combined)
    setModels(aiModels)

    const nextDrafts: Record<
      string,
      ClientDraft
    > = {}

    combined.forEach((client) => {
      const existingPlan =
        client.subscription?.plan_name ===
        'Recepta Pro'
          ? 'Recepta Pro'
          : 'Recepta Standard'

      nextDrafts[client.id] = {
        plan_name: existingPlan,

        monthly_minutes: String(
          client.subscription
            ?.monthly_minutes ?? 300
        ),

        ai_model_id:
          client.subscription
            ?.ai_model_id ||
          aiModels[0]?.id ||
          '',

        retell_agent_id:
          client.agent
            ?.retell_agent_id ||
          '',
      }
    })

    setDrafts(nextDrafts)

    setLoading(false)
  }

  useEffect(() => {
    let mounted = true

    const checkAdmin = async () => {
      try {
        const {
          data: { user },
        } =
          await supabase.auth.getUser()

        if (!mounted) return

        if (
          user?.email?.toLowerCase() ===
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
        setLoginError(
          'Invalid email or password.'
        )

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
    setAdminEmail('')
    setAdminPassword('')
    setClients([])
    setDrafts({})
  }

  const filteredClients =
    useMemo(() => {
      const query =
        search.trim().toLowerCase()

      if (!query) {
        return clients
      }

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

      pending: clients.filter(
        (client) =>
          !client.subscription ||
          client.subscription.status ===
            'pending'
      ).length,

      pro: clients.filter(
        (client) =>
          client.subscription?.plan_name ===
          'Recepta Pro'
      ).length,
    }
  }, [clients])

  const updateDraft = (
    clientId: string,
    field: keyof ClientDraft,
    value: string
  ) => {
    setDrafts((current) => ({
      ...current,

      [clientId]: {
        ...(current[clientId] || {
          plan_name:
            'Recepta Standard',
          monthly_minutes: '300',
          ai_model_id:
            models[0]?.id || '',
          retell_agent_id: '',
        }),

        [field]: value,
      },
    }))
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
      } =
        await supabase.auth.getSession()

      if (!session) {
        throw new Error(
          'Admin session expired.'
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
  companyName,
  email,
  password,
}),
        }
      )

      const result =
        await response.json()

      if (!response.ok) {
        throw new Error(
          result.error ||
            'Could not create client.'
        )
      }

      setCreateSuccess(
        `${companyName} was created.`
      )

      setCompanyName('')
      setEmail('')
      setPassword('')

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

  const getAdminSession =
    async () => {
      const {
        data: { session },
      } =
        await supabase.auth.getSession()

      if (!session) {
        throw new Error(
          'Admin session expired.'
        )
      }

      return session
    }

const handleSaveActivate = async (
  client: ClientWithSubscription
) => {
  const draft = drafts[client.id]

  if (!draft) return

  const minutes = Number(
    draft.monthly_minutes
  )

  if (
    !Number.isFinite(minutes) ||
    minutes < 1
  ) {
    setClientActionError(
      'Monthly minutes must be at least 1.'
    )
    return
  }

  if (!draft.ai_model_id) {
    setClientActionError(
      'Choose an AI model.'
    )
    return
  }

  const active =
    client.subscription?.status ===
    'active'

  const label = active
    ? 'save these changes for'
    : 'activate'

  if (
    !window.confirm(
      `Are you sure you want to ${label} ${
        client.company_name ||
        client.contact_email ||
        'this client'
      }?`
    )
  ) {
    return
  }

  setClientActionId(client.id)
  setClientActionError('')
  setClientActionSuccess('')

  try {
    const session =
      await getAdminSession()

    const response = await fetch(
      '/.netlify/functions/update-client-plan',
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
          planName: draft.plan_name,
          monthlyMinutes:
            Math.floor(minutes),
          aiModelId:
            draft.ai_model_id,
        }),
      }
    )

    const result =
      await response.json()

    if (!response.ok) {
      throw new Error(
        result.error ||
          'Could not update client.'
      )
    }

    const retellResponse = await fetch(
      '/.netlify/functions/update-client-agent',
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
          retellAgentId:
            draft.retell_agent_id.trim() ||
            null,
        }),
      }
    )

    const retellResult =
      await retellResponse.json()

    if (!retellResponse.ok) {
      throw new Error(
        retellResult.error ||
          'Subscription saved, but Retell Agent ID could not be saved.'
      )
    }

    setClientActionSuccess(
      active
        ? `${
            client.company_name ||
            'Client'
          } updated.`
        : `${
            client.company_name ||
            'Client'
          } activated.`
    )

    await loadData()
  } catch (error) {
    setClientActionError(
      error instanceof Error
        ? error.message
        : 'Could not save client.'
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
        `Permanently delete ${clientName}?`
      )
    ) {
      return
    }

    setClientActionId(client.id)
    setClientActionError('')
    setClientActionSuccess('')

    try {
      const session =
        await getAdminSession()

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
        await response.json()

      if (!response.ok) {
        throw new Error(
          result.error ||
            'Could not delete client.'
        )
      }

      setClientActionSuccess(
        `${clientName} deleted.`
      )

      await loadData()
    } catch (error) {
      setClientActionError(
        error instanceof Error
          ? error.message
          : 'Could not delete client.'
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
            Checking admin access...
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
              </div>
            </div>

            <form
              className="adminNewClientForm"
              onSubmit={
                handleAdminLogin
              }
            >
              <label>
                <span>Email</span>

                <input
                  type="email"
                  value={adminEmail}
                  onChange={(event) =>
                    setAdminEmail(
                      event.target.value
                    )
                  }
                  required
                />
              </label>

              <label>
                <span>Password</span>

                <input
                  type="password"
                  value={
                    adminPassword
                  }
                  onChange={(event) =>
                    setAdminPassword(
                      event.target.value
                    )
                  }
                  required
                />
              </label>

              <div className="adminCreateAction">
                <button
                  className="btn btnPrimary"
                  type="submit"
                  disabled={
                    loggingIn
                  }
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
              Create clients, configure subscriptions
              and link their Retell agents.
            </p>
          </div>

          <button
            type="button"
            className="btn btnOutline"
            onClick={
              handleAdminLogout
            }
          >
            Sign out
          </button>
        </header>

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
              ACTIVE
            </span>

            <strong>
              {stats.active}
            </strong>
          </div>

          <div className="adminStatCard">
            <span>
              PENDING
            </span>

            <strong>
              {stats.pending}
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
                Create their login first.
                You will activate their
                subscription separately.
              </p>
            </div>
          </div>

          <form
            className="adminNewClientForm"
            onSubmit={
              handleCreateClient
            }
          >
            <label>
              <span>
                Company name
              </span>

              <input
                value={
                  companyName
                }
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
                minLength={8}
                required
              />
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
          ) : filteredClients.length ===
            0 ? (
            <div className="adminEmpty">
              No clients found.
            </div>
          ) : (
            <div className="adminSubscriptionList">
              {filteredClients.map(
                (client) => {
                  const draft =
                    drafts[client.id]

                  const working =
                    clientActionId ===
                    client.id

                  const active =
                    client.subscription
                      ?.status ===
                    'active'

                  return (
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
                            {active
                              ? 'Active'
                              : client.subscription
                                  ?.status ||
                                'Pending'}
                          </small>
                        </div>
                      </div>

                      <div className="adminSubscriptionControls">
                        <label>
                          <span>
                            Plan
                          </span>

                          <select
                            value={
                              draft
                                ?.plan_name ||
                              'Recepta Standard'
                            }
                            onChange={(
                              event
                            ) =>
                              updateDraft(
                                client.id,
                                'plan_name',
                                event.target
                                  .value
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
                            value={
                              draft
                                ?.monthly_minutes ||
                              '300'
                            }
                            onChange={(
                              event
                            ) =>
                              updateDraft(
                                client.id,
                                'monthly_minutes',
                                event.target
                                  .value
                              )
                            }
                          />
                        </label>

                        <label>
                          <span>
                            AI Model
                          </span>

                          <select
                            value={
                              draft
                                ?.ai_model_id ||
                              ''
                            }
                            onChange={(
                              event
                            ) =>
                              updateDraft(
                                client.id,
                                'ai_model_id',
                                event.target
                                  .value
                              )
                            }
                          >
                            {models.map(
                              (model) => (
                                <option
                                  key={
                                    model.id
                                  }
                                  value={
                                    model.id
                                  }
                                >
                                  {
                                    model.display_name
                                  }
                                </option>
                              )
                            )}
                          </select>
                        </label>

                        <label>
                          <span>
                            Retell Agent ID
                          </span>

                          <input
                            type="text"
                            value={
                              draft
                                ?.retell_agent_id ||
                              ''
                            }
                            onChange={(
                              event
                            ) =>
                              updateDraft(
                                client.id,
                                'retell_agent_id',
                                event.target
                                  .value
                              )
                            }
                            placeholder="agent_xxxxxxxxx"
                            autoComplete="off"
                          />
                        </label>

                        <button
                          type="button"
                          className="btn btnPrimary"
                          disabled={working}
                          onClick={() =>
                            handleSaveActivate(
                              client
                            )
                          }
                        >
                          {working
                            ? 'Saving...'
                            : active
                              ? 'Save'
                              : 'Save / Activate'}
                        </button>

                        <button
                          type="button"
                          className="btn btnOutline employeeDeleteButton"
                          disabled={working}
                          onClick={() =>
                            handleDeleteClient(
                              client
                            )
                          }
                        >
                          Delete Client
                        </button>
                      </div>
                    </div>
                  )
                }
              )}
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
