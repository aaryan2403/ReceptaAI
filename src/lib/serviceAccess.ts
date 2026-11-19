export type ServicePlan = 'Recepta Pro' | 'Recepta Standard'
export type AgentStatus = 'setup' | 'testing' | 'live' | 'paused'
export type ServiceMode = 'automatic' | 'manual' | 'internal_test' | 'paused' | 'pending' | 'suspended' | 'cancelled'

export type ServiceAccess = {
  business_name: string
  mode: ServiceMode
  status: 'active' | 'pending' | 'paused' | 'suspended' | 'cancelled' | 'expired' | 'inactive' | 'unavailable' | 'appointment_test'
  source: 'stripe' | 'manual_admin' | 'internal_test'
  reason: string
  plan: ServicePlan | null
  plan_override: ServicePlan | null
  billing_plan: ServicePlan | null
  billing_current: boolean
  billing_status: string | null
  has_stripe_subscription: boolean
  agent_id: string | null
  agent_status: AgentStatus
  agent_status_override: AgentStatus | null
  provisioned_agent_status: AgentStatus
  assignment_valid: boolean
  phone_number: string | null
  can_reserve: boolean
  appointments: boolean
  remaining_seconds: number
  expires_at: string | null
  max_minutes: number | null
  configured_minutes: number | null
  saved_grant_mode: 'manual' | 'internal_test' | null
  saved_grant_expires_at: string | null
  admin_reason: string | null
  updated_at: string | null
  updated_by: string | null
  revision: number
  grant_id: string | null
  legacy_founder: boolean
  legacy_appointment_test: boolean
  legacy_test_usable: boolean
}
