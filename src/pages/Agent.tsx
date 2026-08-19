import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type AgentStatus = 'setup' | 'testing' | 'live' | 'paused'

type AgentRecord = {
  agent_name: string | null
  phone_number: string | null
  business_hours: string | null
  status: AgentStatus
}

export default function Agent() {
  const [agent, setAgent] = useState<AgentRecord | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadAgent = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('agents')
        .select('agent_name, phone_number, business_hours, status')
        .eq('client_id', user.id)
        .maybeSingle()

      if (!error && data) {
        setAgent(data)
      }

      setLoading(false)
    }

    loadAgent()
  }, [])

  const getStatusInfo = () => {
    switch (agent?.status) {
      case 'live':
        return {
          label: 'Agent Live',
          color: '#00c853',
          background: 'rgba(0, 200, 83, 0.10)',
          border: 'rgba(0, 200, 83, 0.20)',
          shadow: 'rgba(0, 200, 83, 0.7)',
        }

      case 'testing':
        return {
          label: 'Agent Testing',
          color: '#3da5ff',
          background: 'rgba(61, 165, 255, 0.10)',
          border: 'rgba(61, 165, 255, 0.20)',
          shadow: 'rgba(61, 165, 255, 0.7)',
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
          label: 'Setup in progress',
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
          Loading agent...
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
          <a href="/dashboard" className="dashboardNavItem">
            Overview
          </a>

          <a href="/dashboard/calls" className="dashboardNavItem">
            Calls
          </a>

          <a href="/dashboard/appointments" className="dashboardNavItem">
            Appointments
          </a>

          <a
            href="/dashboard/agent"
            className="dashboardNavItem dashboardNavItemActive"
          >
            Agent
          </a>

          <a href="/dashboard/billing" className="dashboardNavItem">
            Billing
          </a>

          <a href="/dashboard/settings" className="dashboardNavItem">
            Settings
          </a>
        </nav>
      </aside>

      <section className="dashboardMain">
        <div className="dashboardHeader">
          <div>
            <p className="dashboardEyebrow">YOUR AGENT</p>
            <h1>{agent?.agent_name || 'AI Receptionist'}</h1>
            <p>
              View the status and configuration of your Recepta receptionist.
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

        <div className="dashboardStats">
          <div className="dashboardStatCard">
            <span>Agent Name</span>
            <strong>{agent?.agent_name || 'Not assigned'}</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Phone Number</span>
            <strong>{agent?.phone_number || 'Not assigned'}</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Business Hours</span>
            <strong>{agent?.business_hours || 'Not configured'}</strong>
          </div>

          <div className="dashboardStatCard">
            <span>Status</span>
            <strong>{status.label}</strong>
          </div>
        </div>

        <div className="dashboardEmptyState">
          {agent?.status === 'live' ? (
            <>
              <h2>Your receptionist is live</h2>
              <p>
                Recepta is active and ready to handle customer calls.
              </p>
            </>
          ) : (
            <>
              <h2>Your receptionist is being prepared</h2>
              <p>
                We’re configuring your business details, call rules, appointment
                preferences, and phone setup before your receptionist goes live.
              </p>
            </>
          )}
        </div>
      </section>
    </main>
  )
}
