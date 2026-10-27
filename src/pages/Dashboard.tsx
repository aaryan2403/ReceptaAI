import BillingAccessNotice from '../components/BillingAccessNotice'
import { type AppointmentStatus } from '../lib/appointmentRequests'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchClientCalls } from '../lib/clientCalls'
import { fetchBillingStatus } from '../lib/billing'
import { calculateMinuteBalance, formatMinuteSeconds } from '../lib/minuteBalance'

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
  rollover_seconds: number
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
  status: AppointmentStatus
  created_at: string
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
  const [billingUsageSeconds, setBillingUsageSeconds] = useState(0)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [agent, setAgent] =
    useState<Agent | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [appointments, setAppointments] =
    useState<Appointment[]>([])
  const [phoneNumbers, setPhoneNumbers] =
    useState<string[]>([])
  const [billingError, setBillingError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadDashboard = async () => {
      try {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const [
        { data: clientData },
        subscriptionData,
        { data: agentData },
        { data: phoneNumberData },
      ] = await Promise.all([
        supabase
          .from('clients')
          .select('company_name, contact_email, status')
          .eq('id', user.id)
          .single(),

        fetchBillingStatus(),

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

      setSubscription(subscriptionData.subscription)
      setBillingUsageSeconds(subscriptionData.usedSeconds)

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
        subscriptionData.subscription?.status === 'active' &&
        subscriptionData.subscription?.plan_name === 'Recepta Pro'

      if (isPro) {
        const { data: appointmentsData } = await supabase
          .from('appointments')
          .select('id, appointment_time, status, created_at')
          .eq('client_id', user.id)

        if (appointmentsData) {
          setAppointments(appointmentsData)
        }
      } else {
        setAppointments([])
      }

      setBillingError('')
      } catch (error) {
        setBillingError(error instanceof Error ? error.message : 'Could not load your dashboard.')
      } finally { setLoading(false) }
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

  const isPro =
    subscription?.plan_name === 'Recepta Pro'

  const isStandard =
    subscription?.plan_name === 'Recepta Standard'

  const effectiveAgentStatus: ClientStatus =
    isSubscriptionCancelled || subscription?.status !== 'active'
      ? 'paused'
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

    const balance = calculateMinuteBalance(subscription ?? { monthly_minutes: 0, status: null }, billingUsageSeconds)
    const monthlyMinutes = subscription?.monthly_minutes ?? 0
    const rolloverMinutes = formatMinuteSeconds(balance.rolloverSeconds)
    const rolloverRemaining = formatMinuteSeconds(balance.rolloverRemainingSeconds)
    const totalAvailableMinutes = formatMinuteSeconds(balance.totalSeconds)
    const minutesRemaining = formatMinuteSeconds(balance.remainingSeconds)
    const usagePercentage = balance.usagePercent

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
          !appointment.created_at ||
          appointment.status !== 'pending'
        ) {
          return false
        }

        const appointmentDate =
          new Date(appointment.created_at)

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
      minutesTalked: formatMinuteSeconds(billingUsageSeconds),
      monthlyMinutes,
      rolloverMinutes,
      rolloverRemaining,
      paid: balance.paid,
      totalSeconds: balance.totalSeconds,
      remainingSeconds: balance.remainingSeconds,
      totalAvailableMinutes,
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
  }, [calls, appointments, subscription, billingUsageSeconds])

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
              appointment.status === 'pending' &&
              toLocalDateKey(appointment.created_at) === day.key
          ).length
        : calls.filter(
            (call) => toLocalDateKey(call.started_at) === day.key
          ).length,
    }))

    return {
      title: isPro ? 'Pending Appointment Requests' : 'Calls Picked Up',
      points,
    }
  }, [appointments, calls, isPro])

  const getStatusInfo = () => {
    if (isSubscriptionCancelled || subscription?.status !== 'active') {
      return { label: isSubscriptionCancelled ? 'Billing Cancelled' : 'Payment Required', color:'#ffb020',background:'rgba(255, 176, 32, 0.10)',border:'rgba(255, 176, 32, 0.20)',shadow:'rgba(255, 176, 32, 0.35)' }
    }
    if (!stats.paid) {
      return { label: 'Payment Required', color: '#ffb020', background: 'rgba(255, 176, 32, 0.10)' }
    }
    if (
      subscription?.status === 'active' &&
      stats.paid &&
      stats.totalSeconds > 0 &&
      stats.remainingSeconds === 0
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

          <a
            href="/dashboard/agent"
            className="dashboardNavItem"
          >
            Agent
          </a>

          <a href="/dashboard/requests" className="dashboardNavItem">
            Customer Requests
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

        <BillingAccessNotice subscription={subscription} />

        <section className="dashboardRequestShortcut">
          <div>
            <p className="dashboardEyebrow">SUPPORT</p>
            <h2>Need any changes? Ask for help</h2>
            <p>
              Ask Recepta for an agent update, website change, billing help or
              anything else you need.
            </p>
          </div>

          <a
            className="btn btnPrimary"
            href="https://mail.google.com/mail/?view=cm&fs=1&to=receptahelp02@gmail.com&su=Recepta%20Help%20Request"
            target="_blank"
            rel="noreferrer"
          >
            Ask for Help
          </a>
        </section>

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
              href="/dashboard/calls"
              className="dashboardStatCard dashboardStatCardLink"
            >
              <span>Requests Today</span>

              <strong>
                {stats.appointmentsToday}
              </strong>

              <small>
                {stats.appointmentsToday === 1
                  ? '1 pending request — follow-up required'
                  : `${stats.appointmentsToday} pending requests — follow-up required`}
              </small>
            </a>
          )}

          <div className="dashboardStatCard">
            <span>Minutes Used</span>
            {billingError && <p role="alert">{billingError}</p>}

            <strong>
              {stats.minutesTalked} /{' '}
              {stats.totalAvailableMinutes} min
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
              {billingError ? 'Balance unavailable' : stats.paid
                ? `${stats.minutesRemaining} minutes remaining · ${stats.rolloverRemaining} rollover left`
                : 'Minutes unavailable until payment is confirmed'}
              {subscription?.current_period_end && <><br />Rollover expires {new Date(subscription.current_period_end).toLocaleDateString('en-CA')}. Monthly renewal is required.</>}
              <br /><a href="/dashboard/billing">View balance and next payment</a>
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
                  ? 'No pending requests captured today'
                  : `${stats.appointmentsToday} ${
                      stats.appointmentsToday === 1
                        ? 'pending request'
                        : 'pending requests'
                    } today`}
              </h2>

              <p>
                {stats.appointmentsToday === 0
                  ? 'There are no pending requests captured today.'
                  : 'Review the caller’s preferences and contact them to confirm an appointment.'}
              </p>
            </div>

            <a
              href="/dashboard/calls"
              className="btn btnOutline"
            >
              View Calls
            </a>
          </div>
        )}

        {stats.paid && effectiveAgentStatus !== 'live' && (
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

        {stats.paid && effectiveAgentStatus === 'live' && (
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
      </section>
    </main>
  )
}
