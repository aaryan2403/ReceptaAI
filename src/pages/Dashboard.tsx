import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchClientCalls } from '../lib/clientCalls'

type ClientStatus = 'setup' | 'testing' | 'live' | 'paused'

type Client = {
  company_name: string | null
  contact_email: string | null
  status: ClientStatus
}

type Subscription = {
  plan_name: string | null
  monthly_price: number | null
  monthly_minutes: number | null
  current_period_start: string | null
  current_period_end: string | null
  status: string | null
}

type Agent = {
  retell_agent_id: string | null
  phone_number: string | null
  status: ClientStatus
}

type Call = {
  duration_seconds: number
  appointment_booked: boolean
  started_at: string
  call_status: string | null
  caller_name?: string | null
  caller_number?: string | null
}

type Appointment = {
  id: string
  appointment_time: string | null
  status: 'booked' | 'cancelled' | 'completed'
}

type ChartPoint = {
  label: string
  value: number
}

function CompanyStatisticsChart({
  title,
  points,
}: {
  title: string
  points: ChartPoint[]
}) {
  const width = 760
  const height = 250
  const paddingLeft = 42
  const paddingRight = 22
  const paddingTop = 22
  const paddingBottom = 42
  const plotWidth = width - paddingLeft - paddingRight
  const plotHeight = height - paddingTop - paddingBottom
  const maximum = Math.max(1, ...points.map((point) => point.value))
  const coordinates = points.map((point, index) => ({
    ...point,
    x:
      paddingLeft +
      (points.length === 1
        ? plotWidth / 2
        : (index / (points.length - 1)) * plotWidth),
    y: paddingTop + plotHeight - (point.value / maximum) * plotHeight,
  }))
  const linePath = coordinates
    .map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    )
    .join(' ')
  const areaPath = `${linePath} L ${
    coordinates[coordinates.length - 1]?.x ?? paddingLeft
  } ${paddingTop + plotHeight} L ${
    coordinates[0]?.x ?? paddingLeft
  } ${paddingTop + plotHeight} Z`
  const total = points.reduce((sum, point) => sum + point.value, 0)

  return (
    <section className="dashboardCompanyChart">
      <div className="dashboardCompanyChartHeader">
        <div>
          <p className="dashboardEyebrow">COMPANY STATISTICS</p>
          <h2>{title}</h2>
          <p>Daily activity over the last seven days.</p>
        </div>

        <div className="dashboardCompanyChartTotal">
          <span>7-day total</span>
          <strong>{total}</strong>
        </div>
      </div>

      <div className="dashboardCompanyChartCanvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title} line graph for the last seven days`}
        >
          <defs>
            <linearGradient
              id="dashboardChartArea"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#00e676" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#00e676" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = paddingTop + plotHeight * ratio
            const value = Math.round(maximum * (1 - ratio))

            return (
              <g key={ratio}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="rgba(255,255,255,0.09)"
                  strokeWidth="1"
                />
                <text
                  x={paddingLeft - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="rgba(235,244,238,0.45)"
                  fontSize="11"
                >
                  {value}
                </text>
              </g>
            )
          })}

          <path d={areaPath} fill="url(#dashboardChartArea)" />
          <path
            d={linePath}
            fill="none"
            stroke="#00e676"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {coordinates.map((point) => (
            <g key={point.label}>
              <circle
                cx={point.x}
                cy={point.y}
                r="5"
                fill="#07140d"
                stroke="#00e676"
                strokeWidth="3"
              />
              <text
                x={point.x}
                y={height - 15}
                textAnchor="middle"
                fill="rgba(235,244,238,0.58)"
                fontSize="11"
              >
                {point.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </section>
  )
}

export default function Dashboard() {
  const [client, setClient] = useState<Client | null>(null)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [agent, setAgent] =
    useState<Agent | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] =
    useState<Appointment[]>([])
  const [phoneNumbers, setPhoneNumbers] =
    useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadDashboard = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: clientData },
        { data: subscriptionData },
        { data: agentData },
        { data: phoneNumberData },
      ] = await Promise.all([
        supabase
          .from('clients')
          .select('company_name, contact_email, status')
          .eq('id', user.id)
          .single(),

        supabase
          .from('subscriptions')
          .select(
            'plan_name, monthly_price, monthly_minutes, current_period_start, current_period_end, status'
          )
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('agents')
          .select('retell_agent_id, phone_number, status')
          .eq('client_id', user.id)
          .maybeSingle(),

        supabase
          .from('agent_phone_numbers')
          .select('phone_number')
          .eq('client_id', user.id)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true }),
      ])

      if (clientData) {
        setClient(clientData)
      }

      if (subscriptionData) {
        setSubscription(subscriptionData)
      }

      try {
        const callsResult = await fetchClientCalls()
        setCalls(callsResult.calls)
      } catch (error) {
        console.error('Dashboard call sync failed:', error)
      }

      if (agentData) {
        setAgent(agentData)

        const assignedPhoneNumbers = (phoneNumberData ?? []).map(
          (row) => row.phone_number
        )

        setPhoneNumbers(
          assignedPhoneNumbers.length > 0
            ? assignedPhoneNumbers
            : agentData.phone_number
              ? [agentData.phone_number]
              : []
        )
      }

      const isPro =
        subscriptionData?.status === 'active' &&
        subscriptionData?.plan_name === 'Recepta Pro'

      if (isPro) {
        const { data: appointmentsData } = await supabase
          .from('appointments')
          .select('id, appointment_time, status')
          .eq('client_id', user.id)

        if (appointmentsData) {
          setAppointments(appointmentsData)
        }
      } else {
        setAppointments([])
      }

      setLoading(false)
    }

    loadDashboard()

    const refreshInterval =
      window.setInterval(
        loadDashboard,
        5000
      )

    return () => {
      window.clearInterval(
        refreshInterval
      )
    }
  }, [])

  const isSubscriptionCancelled =
    subscription?.status === 'cancelled'

  const isSubscriptionPending =
    !subscription ||
    subscription.status === 'pending'

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const isStandard =
    subscription?.plan_name === 'Recepta Standard'

  const effectiveAgentStatus: ClientStatus =
    isSubscriptionCancelled
      ? 'paused'
      : agent?.retell_agent_id &&
          agent.status === 'setup'
        ? 'live'
        : agent?.status || client?.status || 'setup'

  const activeCall = calls.find(
    (call) =>
      call.call_status === 'ongoing' ||
      call.call_status === 'registered'
  )

  const stats = useMemo(() => {
    const periodStart =
      subscription?.current_period_start
        ? new Date(
            subscription.current_period_start
          ).getTime()
        : 0

    const periodCalls = calls.filter((call) => {
      const callStartedAt = new Date(
        call.started_at
      ).getTime()

      return (
        Number.isFinite(callStartedAt) &&
        callStartedAt >= periodStart
      )
    })

    const callsAnswered = periodCalls.length

    const totalSeconds = periodCalls.reduce(
      (total, call) =>
        total + (call.duration_seconds || 0),
      0
    )

    const minutesTalked =
      Math.ceil(totalSeconds / 60)

    const monthlyMinutes =
      subscription?.monthly_minutes ?? 300

    const minutesRemaining = Math.max(
      monthlyMinutes - minutesTalked,
      0
    )

    const usagePercentage =
      monthlyMinutes > 0
        ? Math.min(
            (minutesTalked / monthlyMinutes) * 100,
            100
          )
        : 0

    const averageSeconds =
      callsAnswered > 0
        ? Math.round(totalSeconds / callsAnswered)
        : 0

    const averageMinutes =
      Math.floor(averageSeconds / 60)

    const averageRemainingSeconds =
      averageSeconds % 60

    const today = new Date()

    const appointmentsToday =
      appointments.filter((appointment) => {
        if (
          !appointment.appointment_time ||
          appointment.status === 'cancelled'
        ) {
          return false
        }

        const appointmentDate =
          new Date(appointment.appointment_time)

        return (
          appointmentDate.getFullYear() ===
            today.getFullYear() &&
          appointmentDate.getMonth() ===
            today.getMonth() &&
          appointmentDate.getDate() ===
            today.getDate()
        )
      }).length

    return {
      callsAnswered,
      minutesTalked,
      monthlyMinutes,
      minutesRemaining,
      usagePercentage,
      appointmentsToday,

      averageDuration:
        callsAnswered > 0
          ? `${averageMinutes}m ${String(
              averageRemainingSeconds
            ).padStart(2, '0')}s`
          : '0m 00s',
    }
  }, [calls, appointments, subscription])

  const companyChart = useMemo(() => {
    const now = new Date()
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      date.setDate(date.getDate() - (6 - index))

      return {
        date,
        key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
        label: date.toLocaleDateString(undefined, {
          weekday: 'short',
        }),
      }
    })

    const toLocalDateKey = (value: string | null) => {
      if (!value) return null
      const date = new Date(value)

      if (!Number.isFinite(date.getTime())) return null

      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    }

    const points = days.map((day) => ({
      label: day.label,
      value: isPro
        ? appointments.filter(
            (appointment) =>
              appointment.status !== 'cancelled' &&
              toLocalDateKey(appointment.appointment_time) === day.key
          ).length
        : calls.filter(
            (call) => toLocalDateKey(call.started_at) === day.key
          ).length,
    }))

    return {
      title: isPro ? 'Appointments Booked' : 'Calls Picked Up',
      points,
    }
  }, [appointments, calls, isPro])

  const getStatusInfo = () => {
    if (
      subscription?.status === 'active' &&
      stats.monthlyMinutes > 0 &&
      stats.minutesRemaining === 0
    ) {
      return {
        label: 'Minute Limit Reached',
        color: '#ffb020',
        background:
          'rgba(255, 176, 32, 0.10)',
      }
    }

    switch (effectiveAgentStatus) {
      case 'live':
        return {
          label: 'Agent Live',
          color: '#00e676',
          background: 'rgba(0, 230, 118, 0.10)',
          border: 'rgba(0, 230, 118, 0.20)',
          shadow: 'rgba(0, 230, 118, 0.7)',
        }

      case 'testing':
        return {
          label: 'Agent Testing',
          color: '#58b7ff',
          background: 'rgba(88, 183, 255, 0.10)',
          border: 'rgba(88, 183, 255, 0.20)',
          shadow: 'rgba(88, 183, 255, 0.7)',
        }

      case 'paused':
        return {
          label: 'Agent Paused',
          color: '#a0a0a0',
          background: 'rgba(160, 160, 160, 0.10)',
          border: 'rgba(160, 160, 160, 0.20)',
          shadow: 'rgba(160, 160, 160, 0.5)',
        }

      default:
        return {
          label: 'AI Configuration Pending',
          color: '#f5b942',
          background: 'rgba(245, 185, 66, 0.08)',
          border: 'rgba(245, 185, 66, 0.25)',
          shadow: 'rgba(245, 185, 66, 0.6)',
        }
    }
  }

  const status = getStatusInfo()


  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Loading your Recepta dashboard...
        </section>
      </main>
    )
  }

  if (isSubscriptionPending) {
    return (
      <main className="dashboardPage">
        <aside className="dashboardSidebar">
          <a href="/" className="dashboardBrand">
            <img
              src="/components/logoR.png"
              alt="Recepta"
            />
          </a>

          <nav className="dashboardNav">
            <a
              href="/dashboard"
              className="dashboardNavItem dashboardNavItemActive"
            >
              Overview
            </a>

            <a
              href="/dashboard/billing"
              className="dashboardNavItem"
            >
              Billing
            </a>

            <a
              href="/dashboard/settings"
              className="dashboardNavItem"
            >
              Settings
            </a>
          </nav>
        </aside>

        <section className="dashboardMain">
          <div className="dashboardHeader">
            <div>
              <p className="dashboardEyebrow">
                SETUP PENDING
              </p>

              <h1>
                {client?.company_name ||
                  'Your Recepta dashboard'}
              </h1>

              <p>
                Your account has been created. Recepta
                is assigning your plan, AI model and
                monthly minutes.
              </p>
            </div>
          </div>

          <div className="dashboardEmptyState">
            <h2>
              Your workspace is being prepared
            </h2>

            <p>
              You do not need to choose or purchase a
              subscription yourself. Recepta will finish
              the account configuration for you.
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="dashboardPage">
      <aside className="dashboardSidebar">
        <a href="/" className="dashboardBrand">
          <img
            src="/components/logoR.png"
            alt="Recepta"
          />
        </a>

        <nav className="dashboardNav">
          <a
            href="/dashboard"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Overview
          </a>

          <a
            href="/dashboard/calls"
            className="dashboardNavItem"
          >
            Calls
          </a>

          {isPro && (
            <a
              href="/dashboard/appointments"
              className="dashboardNavItem"
            >
              Appointments
            </a>
          )}

          <a
            href="/dashboard/employees"
            className="dashboardNavItem"
          >
            Employees
          </a>

          <a
            href="/dashboard/agent"
            className="dashboardNavItem"
          >
            Agent
          </a>

          <a
            href="/dashboard/billing"
            className="dashboardNavItem"
          >
            Billing
          </a>

          <a
            href="/dashboard/settings"
            className="dashboardNavItem"
          >
            Settings
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">
              {isPro
                ? 'RECEPTA PRO'
                : isStandard
                  ? 'RECEPTA STANDARD'
                  : 'RECEPTA'}
            </p>

            <h1>
              {client?.company_name ||
                'Your AI receptionist'}
            </h1>

            <p>
              Your workspace is ready and will populate
              automatically as your AI receptionist handles calls.
            </p>
          </div>

          <div
            className="agentLiveBadge"
            style={{
              color: status.color,
              borderColor: status.border,
              background: status.background,
            }}
          >
            <span
              style={{
                background: status.color,
                boxShadow: `0 0 12px ${status.shadow}`,
              }}
            />

            {status.label}
          </div>
        </div>

        {isSubscriptionCancelled ? (
          <div className="dashboardEmptyState">
            <h2>
              Your subscription is cancelled
            </h2>

            <p>
              Your previous plan information is preserved.
              Recepta controls plan, AI model and monthly
              minute changes for your account.
            </p>

            <a
              href="/dashboard/billing"
              className="btn btnPrimary"
            >
              Renew Subscription
            </a>
          </div>
        ) : (
        <>

        <a
          href="/dashboard/calls"
          className={
            activeCall
              ? 'dashboardActiveCall dashboardActiveCall--live'
              : 'dashboardActiveCall'
          }
        >
          <span className="dashboardActiveCallDot" />

          <div>
            <strong>
              {activeCall
                ? 'Active call in progress'
                : 'No active calls'}
            </strong>

            <small>
              {activeCall
                ? activeCall.caller_name ||
                  activeCall.caller_number ||
                  'Retell audio test is connected now.'
                : 'The Calls page will update automatically when a conversation starts.'}
            </small>
          </div>

          <span className="dashboardActiveCallLink">
            View Calls
          </span>
        </a>

        <div className="dashboardStats">
          <div className="dashboardStatCard">
            <span>Calls Answered</span>
            <strong>{stats.callsAnswered}</strong>
          </div>

          {isPro && (
            <a
              href="/dashboard/appointments"
              className="dashboardStatCard dashboardStatCardLink"
            >
              <span>Appointments Today</span>

              <strong>
                {stats.appointmentsToday}
              </strong>

              <small>
                {stats.appointmentsToday === 1
                  ? '1 appointment scheduled today'
                  : `${stats.appointmentsToday} appointments scheduled today`}
              </small>
            </a>
          )}

          <div className="dashboardStatCard">
            <span>Minutes Used</span>

            <strong>
              {stats.minutesTalked} /{' '}
              {stats.monthlyMinutes} min
            </strong>

            <div
              style={{
                width: '100%',
                height: '6px',
                marginTop: '12px',
                overflow: 'hidden',
                borderRadius: '999px',
                background:
                  'rgba(255,255,255,0.08)',
              }}
            >
              <div
                style={{
                  width: `${stats.usagePercentage}%`,
                  height: '100%',
                  borderRadius: '999px',
                  background: '#00e676',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>

            <small
              style={{
                display: 'block',
                marginTop: '8px',
              }}
            >
              {stats.minutesRemaining > 0
                ? `${stats.minutesRemaining} minutes remaining`
                : 'Monthly minutes used'}
            </small>
          </div>

          <div className="dashboardStatCard">
            <span>Avg. Call Duration</span>

            <strong>
              {stats.averageDuration}
            </strong>
          </div>
        </div>

        <section className="dashboardPhoneNumbersPanel">
          <div>
            <p className="dashboardEyebrow">ASSIGNED NUMBERS</p>
            <h2>
              {phoneNumbers.length === 1
                ? 'Your Recepta phone number'
                : 'Your Recepta phone numbers'}
            </h2>
          </div>

          <div className="dashboardPhoneNumbersList">
            {phoneNumbers.length > 0 ? (
              phoneNumbers.map((phoneNumber, index) => (
                <span key={phoneNumber}>
                  {phoneNumber}
                  {index === 0 && <small>Primary</small>}
                </span>
              ))
            ) : (
              <span>Numbers have not been assigned yet.</span>
            )}
          </div>
        </section>

        <CompanyStatisticsChart
          title={companyChart.title}
          points={companyChart.points}
        />

        {isPro && (
          <div className="dashboardTodayCard">
            <div>
              <p className="dashboardEyebrow">
                TODAY
              </p>

              <h2>
                {stats.appointmentsToday === 0
                  ? 'No appointments today'
                  : `${stats.appointmentsToday} ${
                      stats.appointmentsToday === 1
                        ? 'appointment'
                        : 'appointments'
                    } today`}
              </h2>

              <p>
                {stats.appointmentsToday === 0
                  ? 'Your receptionist has no customer appointments scheduled for today.'
                  : 'View today’s booked customers and appointment times.'}
              </p>
            </div>

            <a
              href="/dashboard/appointments"
              className="btn btnOutline"
            >
              View Appointments
            </a>
          </div>
        )}

        {effectiveAgentStatus !== 'live' && (
          <div className="onboardingProgressCard">
            <div className="onboardingProgressHead">
              <div>
                <p className="dashboardEyebrow">
                  AI CONFIGURATION
                </p>

                <h2>
                  AI configuration pending
                </h2>

                <p>
                  Your Recepta dashboard is ready. Your plan,
                  AI model and monthly minutes have already
                  been assigned. The only remaining setup is
                  connecting and configuring your AI receptionist.
                </p>
              </div>

              <span className="onboardingProgressPercent">
                Pending
              </span>
            </div>
          </div>
        )}

        {effectiveAgentStatus === 'live' && (
          <div className="dashboardEmptyState">
            <h2>
              {calls.length === 0
                ? 'Your receptionist is live'
                : 'Your receptionist is working'}
            </h2>

            <p>
              {calls.length === 0
                ? 'Recepta is ready to handle customer calls. Your dashboard will populate automatically as calls come in.'
                : 'Your dashboard is now showing real activity from your Recepta receptionist.'}
            </p>
          </div>
        )}
        </>
        )}
      </section>
    </main>
  )
}
