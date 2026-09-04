import {
  useEffect,
  useMemo,
  useState,
} from 'react'
import type {
  ChangeEvent,
  FormEvent,
} from 'react'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'
const MAX_MONTHLY_MINUTES = 100_000_000
const PII_RATE_CAD = 0.014
const GUARDRAIL_RATE_CAD = 0.007
const EXTRA_NUMBER_MONTHLY_CAD = 20

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
  pii_redaction_enabled: boolean
  safety_guardrails_enabled: boolean
  extra_phone_numbers: number
  current_period_start: string | null
  current_period_end: string | null
  status: SubscriptionStatus
}

type AIModel = {
  id: string
  display_name: string
  provider: string
  tier_name: string
  sort_order: number
  customer_price_per_minute_cad: number | null
}

type AgentRecord = {
  client_id: string
  retell_agent_id: string | null
  phone_number: string | null
  phone_numbers?: string[]
  status: string | null
}

type ClientWithSubscription = ClientRecord & {
  subscription: SubscriptionRecord | null
  agent: AgentRecord | null
}

const calculateTotal = (
  models: AIModel[],
  selectedPlan: PlanName,
  minutesValue: string,
  selectedModelId: string,
  piiEnabled: boolean,
  guardrailsEnabled: boolean,
  extraPhoneNumbers = 0
) => {
  const minutes = Math.max(
    0,
    Math.floor(Number(minutesValue) || 0)
  )
  const model = models.find(
    (row) => row.id === selectedModelId
  )
  const modelRate = Math.max(
    0,
    Number(
      model?.customer_price_per_minute_cad ?? 0
    ) || 0
  )
  const base =
    selectedPlan === 'Recepta Pro' ? 300 : 200

  return (
    base +
    minutes * modelRate +
    (piiEnabled ? minutes * PII_RATE_CAD : 0) +
    (guardrailsEnabled
      ? minutes * GUARDRAIL_RATE_CAD
      : 0) +
    Math.max(0, extraPhoneNumbers) *
      EXTRA_NUMBER_MONTHLY_CAD
  )
}

const parsePhoneNumberInput = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\n,;]+/)
        .map((phoneNumber) => phoneNumber.trim())
        .filter(Boolean)
    )
  )

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
  const [phoneNumber, setPhoneNumber] =
    useState('')
  const [purchasePhoneNumbers, setPurchasePhoneNumbers] =
    useState('0')
  const [phoneCountryCode, setPhoneCountryCode] =
    useState<'CA' | 'US'>('CA')
  const [phoneAreaCode, setPhoneAreaCode] =
    useState('')
  const [piiRedaction, setPiiRedaction] =
    useState(false)
  const [safetyGuardrails, setSafetyGuardrails] =
    useState(false)
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

  const [editingClient, setEditingClient] =
    useState<ClientWithSubscription | null>(null)
  const [editCompanyName, setEditCompanyName] =
    useState('')
  const [editEmail, setEditEmail] =
    useState('')
  const [editPlanName, setEditPlanName] =
    useState<PlanName>('Recepta Standard')
  const [editMonthlyMinutes, setEditMonthlyMinutes] =
    useState('300')
  const [editAiModelId, setEditAiModelId] =
    useState('')
  const [editRetellAgentId, setEditRetellAgentId] =
    useState('')
  const [editPhoneNumber, setEditPhoneNumber] =
    useState('')
  const [editPiiRedaction, setEditPiiRedaction] =
    useState(false)
  const [
    editSafetyGuardrails,
    setEditSafetyGuardrails,
  ] = useState(false)
  const [editPassword, setEditPassword] =
    useState('')
  const [editPurchaseQuantity, setEditPurchaseQuantity] =
    useState('1')
  const [editPhoneCountry, setEditPhoneCountry] =
    useState<'CA' | 'US'>('CA')
  const [editPhoneAreaCode, setEditPhoneAreaCode] =
    useState('')
  const [purchasingPhoneNumbers, setPurchasingPhoneNumbers] =
    useState(false)
  const [savingEdit, setSavingEdit] =
    useState(false)
  const [editError, setEditError] =
    useState('')

  const createMonthlyTotal = useMemo(
    () =>
      calculateTotal(
        models,
        planName,
        monthlyMinutes,
        aiModelId,
        piiRedaction,
        safetyGuardrails,
        Math.max(
          0,
          parsePhoneNumberInput(phoneNumber).length +
            Math.max(0, Math.floor(Number(purchasePhoneNumbers) || 0)) -
            1
        )
      ),
    [
      planName,
      monthlyMinutes,
      aiModelId,
      piiRedaction,
      safetyGuardrails,
      phoneNumber,
      purchasePhoneNumbers,
      models,
    ]
  )

  const editMonthlyTotal = useMemo(
    () =>
      calculateTotal(
        models,
        editPlanName,
        editMonthlyMinutes,
        editAiModelId,
        editPiiRedaction,
        editSafetyGuardrails,
        Math.max(
          0,
          parsePhoneNumberInput(editPhoneNumber).length - 1
        )
      ),
    [
      editPlanName,
      editMonthlyMinutes,
      editAiModelId,
      editPiiRedaction,
      editSafetyGuardrails,
      editPhoneNumber,
      models,
    ]
  )

  const loadData = async () => {
    setLoading(true)

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
        '/.netlify/functions/admin-clients',
        {
          method: 'GET',
          headers: {
            Authorization:
              `Bearer ${session.access_token}`,
          },
        }
      )

      const result =
        (await response
          .json()
          .catch(() => ({}))) as {
          error?: string
          clients?: ClientRecord[]
          subscriptions?: SubscriptionRecord[]
          agents?: AgentRecord[]
          models?: AIModel[]
        }

      if (!response.ok) {
        throw new Error(
          result.error ||
            'Could not load clients.'
        )
      }

      const clientRows =
        result.clients || []
      const subscriptions =
        result.subscriptions || []
      const agents = result.agents || []
      const loadedModels =
        result.models || []

      const loadedClients =
        clientRows.map((client) => ({
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
        }))

      setClients(loadedClients)
      setModels(loadedModels)
      setActionError('')

      setAiModelId((current) =>
        current ||
        loadedModels[0]?.id ||
        ''
      )
    } catch (error) {
      console.error(
        'Load clients error:',
        error
      )
      setActionError(
        error instanceof Error
          ? error.message
          : 'Could not load clients.'
      )
    } finally {
      setLoading(false)
    }
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
        minutes < 1 ||
        minutes > MAX_MONTHLY_MINUTES
      ) {
        throw new Error(
          'Monthly minutes must be between 1 and 100,000,000.'
        )
      }

      if (!aiModelId) {
        throw new Error(
          'Choose an AI model.'
        )
      }

      const normalizedRetellId =
        retellAgentId.trim()
      const requestedPurchaseCount = Number(
        purchasePhoneNumbers
      )
      const existingPhoneNumbers =
        parsePhoneNumberInput(phoneNumber)

      if (
        !Number.isInteger(requestedPurchaseCount) ||
        requestedPurchaseCount < 0 ||
        requestedPurchaseCount > 21 ||
        existingPhoneNumbers.length + requestedPurchaseCount > 21
      ) {
        throw new Error(
          'A client can have at most 21 phone numbers, including the primary number.'
        )
      }

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

      if (requestedPurchaseCount > 0 && !normalizedRetellId) {
        throw new Error(
          'Enter the Retell Agent ID before purchasing phone numbers.'
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
            phoneNumbers:
              existingPhoneNumbers,
            purchasePhoneNumbers:
              requestedPurchaseCount,
            phoneCountryCode,
            phoneAreaCode:
              phoneCountryCode === 'US'
                ? phoneAreaCode.trim() || null
                : null,
            piiRedactionEnabled:
              piiRedaction,
            safetyGuardrailsEnabled:
              safetyGuardrails,
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
      setPhoneNumber('')
      setPurchasePhoneNumbers('0')
      setPhoneCountryCode('CA')
      setPhoneAreaCode('')
      setPiiRedaction(false)
      setSafetyGuardrails(false)

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

  const openEditClient = (
    client: ClientWithSubscription
  ) => {
    setEditingClient(client)
    setEditCompanyName(
      client.company_name || ''
    )
    setEditEmail(
      client.contact_email || ''
    )
    setEditPlanName(
      client.subscription?.plan_name ===
        'Recepta Pro'
        ? 'Recepta Pro'
        : 'Recepta Standard'
    )
    setEditMonthlyMinutes(
      String(
        client.subscription?.monthly_minutes ||
          300
      )
    )
    setEditAiModelId(
      client.subscription?.ai_model_id ||
        models[0]?.id ||
        ''
    )
    setEditRetellAgentId(
      client.agent?.retell_agent_id || ''
    )
    setEditPhoneNumber(
      (
        client.agent?.phone_numbers?.length
          ? client.agent.phone_numbers
          : client.agent?.phone_number
            ? [client.agent.phone_number]
            : []
      ).join('\n')
    )
    setEditPiiRedaction(
      client.subscription
        ?.pii_redaction_enabled === true
    )
    setEditSafetyGuardrails(
      client.subscription
        ?.safety_guardrails_enabled === true
    )
    setEditPassword('')
    setEditPurchaseQuantity('1')
    setEditPhoneCountry('CA')
    setEditPhoneAreaCode('')
    setEditError('')
  }

  const openPhoneNumberManager = (
    client: ClientWithSubscription
  ) => {
    openEditClient(client)

    window.setTimeout(() => {
      document
        .getElementById('adminPhonePurchasePanel')
        ?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        })
    }, 0)
  }

  const updateClient = async (
    reactivateSubscription = false
  ) => {
    if (!editingClient) return

    setSavingEdit(true)
    setEditError('')
    setActionError('')
    setActionSuccess('')

    try {
      const minutes =
        Number(editMonthlyMinutes)

      if (
        !Number.isFinite(minutes) ||
        minutes < 1 ||
        minutes > MAX_MONTHLY_MINUTES
      ) {
        throw new Error(
          'Monthly minutes must be between 1 and 100,000,000.'
        )
      }

      if (!editAiModelId) {
        throw new Error(
          'Choose an AI model.'
        )
      }

      const normalizedRetellId =
        editRetellAgentId.trim()
      const editedPhoneNumbers =
        parsePhoneNumberInput(editPhoneNumber)

      if (editedPhoneNumbers.length > 21) {
        throw new Error(
          'A client can have at most 21 phone numbers, including the primary number.'
        )
      }

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

      if (
        editPassword &&
        editPassword.length < 8
      ) {
        throw new Error(
          'New temporary password must be at least 8 characters.'
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
        '/.netlify/functions/update-clients',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            Authorization:
              `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            clientId: editingClient.id,
            companyName:
              editCompanyName.trim(),
            email:
              editEmail.trim().toLowerCase(),
            planName: editPlanName,
            monthlyMinutes:
              Math.floor(minutes),
            aiModelId: editAiModelId,
            retellAgentId:
              normalizedRetellId || null,
            phoneNumbers:
              editedPhoneNumbers,
            newPassword:
              editPassword || null,
            reactivateSubscription,
            piiRedactionEnabled:
              editPiiRedaction,
            safetyGuardrailsEnabled:
              editSafetyGuardrails,
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
            'Could not update client.'
        )
      }

      setActionSuccess(
        reactivateSubscription
          ? `${editCompanyName.trim()} subscription reactivated.`
          : `${editCompanyName.trim()} updated.`
      )
      setEditingClient(null)
      setEditPassword('')
      await loadData()
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : 'Could not update client.'
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const handleSaveClientEdit = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()
    await updateClient(false)
  }

  const handleReactivateSubscription = async () => {
    if (
      !window.confirm(
        'Reactivate this client and restore dashboard access? This admin action does not create a new Stripe charge.'
      )
    ) {
      return
    }

    await updateClient(true)
  }

  const handlePurchasePhoneNumbers = async () => {
    if (!editingClient) return

    const quantity = Number(editPurchaseQuantity)
    const currentPhoneCount =
      editingClient.agent?.phone_numbers?.length ||
      (editingClient.agent?.phone_number ? 1 : 0)

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      currentPhoneCount + quantity > 21
    ) {
      setEditError(
        'Choose a valid quantity without exceeding 21 total phone numbers.'
      )
      return
    }

    if (
      !window.confirm(
        `Purchase ${quantity} real Retell phone ${
          quantity === 1 ? 'number' : 'numbers'
        } for this client now?`
      )
    ) {
      return
    }

    setPurchasingPhoneNumbers(true)
    setEditError('')

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error('Admin session expired. Sign in again.')
      }

      const response = await fetch(
        '/.netlify/functions/admin-purchase-phone-numbers',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            clientId: editingClient.id,
            quantity,
            countryCode: editPhoneCountry,
            areaCode:
              editPhoneCountry === 'US'
                ? editPhoneAreaCode.trim() || null
                : null,
          }),
        }
      )
      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(
          result?.error || 'Could not purchase phone numbers.'
        )
      }

      setActionSuccess(
        `${quantity} phone ${
          quantity === 1 ? 'number was' : 'numbers were'
        } purchased and assigned to ${editingClient.company_name || 'the client'}.`
      )
      setEditingClient(null)
      await loadData()
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : 'Could not purchase phone numbers.'
      )
    } finally {
      setPurchasingPhoneNumbers(false)
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
                Calls, Employees, Agent, Billing and
                Settings. Pro also gets Appointments.
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
                max={MAX_MONTHLY_MINUTES}
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

            <label>
              <span>
                Existing Recepta phone numbers{' '}
                <small>(optional)</small>
              </span>
              <textarea
                value={phoneNumber}
                onChange={(
                  event: ChangeEvent<HTMLTextAreaElement>
                ) =>
                  setPhoneNumber(
                    event.target.value
                  )
                }
                placeholder={"+14165550123\n+16475550123"}
              />
              <small>
                Paste any numbers already owned in Retell, one per line.
              </small>
            </label>

            <label>
              <span>Buy new Retell numbers now</span>
              <input
                type="number"
                min="0"
                max="21"
                step="1"
                value={purchasePhoneNumbers}
                onChange={(event) =>
                  setPurchasePhoneNumbers(event.target.value)
                }
              />
              <small>
                The first number is included. Each number after the first adds C$20/month.
              </small>
            </label>

            <label>
              <span>Number country</span>
              <select
                value={phoneCountryCode}
                onChange={(event) =>
                  setPhoneCountryCode(
                    event.target.value === 'US' ? 'US' : 'CA'
                  )
                }
              >
                <option value="CA">Canada</option>
                <option value="US">United States</option>
              </select>
            </label>

            {phoneCountryCode === 'US' && (
              <label>
                <span>
                  US area code <small>(optional)</small>
                </span>
                <input
                  inputMode="numeric"
                  maxLength={3}
                  value={phoneAreaCode}
                  onChange={(event) =>
                    setPhoneAreaCode(event.target.value)
                  }
                  placeholder="415"
                />
              </label>
            )}

            {Number(purchasePhoneNumbers) > 0 && (
              <p
                style={{
                  gridColumn: '1 / -1',
                  margin: 0,
                  color: '#ffcf66',
                }}
              >
                Creating this client will purchase {Math.floor(Number(purchasePhoneNumbers) || 0)}
                {' '}number{Math.floor(Number(purchasePhoneNumbers) || 0) === 1 ? '' : 's'} from Retell.
              </p>
            )}

            <div
              style={{
                gridColumn: '1 / -1',
                display: 'grid',
                gap: '12px',
                padding: '16px',
                border:
                  '1px solid rgba(255,255,255,0.12)',
                borderRadius: '14px',
              }}
            >
              <strong>Paid add-ons</strong>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <input
                  type="checkbox"
                  style={{
                    width: '18px',
                    minHeight: '18px',
                    padding: 0,
                    flex: '0 0 18px',
                  }}
                  checked={piiRedaction}
                  onChange={(event) =>
                    setPiiRedaction(
                      event.target.checked
                    )
                  }
                />
                <span>
                  PII Redaction — C$0.014 per
                  selected minute
                </span>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <input
                  type="checkbox"
                  style={{
                    width: '18px',
                    minHeight: '18px',
                    padding: 0,
                    flex: '0 0 18px',
                  }}
                  checked={safetyGuardrails}
                  onChange={(event) =>
                    setSafetyGuardrails(
                      event.target.checked
                    )
                  }
                />
                <span>
                  Safety Guardrails — C$0.007
                  per selected minute
                </span>
              </label>

              <strong
                style={{
                  color: '#00e676',
                  fontSize: '1.15rem',
                }}
              >
                Total monthly billing: C$
                {createMonthlyTotal.toFixed(2)}
              </strong>
            </div>

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
          ) : filteredClients.length === 0 ? (
            <div className="adminEmpty">
              No clients found.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gap: '14px',
                marginTop: '24px',
              }}
            >
              {filteredClients.map((client) => (
                <div
                  key={client.id}
                  style={{
                    display: 'grid',
                    gap: '18px',
                    padding: '20px',
                    border:
                      '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '18px',
                    background:
                      'rgba(255,255,255,0.025)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent:
                        'space-between',
                      gap: '18px',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '14px',
                        minWidth: 0,
                      }}
                    >
                      <div
                        className="adminClientAvatar"
                      >
                        {(client.company_name || 'C')
                          .slice(0, 2)
                          .toUpperCase()}
                      </div>

                      <div>
                        <strong
                          style={{
                            fontSize: '18px',
                            color: '#fff',
                          }}
                        >
                          {client.company_name ||
                            'Unnamed Client'}
                        </strong>

                        <div
                          style={{
                            marginTop: '4px',
                            color:
                              'rgba(255,255,255,0.62)',
                          }}
                        >
                          {client.contact_email ||
                            'No email'}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        gap: '10px',
                      }}
                    >
                      <button
                        type="button"
                        className="btn btnOutline"
                        onClick={() =>
                          openEditClient(client)
                        }
                      >
                        Edit Client
                      </button>

                      <button
                        type="button"
                        className="btn btnPrimary"
                        onClick={() =>
                          openPhoneNumberManager(client)
                        }
                      >
                        Add Phone Numbers
                      </button>

                      <button
                        type="button"
                        className="btn btnOutline employeeDeleteButton"
                        disabled={
                          deletingId === client.id
                        }
                        onClick={() =>
                          handleDeleteClient(client)
                        }
                      >
                        {deletingId === client.id
                          ? 'Deleting...'
                          : 'Delete Client'}
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fit, minmax(170px, 1fr))',
                      gap: '14px',
                    }}
                  >
                    <div>
                      <small>PLAN</small>
                      <div>
                        {client.subscription?.plan_name ||
                          'No plan'}
                      </div>
                    </div>

                    <div>
                      <small>MONTHLY MINUTES</small>
                      <div>
                        {client.subscription?.monthly_minutes ??
                          'Not set'}
                      </div>
                    </div>

                    <div>
                      <small>MONTHLY BILLING</small>
                      <div>
                        C$
                        {Number(
                          client.subscription
                            ?.monthly_price ?? 0
                        ).toFixed(2)}
                      </div>
                    </div>

                    <div>
                      <small>ADD-ONS</small>
                      <div>
                        {[
                          client.subscription
                            ?.pii_redaction_enabled
                            ? 'PII Redaction'
                            : null,
                          client.subscription
                            ?.safety_guardrails_enabled
                            ? 'Safety Guardrails'
                            : null,
                          (client.subscription
                            ?.extra_phone_numbers ?? 0) > 0
                            ? `${client.subscription?.extra_phone_numbers} extra phone ${
                                client.subscription?.extra_phone_numbers === 1
                                  ? 'number'
                                  : 'numbers'
                              }`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(', ') || 'None'}
                      </div>
                    </div>

                    <div>
                      <small>AI MODEL</small>
                      <div>
                        {modelName(
                          client.subscription
                            ?.ai_model_id
                        )}
                      </div>
                    </div>

                    <div>
                      <small>RETELL AGENT ID</small>
                      <div>
                        {client.agent?.retell_agent_id ||
                          'Not connected'}
                      </div>
                    </div>

                    <div>
                      <small>PHONE NUMBERS</small>
                      <div>
                        {client.agent?.phone_numbers?.length
                          ? client.agent.phone_numbers.join(', ')
                          : client.agent?.phone_number || 'Not assigned'}
                      </div>
                    </div>

                    <div>
                      <small>SUBSCRIPTION STATUS</small>
                      <div>
                        {client.subscription?.status ||
                          'pending'}
                      </div>
                    </div>

                    <div>
                      <small>AI STATUS</small>
                      <div>
                        {client.agent?.status ||
                          'setup'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {editingClient && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'grid',
              placeItems: 'center',
              padding: '24px',
              background:
                'rgba(0,0,0,0.72)',
            }}
            onMouseDown={(event) => {
              if (
                event.target ===
                event.currentTarget
              ) {
                setEditingClient(null)
              }
            }}
          >
            <section
              style={{
                width: 'min(900px, 100%)',
                maxHeight: '90vh',
                overflowY: 'auto',
                padding: '28px',
                border:
                  '1px solid rgba(0,230,118,0.18)',
                borderRadius: '24px',
                background: '#07140d',
                color: '#fff',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent:
                    'space-between',
                  gap: '16px',
                  alignItems: 'center',
                  marginBottom: '22px',
                }}
              >
                <div>
                  <span className="adminEyebrow">
                    EDIT CLIENT
                  </span>
                  <h2
                    style={{
                      margin: '8px 0 0',
                    }}
                  >
                    {editingClient.company_name ||
                      'Client'}
                  </h2>
                </div>

                <button
                  type="button"
                  className="btn btnOutline"
                  onClick={() =>
                    setEditingClient(null)
                  }
                >
                  Close
                </button>
              </div>

              <form
                onSubmit={
                  handleSaveClientEdit
                }
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fit, minmax(230px, 1fr))',
                  gap: '16px',
                }}
              >
                <label>
                  <span>Company name</span>
                  <input
                    value={editCompanyName}
                    onChange={(event) =>
                      setEditCompanyName(
                        event.target.value
                      )
                    }
                    required
                  />
                </label>

                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={editEmail}
                    onChange={(event) =>
                      setEditEmail(
                        event.target.value
                      )
                    }
                    required
                  />
                </label>

                <label>
                  <span>Plan</span>
                  <select
                    value={editPlanName}
                    onChange={(event) =>
                      setEditPlanName(
                        event.target
                          .value as PlanName
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
                  <span>Monthly Minutes</span>
                  <input
                    type="number"
                    min="1"
                    max={MAX_MONTHLY_MINUTES}
                    step="1"
                    value={editMonthlyMinutes}
                    onChange={(event) =>
                      setEditMonthlyMinutes(
                        event.target.value
                      )
                    }
                    required
                  />
                </label>

                <label>
                  <span>AI Model</span>
                  <select
                    value={editAiModelId}
                    onChange={(event) =>
                      setEditAiModelId(
                        event.target.value
                      )
                    }
                    required
                  >
                    {models.map((model) => (
                      <option
                        key={model.id}
                        value={model.id}
                      >
                        {model.display_name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Retell Agent ID</span>
                  <input
                    value={editRetellAgentId}
                    onChange={(event) =>
                      setEditRetellAgentId(
                        event.target.value
                      )
                    }
                    placeholder="agent_xxxxxxxxx"
                  />
                </label>

                <label>
                  <span>Recepta phone numbers</span>
                  <textarea
                    value={editPhoneNumber}
                    onChange={(event) =>
                      setEditPhoneNumber(
                        event.target.value
                      )
                    }
                    placeholder={"+14165550123\n+16475550123"}
                  />
                  <small>
                    One E.164 number per line. The first number is primary.
                  </small>
                </label>

                <div
                  id="adminPhonePurchasePanel"
                  style={{
                    gridColumn: '1 / -1',
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '14px',
                    padding: '16px',
                    border: '1px solid rgba(0,230,118,0.18)',
                    borderRadius: '14px',
                    background: 'rgba(0,230,118,0.035)',
                  }}
                >
                  <div style={{ gridColumn: '1 / -1' }}>
                    <strong>Purchase additional Retell numbers</strong>
                    <p style={{ margin: '6px 0 0', opacity: 0.65 }}>
                      Admin only. Purchase several numbers at once and assign
                      them to this client’s connected Retell agent.
                    </p>
                  </div>

                  <label>
                    <span>Numbers to purchase</span>
                    <input
                      type="number"
                      min="1"
                      max={Math.max(
                        1,
                        21 -
                          (editingClient.agent?.phone_numbers?.length ||
                            (editingClient.agent?.phone_number ? 1 : 0))
                      )}
                      step="1"
                      value={editPurchaseQuantity}
                      onChange={(event) =>
                        setEditPurchaseQuantity(event.target.value)
                      }
                    />
                  </label>

                  <label>
                    <span>Number country</span>
                    <select
                      value={editPhoneCountry}
                      onChange={(event) =>
                        setEditPhoneCountry(
                          event.target.value === 'US' ? 'US' : 'CA'
                        )
                      }
                    >
                      <option value="CA">Canada</option>
                      <option value="US">United States</option>
                    </select>
                  </label>

                  {editPhoneCountry === 'US' && (
                    <label>
                      <span>Preferred US area code</span>
                      <input
                        inputMode="numeric"
                        maxLength={3}
                        value={editPhoneAreaCode}
                        onChange={(event) =>
                          setEditPhoneAreaCode(event.target.value)
                        }
                        placeholder="415"
                      />
                    </label>
                  )}

                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={
                      purchasingPhoneNumbers ||
                      editingClient.subscription?.status !== 'active' ||
                      !editingClient.agent?.retell_agent_id
                    }
                    onClick={handlePurchasePhoneNumbers}
                  >
                    {purchasingPhoneNumbers
                      ? 'Purchasing...'
                      : 'Purchase & Assign Numbers'}
                  </button>

                  <small style={{ gridColumn: '1 / -1' }}>
                    This makes a real Retell purchase. The first account number
                    is included; every additional number adds C$20/month to the
                    Recepta bill.
                  </small>
                </div>

                <div
                  style={{
                    gridColumn: '1 / -1',
                    display: 'grid',
                    gap: '12px',
                    padding: '16px',
                    border:
                      '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '14px',
                  }}
                >
                  <strong>Paid add-ons</strong>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{
                        width: '18px',
                        minHeight: '18px',
                        padding: 0,
                        flex: '0 0 18px',
                      }}
                      checked={editPiiRedaction}
                      onChange={(event) =>
                        setEditPiiRedaction(
                          event.target.checked
                        )
                      }
                    />
                    <span>
                      PII Redaction — C$0.014 per
                      selected minute
                    </span>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                    }}
                  >
                    <input
                      type="checkbox"
                      style={{
                        width: '18px',
                        minHeight: '18px',
                        padding: 0,
                        flex: '0 0 18px',
                      }}
                      checked={
                        editSafetyGuardrails
                      }
                      onChange={(event) =>
                        setEditSafetyGuardrails(
                          event.target.checked
                        )
                      }
                    />
                    <span>
                      Safety Guardrails — C$0.007
                      per selected minute
                    </span>
                  </label>

                  <strong
                    style={{
                      color: '#00e676',
                      fontSize: '1.15rem',
                    }}
                  >
                    Total monthly billing: C$
                    {editMonthlyTotal.toFixed(2)}
                  </strong>
                </div>

                <label
                  style={{
                    gridColumn: '1 / -1',
                  }}
                >
                  <span>
                    New temporary password
                  </span>
                  <input
                    type="password"
                    minLength={8}
                    value={editPassword}
                    onChange={(event) =>
                      setEditPassword(
                        event.target.value
                      )
                    }
                    placeholder="Leave blank to keep current password"
                  />
                  <small
                    style={{
                      display: 'block',
                      marginTop: '6px',
                      opacity: 0.62,
                    }}
                  >
                    Existing passwords cannot be
                    displayed. Enter a new one only
                    when you want to reset it.
                  </small>
                </label>

                {editError && (
                  <p
                    className="adminFormMessage adminFormMessage--error"
                    style={{
                      gridColumn: '1 / -1',
                    }}
                  >
                    {editError}
                  </p>
                )}

                <div
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    justifyContent:
                      'flex-end',
                    gap: '10px',
                  }}
                >
                  {editingClient.subscription?.status ===
                    'cancelled' && (
                    <button
                      type="button"
                      className="btn btnPrimary"
                      disabled={savingEdit}
                      onClick={handleReactivateSubscription}
                    >
                      {savingEdit
                        ? 'Reactivating...'
                        : 'Reactivate Subscription'}
                    </button>
                  )}

                  <button
                    type="button"
                    className="btn btnOutline"
                    onClick={() =>
                      setEditingClient(null)
                    }
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    className="btn btnPrimary"
                    disabled={savingEdit}
                  >
                    {savingEdit
                      ? 'Saving...'
                      : 'Save Client'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </section>
    </main>
  )
}
