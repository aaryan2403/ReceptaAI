export type ServicePlan = 'Recepta Pro' | 'Recepta Standard'
export type AgentStatus = 'setup' | 'testing' | 'live' | 'paused'
export type ServiceMode = 'automatic' | 'manual' | 'internal_test' | 'paused' | 'pending' | 'suspended' | 'cancelled'

export type ServiceAccess = {
  service_status?: 'ongoing' | 'paused'
  retention_reason?: 'cancellation' | 'nonpayment' | 'admin_pause' | null
  retention_started_at?: string | null
  retention_deadline?: string | null
  payment_grace_ends_at?: string | null
  retention_operation?: 'deleting' | 'deleted' | 'restoring' | null
  retention_error?: string | null
  lifecycle_revision?: number
  business_name: string
  mode: ServiceMode
  status: 'active' | 'pending' | 'paused' | 'suspended' | 'cancelled' | 'expired' | 'inactive' | 'unavailable' | 'appointment_test'
  source: 'stripe' | 'manual_admin' | 'internal_test' | 'automatic_pro'
  reason: string
  plan: ServicePlan | null
  plan_override: ServicePlan | null
  billing_plan: ServicePlan | null
  billing_current: boolean
  provisioning_status: 'queued' | 'running' | 'complete' | 'needs_attention' | null
  provisioning_error: string | null
  provisioned_pro: boolean
  service_allowance_seconds: number
  cancellation_effective_at: string | null
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
  period_start: string | null
  period_end: string | null
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

export type CustomerService = Pick<ServiceAccess, 'status' | 'reason' | 'plan' | 'source' | 'agent_status' |
  'can_reserve' | 'appointments' | 'remaining_seconds' | 'service_allowance_seconds' | 'period_start' | 'period_end' |
  'provisioning_status' | 'cancellation_effective_at' | 'service_status' | 'retention_reason' |
  'retention_started_at' | 'retention_deadline' | 'retention_operation' | 'payment_grace_ends_at'>

export const retentionDays = (deadline: string, now = Date.now()) =>
  Math.max(0, Math.ceil((Date.parse(deadline) - now) / 86_400_000))
