import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import { supabase } from '../lib/supabase'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

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
  status: 'pending' | 'active' | 'past_due' | 'cancelled'
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
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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
          .select('agent_name, phone_number, business_hours, status')
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
          .order('started_at', { ascending: false })
          .limit(10),

        supabase
          .from('appointments')
          .select(
            'id, customer_name, customer_phone, appointment_time, status'
          )
          .eq('client_id', id)
          .order('appointment_time', { ascending: false })
          .limit(10),
      ])

      if (clientData) setClient(clientData)
      if (agentData) setAgent(agentData)
      if (subscriptionData) setSubscription(subscriptionData)
      if (onboardingData) setOnboarding(onboardingData)
      if (callsData) setCalls(callsData)
      if (appointmentData) setAppointments(appointmentData)

      setLoading(false)
    }

    loadClient()
  }, [id])

  const performance = useMemo(() => {
    const totalCalls = calls.length

    const totalSeconds = calls.reduce(
      (total, call) => total + (call.duration_seconds || 0),
      0
    )

    const appointmentsBooked = calls.filter(
      (call) => call.appointment_booked
    ).length

    const avgSeconds =
      totalCalls > 0 ? Math.round(totalSeconds / totalCalls) : 0

    return {
      totalCalls,
      totalMinutes: Math.round(totalSeconds / 60),
      appointmentsBooked,
      avgDuration:
        totalCalls > 0
          ? `${Math.floor(avgSeconds / 60)}m ${String(
              avgSeconds % 60
            ).padStart(2, '0')}s`
          : '—',
    }
  }, [calls])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <p>Loading client account...</p>
          </div>
        </section>
      </main>
    )
  }

  if (!client) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          <div className="dashboardEmptyState">
            <h2>Client not found</h2>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="dashboardNav">
          <a href="/admin" className="dashboardNavItem">
            Clients
          </a>

          <a
            href={`/admin/client/${client.id}`}
            className="dashboardNavItem dashboardNavItemActive"
          >
            Client Detail
          </a>

          <a href="/dashboard" className="dashboardNavItem">
            My Dashboard
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">CLIENT ACCOUNT</p>

            <h1>{client.company_name || 'Unnamed client'}</h1>

            <p>
              Full operational view of this Recepta customer.
            </p>
          </div>

          <span className={`settingsAccountBadge settingsAccountBadge--${client.status}`}>
            {client.status}
          </span>
        </div>

        {/* CLIENT */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">CLIENT</span>
              <h2>Company & owner</h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>Company</span>
              <strong>{client.company_name || '—'}</strong>
            </div>

            <div>
              <span>Owner</span>
              <strong>{client.owner_name || '—'}</strong>
            </div>

            <div>
              <span>Email</span>
              <strong>{client.contact_email || '—'}</strong>
            </div>

            <div>
              <span>Owner phone</span>
              <strong>{client.owner_phone || '—'}</strong>
            </div>

            <div>
              <span>Joined Recepta</span>
              <strong>
                {new Date(client.created_at).toLocaleDateString()}
              </strong>
            </div>

            <div>
              <span>Role</span>
              <strong>{client.role}</strong>
            </div>
          </div>
        </section>

        {/* SUBSCRIPTION */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">SUBSCRIPTION</span>
              <h2>Plan & billing</h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>Plan</span>
              <strong>{subscription?.plan_name || '—'}</strong>
            </div>

            <div>
              <span>Monthly price</span>
              <strong>
                {subscription?.monthly_price != null
                  ? `$${subscription.monthly_price.toFixed(2)}`
                  : '—'}
              </strong>
            </div>

            <div>
              <span>Billing status</span>
              <strong>{subscription?.status || '—'}</strong>
            </div>

            <div>
              <span>Next bill</span>
              <strong>
                {subscription?.next_billing_date
                  ? new Date(subscription.next_billing_date).toLocaleDateString()
                  : '—'}
              </strong>
            </div>

            <div>
              <span>Stripe customer ID</span>
              <strong>{subscription?.stripe_customer_id || '—'}</strong>
            </div>

            <div>
              <span>Stripe subscription ID</span>
              <strong>{subscription?.stripe_subscription_id || '—'}</strong>
            </div>
          </div>
        </section>

        {/* AGENT */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">AGENT</span>
              <h2>Assigned receptionist</h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>Agent name</span>
              <strong>{agent?.agent_name || '—'}</strong>
            </div>

            <div>
              <span>Phone number</span>
              <strong>{agent?.phone_number || '—'}</strong>
            </div>

            <div>
              <span>Business hours</span>
              <strong>{agent?.business_hours || '—'}</strong>
            </div>

            <div>
              <span>Agent status</span>
              <strong>{agent?.status || '—'}</strong>
            </div>

            <div>
              <span>Voice</span>
              <strong>{onboarding?.voice_preference || '—'}</strong>
            </div>

            <div>
              <span>Tone</span>
              <strong>{onboarding?.tone_preference || '—'}</strong>
            </div>
          </div>
        </section>

        {/* PERFORMANCE */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">PERFORMANCE</span>
              <h2>Client activity</h2>
            </div>
          </div>

          <div className="agentPerformanceGrid">
            <div>
              <span>Calls</span>
              <strong>{performance.totalCalls}</strong>
            </div>

            <div>
              <span>Minutes</span>
              <strong>{performance.totalMinutes}</strong>
            </div>

            <div>
              <span>Appointments</span>
              <strong>{performance.appointmentsBooked}</strong>
            </div>

            <div>
              <span>Avg. duration</span>
              <strong>{performance.avgDuration}</strong>
            </div>
          </div>
        </section>

        {/* ONBOARDING */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">ONBOARDING</span>
              <h2>Business configuration</h2>
            </div>
          </div>

          <div className="adminClientDetailGrid">
            {[
              ['Business phone', onboarding?.business_phone],
              ['Business hours', onboarding?.business_hours],
              ['Services', onboarding?.services],
              ['Pricing notes', onboarding?.pricing_notes],
              ['Service area', onboarding?.service_area],
              ['FAQs', onboarding?.faqs],
              ['Transfer number', onboarding?.transfer_number],
              ['Emergency rules', onboarding?.emergency_rules],
              ['Appointment types', onboarding?.appointment_types],
              ['Appointment lengths', onboarding?.appointment_lengths],
              ['Cancellation rules', onboarding?.cancellation_rules],
              ['Tone preference', onboarding?.tone_preference],
              ['Voice preference', onboarding?.voice_preference],
              ['Forbidden topics', onboarding?.forbidden_topics],
              ['Notifications', onboarding?.notification_preferences],
              ['Internal notes', onboarding?.onboarding_notes],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value || '—'}</strong>
              </div>
            ))}
          </div>
        </section>

        {/* RECENT CALLS */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">RECENT CALLS</span>
              <h2>Latest conversations</h2>
            </div>
          </div>

          {calls.length === 0 ? (
            <div className="agentActivityEmpty">
              <strong>No calls yet</strong>
            </div>
          ) : (
            <div className="agentActivityList">
              {calls.map((call) => (
                <div className="agentActivityRow" key={call.id}>
                  <div className="agentActivityIcon">↗</div>

                  <div className="agentActivityText">
                    <strong>
                      {call.caller_name ||
                        call.caller_number ||
                        'Unknown caller'}
                    </strong>

                    <span>{call.outcome || 'Completed'}</span>
                  </div>

                  <time>
                    {new Date(call.started_at).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* RECENT APPOINTMENTS */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">APPOINTMENTS</span>
              <h2>Latest bookings</h2>
            </div>
          </div>

          {appointments.length === 0 ? (
            <div className="agentActivityEmpty">
              <strong>No appointments yet</strong>
            </div>
          ) : (
            <div className="agentActivityList">
              {appointments.map((appointment) => (
                <div className="agentActivityRow" key={appointment.id}>
                  <div className="agentActivityIcon">✓</div>

                  <div className="agentActivityText">
                    <strong>
                      {appointment.customer_name ||
                        appointment.customer_phone ||
                        'Customer'}
                    </strong>

                    <span>{appointment.status}</span>
                  </div>

                  <time>
                    {new Date(
                      appointment.appointment_time
                    ).toLocaleString()}
                  </time>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* INTERNAL */}

        <section className="settingsPanel">
          <div className="settingsPanelHeading">
            <div>
              <span className="settingsSectionLabel">INTERNAL</span>
              <h2>System identifiers</h2>
            </div>
          </div>

          <div className="settingsInfoGrid">
            <div>
              <span>Client UID</span>
              <strong>{client.id}</strong>
            </div>

            <div>
              <span>Onboarding complete</span>
              <strong>
                {onboarding?.completed ? 'Yes' : 'No'}
              </strong>
            </div>

            <div>
              <span>Onboarding created</span>
              <strong>
                {onboarding?.created_at
                  ? new Date(onboarding.created_at).toLocaleString()
                  : '—'}
              </strong>
            </div>

            <div>
              <span>Onboarding updated</span>
              <strong>
                {onboarding?.updated_at
                  ? new Date(onboarding.updated_at).toLocaleString()
                  : '—'}
              </strong>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}
