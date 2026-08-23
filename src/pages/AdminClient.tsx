import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { supabase } from '../lib/supabase'
import OnboardingForm from '../components/OnboardingForm'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type BillingStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'cancelled'

type Client = {
  id: string
  company_name: string | null
  owner_name: string | null
  owner_phone: string | null
  contact_email: string | null
  status: ClientStatus
  role: string
  created_at: string
}

type Agent = {
  agent_name: string | null
  phone_number: string | null
  business_hours: string | null
  status: ClientStatus
}

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  status: BillingStatus
  next_billing_date: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}

type Onboarding = {
  business_phone: string | null
  business_hours: string | null
  services: string | null
  pricing_notes: string | null
  service_area: string | null
  faqs: string | null
  transfer_number: string | null
  emergency_rules: string | null
  appointment_types: string | null
  appointment_lengths: string | null
  cancellation_rules: string | null
  tone_preference: string | null
  voice_preference: string | null
  forbidden_topics: string | null
  notification_preferences: string | null
  onboarding_notes: string | null
  completed: boolean
  created_at: string
  updated_at: string
}

type Call = {
  id: string
  caller_name: string | null
  caller_number: string | null
  started_at: string
  duration_seconds: number
  outcome: string | null
  summary: string | null
  appointment_booked: boolean
}

type Appointment = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  appointment_time: string
  status: 'booked' | 'cancelled' | 'completed'
}

export default function AdminClient() {
  const { id } = useParams()

  const [client, setClient] = useState<Client | null>(null)
  const [agent, setAgent] = useState<Agent | null>(null)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [onboarding, setOnboarding] =
    useState<Onboarding | null>(null)

  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] =
    useState<Appointment[]>([])

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const [planName, setPlanName] =
    useState('Recepta Standard')

  const [monthlyPrice, setMonthlyPrice] =
    useState('200')

  const [billingStatus, setBillingStatus] =
    useState<BillingStatus>('pending')

  const [agentName, setAgentName] = useState('')
  const [agentPhone, setAgentPhone] = useState('')
  const [agentHours, setAgentHours] = useState('')

  const loadClient = async () => {
    if (!id) {
      setLoading(false)
      return
    }

    const [
      { data: clientData },
      { data: agentData },
      { data: subscriptionData },
      { data: onboardingData },
      { data: callsData },
      { data: appointmentData },
    ] = await Promise.all([
      supabase
        .from('clients')
        .select(
          'id, company_name, owner_name, owner_phone, contact_email, status, role, created_at'
        )
        .eq('id', id)
        .single(),

      supabase
        .from('agents')
        .select(
          'agent_name, phone_number, business_hours, status'
        )
        .eq('client_id', id)
        .maybeSingle(),

      supabase
        .from('subscriptions')
        .select(
          'plan_name, monthly_price, status, next_billing_date, stripe_customer_id, stripe_subscription_id'
        )
        .eq('client_id', id)
        .maybeSingle(),

      supabase
        .from('onboarding')
        .select(
          'business_phone, business_hours, services, pricing_notes, service_area, faqs, transfer_number, emergency_rules, appointment_types, appointment_lengths, cancellation_rules, tone_preference, voice_preference, forbidden_topics, notification_preferences, onboarding_notes, completed, created_at, updated_at'
        )
        .eq('client_id', id)
        .maybeSingle(),

      supabase
        .from('calls')
        .select(
          'id, caller_name, caller_number, started_at, duration_seconds, outcome, summary, appointment_booked'
        )
        .eq('client_id', id)
        .order('started_at', {
          ascending: false,
        })
        .limit(10),

      supabase
        .from('appointments')
        .select(
          'id, customer_name, customer_phone, appointment_time, status'
        )
        .eq('client_id', id)
        .order('appointment_time', {
          ascending: false,
        })
        .limit(10),
    ])

    if (clientData) {
      setClient(clientData)
    }

    if (agentData) {
      setAgent(agentData)

      setAgentName(
        agentData.agent_name || ''
      )

      setAgentPhone(
        agentData.phone_number || ''
      )

      setAgentHours(
        agentData.business_hours || ''
      )
    }

    if (subscriptionData) {
      setSubscription(subscriptionData)

      setPlanName(
        subscriptionData.plan_name ||
          'Recepta Standard'
      )

      setMonthlyPrice(
        String(
          subscriptionData.monthly_price ??
            200
        )
      )

      setBillingStatus(
        subscriptionData.status ||
          'pending'
      )
    }

    if (onboardingData) {
      setOnboarding(onboardingData)
    }

    if (callsData) {
      setCalls(callsData)
    }

    if (appointmentData) {
      setAppointments(
        appointmentData
      )
    }

    setLoading(false)
  }

  useEffect(() => {
    loadClient()
  }, [id])

  const isPro =
    planName === 'Recepta Pro'

  const performance = useMemo(() => {
    const totalCalls = calls.length

    const totalSeconds = calls.reduce(
      (total, call) =>
        total +
        (call.duration_seconds || 0),
      0
    )

    const appointmentsBooked =
      calls.filter(
        (call) =>
          call.appointment_booked
      ).length

    const avgSeconds =
      totalCalls > 0
        ? Math.round(
            totalSeconds / totalCalls
          )
        : 0

    return {
      totalCalls,

      totalMinutes:
        Math.round(
          totalSeconds / 60
        ),

      appointmentsBooked,

      avgDuration:
        totalCalls > 0
          ? `${Math.floor(
              avgSeconds / 60
            )}m ${String(
              avgSeconds % 60
            ).padStart(2, '0')}s`
          : '—',
    }
  }, [calls])

  const updateClientStatus = async (
    status: ClientStatus
  ) => {
    if (!id) return

    setSaving(true)
    setMessage('')

    const { error: clientError } =
      await supabase
        .from('clients')
        .update({ status })
        .eq('id', id)

    if (clientError) {
      setMessage(
        `Could not update client: ${clientError.message}`
      )
      setSaving(false)
      return
    }

    const { error: agentError } =
      await supabase
        .from('agents')
        .update({ status })
        .eq('client_id', id)

    if (agentError) {
      setMessage(
        `Client updated, but agent status failed: ${agentError.message}`
      )
      setSaving(false)
      return
    }

    setClient((current) =>
      current
        ? {
            ...current,
            status,
          }
        : current
    )

    setAgent((current) =>
      current
        ? {
            ...current,
            status,
          }
        : current
    )

    setMessage(
      `Client status changed to ${status}.`
    )

    setSaving(false)
  }

  const handlePlanChange = (
    value: string
  ) => {
    setPlanName(value)

    if (
      value === 'Recepta Standard'
    ) {
      setMonthlyPrice('200')
    } else {
      setMonthlyPrice('300')
    }
  }

  const saveSubscription = async () => {
    if (!id) return

    setSaving(true)
    setMessage('')

    const { error } = await supabase
      .from('subscriptions')
      .upsert(
        {
          client_id: id,
          plan_name: planName,
          monthly_price:
            Number(monthlyPrice),
          status: billingStatus,
        },
        {
          onConflict: 'client_id',
        }
      )

    if (error) {
      setMessage(
        `Could not save subscription: ${error.message}`
      )

      setSaving(false)
      return
    }

    setSubscription((current) => ({
      plan_name: planName,
      monthly_price:
        Number(monthlyPrice),
      status: billingStatus,

      next_billing_date:
        current?.next_billing_date ||
        null,

      stripe_customer_id:
        current?.stripe_customer_id ||
        null,

      stripe_subscription_id:
        current?.stripe_subscription_id ||
        null,
    }))

    setMessage(
      'Subscription updated.'
    )

    setSaving(false)
  }

  const saveAgent = async () => {
    if (!id) return

    setSaving(true)
    setMessage('')

    const { error } = await supabase
      .from('agents')
      .upsert(
        {
          client_id: id,

          agent_name:
            agentName.trim() ||
            null,

          phone_number:
            agentPhone.trim() ||
            null,

          business_hours:
            agentHours.trim() ||
            null,

          status:
            agent?.status ||
            client?.status ||
            'setup',
        },
        {
          onConflict: 'client_id',
        }
      )

    if (error) {
      setMessage(
        `Could not save agent: ${error.message}`
      )

      setSaving(false)
      return
    }

    setAgent({
      agent_name:
        agentName.trim() || null,

      phone_number:
        agentPhone.trim() || null,

      business_hours:
        agentHours.trim() || null,

      status:
        agent?.status ||
        client?.status ||
        'setup',
    })

    setMessage(
      'Agent configuration updated.'
    )

    setSaving(false)
  }

  if (loading) {
    return (
      <main className="adminPage">
        <section className="adminMain">
          <div className="adminEmpty">
            Loading client...
          </div>
        </section>
      </main>
    )
  }

  if (!client) {
    return (
      <main className="adminPage">
        <section className="adminMain">
          <div className="adminEmpty">
            <strong>
              Client not found
            </strong>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="adminPage">

      {/* SIDEBAR */}

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
              className="adminNavItem"
            >
              Clients
            </a>

            <a
              href={`/admin/client/${client.id}`}
              className="adminNavItem adminNavItem--active"
            >
              Client Detail
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
              CLIENT ACCOUNT
            </span>

            <h1>
              {client.company_name ||
                'Unnamed Client'}
            </h1>

            <p>
              Manage this customer's
              Recepta account and AI receptionist.
            </p>
          </div>

          <a
            href="/admin"
            className="btn btnOutline"
          >
            ← Back to Clients
          </a>
        </header>

        {/* MESSAGE */}

        {message && (
          <p
            className="adminFormMessage adminFormMessage--success"
            style={{
              marginTop: '18px',
            }}
          >
            {message}
          </p>
        )}

        {/* STATUS */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                CLIENT STATUS
              </span>

              <h2>
                Receptionist lifecycle
              </h2>

              <p>
                Control whether this customer's
                receptionist is being configured,
                tested, live or paused.
              </p>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '9px',
              marginTop: '18px',
            }}
          >
            <button
              type="button"
              className="btn btnOutline"
              disabled={saving}
              onClick={() =>
                updateClientStatus(
                  'setup'
                )
              }
            >
              Setup
            </button>

            <button
              type="button"
              className="btn btnOutline"
              disabled={saving}
              onClick={() =>
                updateClientStatus(
                  'testing'
                )
              }
            >
              Testing
            </button>

            <button
              type="button"
              className="btn btnPrimary"
              disabled={saving}
              onClick={() =>
                updateClientStatus(
                  'live'
                )
              }
            >
              Go Live
            </button>

            <button
              type="button"
              className="btn btnOutline"
              disabled={saving}
              onClick={() =>
                updateClientStatus(
                  'paused'
                )
              }
            >
              Pause
            </button>
          </div>
        </section>

        {/* COMPANY */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                CLIENT
              </span>

              <h2>
                Company & owner
              </h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Company
              </span>

              <strong>
                {client.company_name ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Owner
              </span>

              <strong>
                {client.owner_name ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Email
              </span>

              <strong>
                {client.contact_email ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Owner phone
              </span>

              <strong>
                {client.owner_phone ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Joined
              </span>

              <strong>
                {new Date(
                  client.created_at
                ).toLocaleDateString()}
              </strong>
            </div>

            <div>
              <span>
                Status
              </span>

              <strong>
                {client.status}
              </strong>
            </div>
          </div>
        </section>

        {/* SUBSCRIPTION */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                SUBSCRIPTION
              </span>

              <h2>
                Plan & billing
              </h2>

              <p>
                Change the customer's Recepta
                plan and billing status.
              </p>
            </div>
          </div>

          <div
            className="adminNewClientForm"
            style={{
              gridTemplateColumns:
                'repeat(3, minmax(0, 1fr)) auto',
            }}
          >
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
                  Recepta Standard
                </option>

                <option value="Recepta Pro">
                  Recepta Pro
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
                  value={monthlyPrice}
                  onChange={(event) =>
                    setMonthlyPrice(
                      event.target.value
                    )
                  }
                  min="0"
                  step="0.01"
                />
              </div>
            </label>

            <label>
              <span>
                Billing status
              </span>

              <select
                value={billingStatus}
                onChange={(event) =>
                  setBillingStatus(
                    event.target
                      .value as BillingStatus
                  )
                }
              >
                <option value="pending">
                  Pending
                </option>

                <option value="active">
                  Active
                </option>

                <option value="past_due">
                  Past Due
                </option>

                <option value="cancelled">
                  Cancelled
                </option>
              </select>
            </label>

            <div className="adminCreateAction">
              <button
                type="button"
                className="btn btnPrimary"
                onClick={
                  saveSubscription
                }
                disabled={saving}
              >
                Save Plan
              </button>
            </div>
          </div>

          <div
            className="settingsInfoGrid"
            style={{
              marginTop: '18px',
            }}
          >
            <div>
              <span>
                Stripe customer ID
              </span>

              <strong>
                {subscription
                  ?.stripe_customer_id ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Stripe subscription ID
              </span>

              <strong>
                {subscription
                  ?.stripe_subscription_id ||
                  '—'}
              </strong>
            </div>

            <div>
              <span>
                Next billing date
              </span>

              <strong>
                {subscription
                  ?.next_billing_date
                  ? new Date(
                      subscription.next_billing_date
                    ).toLocaleDateString()
                  : '—'}
              </strong>
            </div>
          </div>
        </section>

        {/* AGENT */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                AI RECEPTIONIST
              </span>

              <h2>
                Agent configuration
              </h2>

              <p>
                Assign the receptionist name,
                phone number and operating hours.
              </p>
            </div>
          </div>

          <div
            className="adminNewClientForm"
            style={{
              gridTemplateColumns:
                'repeat(3, minmax(0, 1fr)) auto',
            }}
          >
            <label>
              <span>
                Agent name
              </span>

              <input
                value={agentName}
                onChange={(event) =>
                  setAgentName(
                    event.target.value
                  )
                }
                placeholder="Recepta AI"
              />
            </label>

            <label>
              <span>
                Phone number
              </span>

              <input
                value={agentPhone}
                onChange={(event) =>
                  setAgentPhone(
                    event.target.value
                  )
                }
                placeholder="+1 416..."
              />
            </label>

            <label>
              <span>
                Operating hours
              </span>

              <input
                value={agentHours}
                onChange={(event) =>
                  setAgentHours(
                    event.target.value
                  )
                }
                placeholder="24/7"
              />
            </label>

            <div className="adminCreateAction">
              <button
                type="button"
                className="btn btnPrimary"
                onClick={saveAgent}
                disabled={saving}
              >
                Save Agent
              </button>
            </div>
          </div>
        </section>

        {/* ONBOARDING */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                ONBOARDING
              </span>

              <h2>
                Business configuration
              </h2>

              <p>
                Manage the information used when
                building this customer's AI
                receptionist.
              </p>
            </div>
          </div>

          <OnboardingForm
            clientId={client.id}
            companyName={
              client.company_name ||
              'Client'
            }
          />

          {onboarding && (
            <div
              className="settingsInfoGrid"
              style={{
                marginTop: '18px',
              }}
            >
              <div>
                <span>
                  Business phone
                </span>

                <strong>
                  {onboarding.business_phone ||
                    '—'}
                </strong>
              </div>

              <div>
                <span>
                  Service area
                </span>

                <strong>
                  {onboarding.service_area ||
                    '—'}
                </strong>
              </div>

              <div>
                <span>
                  Voice
                </span>

                <strong>
                  {onboarding.voice_preference ||
                    '—'}
                </strong>
              </div>

              <div>
                <span>
                  Tone
                </span>

                <strong>
                  {onboarding.tone_preference ||
                    '—'}
                </strong>
              </div>
            </div>
          )}
        </section>

        {/* PERFORMANCE */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                PERFORMANCE
              </span>

              <h2>
                Client activity
              </h2>
            </div>
          </div>

          <div className="agentPerformanceGrid">
            <div>
              <span>
                Calls
              </span>

              <strong>
                {performance.totalCalls}
              </strong>
            </div>

            <div>
              <span>
                Minutes
              </span>

              <strong>
                {performance.totalMinutes}
              </strong>
            </div>

            {isPro && (
              <div>
                <span>
                  Appointments
                </span>

                <strong>
                  {performance.appointmentsBooked}
                </strong>
              </div>
            )}

            <div>
              <span>
                Avg. duration
              </span>

              <strong>
                {performance.avgDuration}
              </strong>
            </div>
          </div>
        </section>

        {/* CALLS */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                RECENT CALLS
              </span>

              <h2>
                Latest conversations
              </h2>
            </div>
          </div>

          {calls.length === 0 ? (
            <div className="adminEmpty">
              No calls yet
            </div>
          ) : (
            <div className="agentActivityList">
              {calls.map((call) => (
                <div
                  className="agentActivityRow"
                  key={call.id}
                >
                  <div className="agentActivityIcon">
                    ↗
                  </div>

                  <div className="agentActivityText">
                    <strong>
                      {call.caller_name ||
                        call.caller_number ||
                        'Unknown caller'}
                    </strong>

                    <span>
                      {call.outcome ||
                        'Completed'}
                    </span>
                  </div>

                  <time>
                    {new Date(
                      call.started_at
                    ).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* PRO APPOINTMENTS */}

        {isPro && (
          <section className="adminPanel">
            <div className="adminPanelHeading">
              <div>
                <span className="adminEyebrow">
                  APPOINTMENTS
                </span>

                <h2>
                  Latest bookings
                </h2>
              </div>
            </div>

            {appointments.length === 0 ? (
              <div className="adminEmpty">
                No appointments yet
              </div>
            ) : (
              <div className="agentActivityList">
                {appointments.map(
                  (appointment) => (
                    <div
                      className="agentActivityRow"
                      key={appointment.id}
                    >
                      <div className="agentActivityIcon">
                        ✓
                      </div>

                      <div className="agentActivityText">
                        <strong>
                          {appointment.customer_name ||
                            appointment.customer_phone ||
                            'Customer'}
                        </strong>

                        <span>
                          {appointment.status}
                        </span>
                      </div>

                      <time>
                        {new Date(
                          appointment.appointment_time
                        ).toLocaleString()}
                      </time>
                    </div>
                  )
                )}
              </div>
            )}
          </section>
        )}

        {/* INTERNAL */}

        <section className="adminPanel">
          <div className="adminPanelHeading">
            <div>
              <span className="adminEyebrow">
                INTERNAL
              </span>

              <h2>
                System information
              </h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>
                Client UID
              </span>

              <strong>
                {client.id}
              </strong>
            </div>

            <div>
              <span>
                Account role
              </span>

              <strong>
                {client.role}
              </strong>
            </div>

            <div>
              <span>
                Onboarding completed
              </span>

              <strong>
                {onboarding?.completed
                  ? 'Yes'
                  : 'No'}
              </strong>
            </div>

            <div>
              <span>
                Last onboarding update
              </span>

              <strong>
                {onboarding?.updated_at
                  ? new Date(
                      onboarding.updated_at
                    ).toLocaleString()
                  : '—'}
              </strong>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}
