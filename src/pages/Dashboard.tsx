import type { CustomerService } from '../lib/serviceAccess'
import BillingAccessNotice from '../components/BillingAccessNotice'
import CompanyStatisticsChart from '../components/CompanyStatisticsChart'
import { callScheduling } from '../lib/clientAppointmentScheduling'
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



type Call = {
  duration_seconds: number
  appointment_booked: boolean
  started_at: string
  call_status: string | null
  caller_name?: string | null
  caller_number?: string | null
}

type AppointmentActivity = {
  days: Array<{ day: string; count: number }>
  timeZone: string
}

export default function Dashboard() {
  const [client, setClient] = useState<Client | null>(null)
  const [service, setService] = useState<CustomerService | null>(null)
  const [billingUsageSeconds, setBillingUsageSeconds] = useState(0)
  const [subscription, setSubscription] =
    useState<Subscription | null>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [clientId, setClientId] = useState<string | null>(null)
  const [appointmentActivity, setAppointmentActivity] = useState<{
    clientId: string
    data: AppointmentActivity | null
  } | null>(null)
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

      setClientId(user?.id ?? null)
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
      setService(subscriptionData.service)
      setBillingUsageSeconds(subscriptionData.usedSeconds)

      try {
        const callsResult = await fetchClientCalls()
        setCalls(callsResult.calls)
      } catch (error) {
        console.error('Dashboard call sync failed:', error)
      }

      if (agentData) {
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
    service?.reason === 'subscription_cancelled'

  const isPro =
    service?.plan === 'Recepta Pro'

  useEffect(() => {
    if (!isPro || !clientId) return
    const controller = new AbortController()
    let timer: number | undefined

    const refresh = async () => {
      try {
        const data = await callScheduling<AppointmentActivity>(
          undefined, { view: 'confirmed-activity' }, 'GET', undefined, controller.signal,
        )
        if (!controller.signal.aborted) setAppointmentActivity({ clientId, data })
      } catch {
        if (!controller.signal.aborted) setAppointmentActivity({ clientId, data: null })
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, 5000)
      }
    }

    void refresh()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [clientId, isPro])

  const activity = appointmentActivity?.clientId === clientId ? appointmentActivity : null
  const confirmedAppointments = activity?.data
  const confirmedToday = confirmedAppointments?.days.at(-1)?.count

  const isStandard =
    service?.plan === 'Recepta Standard'

  const effectiveAgentStatus: ClientStatus =
    service?.status === 'active' ? service.agent_status
      : ['paused', 'suspended', 'cancelled'].includes(service?.status ?? '') ? 'paused' : 'setup'
  const authorizedMinutes = service?.status === 'active' && service.source !== 'stripe'

  const activeCall = calls.find(
    (call) =>
      call.call_status === 'ongoing' ||
      call.call_status === 'registered'
  )

  const stats = useMemo(() => {
    const windowStart = service?.period_start ?? subscription?.current_period_start
    const periodStart = windowStart ? Date.parse(windowStart) : 0

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
    const totalAvailableMinutes = formatMinuteSeconds(authorizedMinutes ? service.service_allowance_seconds : balance.totalSeconds)
    const minutesRemaining = formatMinuteSeconds(authorizedMinutes ? service.remaining_seconds : balance.remainingSeconds)
    const usagePercentage = authorizedMinutes
      ? Math.round((1 - service.remaining_seconds / Math.max(1, service.service_allowance_seconds)) * 100)
      : balance.usagePercent

    const averageSeconds =
      callsAnswered > 0
        ? Math.round(totalSeconds / callsAnswered)
        : 0

    const averageMinutes =
      Math.floor(averageSeconds / 60)

    const averageRemainingSeconds =
      averageSeconds % 60

    return {
      callsAnswered,
      minutesTalked: formatMinuteSeconds(authorizedMinutes ? service.service_allowance_seconds - service.remaining_seconds : billingUsageSeconds),
      monthlyMinutes,
      rolloverMinutes,
      rolloverRemaining,
      paid: balance.paid,
      totalSeconds: balance.totalSeconds,
      remainingSeconds: balance.remainingSeconds,
      totalAvailableMinutes,
      minutesRemaining,
      usagePercentage,

      averageDuration:
        callsAnswered > 0
          ? `${averageMinutes}m ${String(
              averageRemainingSeconds
            ).padStart(2, '0')}s`
          : '0m 00s',
    }
  }, [calls, subscription, billingUsageSeconds, authorizedMinutes, service])

  const companyChart = useMemo(() => {
    const now = new Date()
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now)
      date.setHours(0, 0, 0, 0)
      date.setDate(date.getDate() - (6 - index))

      return {
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

    return days.map((day) => ({
      label: day.label,
      value: calls.filter((call) => toLocalDateKey(call.started_at) === day.key).length,
    }))
  }, [calls])

  const dayLabel = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'short' })
  const appointmentPoints = confirmedAppointments?.days.map(({ day, count }) => ({
    label: dayLabel.format(new Date(day + 'T00:00:00Z')),
    value: count,
  }))

  const getStatusInfo = () => {
    if (service?.service_status) return service.service_status === 'ongoing'
      ? { label:'Ongoing',color:'#00e676',background:'rgba(0, 230, 118, 0.10)' }
      : { label:'Paused',color:'#ffb020',background:'rgba(255, 176, 32, 0.10)' }

    if (isSubscriptionCancelled) return { label: 'Agent Paused', color:'#ffb020', background:'rgba(255, 176, 32, 0.10)' }
    if (service?.reason === 'provisioning') return {
      label: service.provisioning_status === 'needs_attention' ? 'Setup Needs Attention' : 'Configuring Agent',
      color:'#58b7ff', background:'rgba(88, 183, 255, 0.10)',
    }
    if (service?.reason === 'allowance_unavailable') {
      return { label: 'Minute Limit Reached', color: '#ffb020', background: 'rgba(255, 176, 32, 0.10)' }
    }
    if (service?.reason === 'billing_inactive') {
      return { label: 'Payment Required', color: '#ffb020', background: 'rgba(255, 176, 32, 0.10)' }
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

        <BillingAccessNotice subscription={subscription} service={service} />

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

          {isPro && <div className="dashboardStatCard">
            <span>Confirmed Today</span>
            <strong>{confirmedToday ?? '—'}</strong>
          </div>}

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
              {billingError ? 'Balance unavailable' : authorizedMinutes
                ? `${stats.minutesRemaining} minutes remaining in your authorized allowance`
                : stats.paid
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

        {isPro ? (
          <CompanyStatisticsChart
            title="Confirmed Appointments"
            points={appointmentPoints}
            detail={confirmedAppointments
              ? `Bookings created over the last seven days · ${confirmedAppointments.timeZone}`
              : 'Bookings created over the last seven days.'}
            unavailable={activity?.data === null}
            statusMessage={activity?.data === null ? 'Confirmed appointment activity is unavailable. Retrying automatically.'
              : !activity ? 'Loading confirmed appointment activity…'
              : appointmentPoints?.every(point => point.value === 0) ? 'No confirmed appointments were created in the last seven days.'
              : undefined}
          />
        ) : (
          <CompanyStatisticsChart title="Calls Picked Up" points={companyChart} />
        )}

        {stats.paid && effectiveAgentStatus === 'setup' && service?.reason !== 'provisioning' && (
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

        {service?.status === 'active' && effectiveAgentStatus === 'live' && service.reason === 'ready' && (
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
