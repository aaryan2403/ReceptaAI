import { syncClientReceptionist } from '../lib/appointmentAgentSetup'
import { objectValue, uuid } from '../lib/appointmentScheduling'
import { json, requestAuth } from '../lib/requestAuth'
import { getPublishedRetellAgent, inspectRetellPhoneRoute, receptaRetellOrigin, retellScheduleSyncMessage } from '../lib/retell'
import { loadServiceAccess, serviceDeployment, type ServiceMode } from '../lib/serviceAccess'

const actions = ['save', 'activate_test', 'pause', 'revoke', 'activate', 'deactivate', 'reactivate']
const modes = ['automatic', 'manual', 'internal_test', 'paused', 'pending', 'suspended', 'cancelled']
const agentStatuses = ['setup', 'testing', 'live', 'paused']
const actionModes: Partial<Record<string, ServiceMode>> = {
  activate_test: 'internal_test', pause: 'paused', deactivate: 'paused', revoke: 'pending',
}
const isServicePlan = (value: unknown) => value === 'Recepta Standard' || value === 'Recepta Pro'

export default async (request: Request) => {
  if (!['GET', 'PUT'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  const url = new URL(request.url)
  const clientId = url.searchParams.get('clientId')
  if (!uuid(clientId)) return json(400, { error: 'A valid client is required.' })

  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return json(503, { error: 'This preview must use Recepta Staging.' })

  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const { db, user } = auth
    const current = await loadServiceAccess(db, clientId)
    if (current.reason === 'client_unavailable') return json(404, { error: 'The client is unavailable.' })
    if (request.method === 'GET') {
      if (url.searchParams.get('history') !== '1') return json(200, { access: current })
      const history = await db.from('recepta_service_access_audit')
        .select('id, actor_id, action, occurred_at, previous_state, new_state')
        .eq('client_id', clientId).order('occurred_at', { ascending: false }).limit(12)
      if (history.error) throw history.error
      return json(200, { access: current, history: history.data })
    }

    const body = objectValue(await request.json().catch(() => null))
    if (body.action === 'pro_lifecycle') {
      const status = body.serviceStatus
      if (current.plan !== 'Recepta Pro' || typeof status !== 'string' || !['ongoing','paused','deadline'].includes(status) ||
        !Number.isInteger(body.revision) || body.revision !== current.lifecycle_revision || body.agentId !== current.agent_id) {
        return json(409, { error: 'Service settings changed. Refresh and try again.' })
      }
      const cutoff = typeof body.retentionDeadline === 'string' ? Date.parse(body.retentionDeadline) : NaN
      if (status === 'deadline' && !Number.isFinite(cutoff)) return json(400, { error: 'Select a retention deadline.' })
      if (status === 'ongoing' && current.retention_operation !== 'deleted') {
        if (current.retention_operation) return json(409, { error: 'The existing agent is being updated. Try again shortly.' })
        try {
          await syncClientReceptionist(db,clientId,current,'Recepta Pro',deployment)
        } catch (error) {
          return json(409,{ error:retellScheduleSyncMessage(error) })
        }
      }
      const result = await db.rpc('recepta_manage_pro_service',{
        p_client:clientId,p_actor:user.id,p_status:status,p_revision:body.revision,
        p_retention:Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
        p_reason:typeof body.reason==='string' ? body.reason.trim() : null,p_agent:current.agent_id,
      })
      if (result.error) {
        if (['40001','22023'].includes(result.error.code)) return json(409,{ error:result.error.message })
        throw result.error
      }
      return json(200,{ access:result.data })
    }

    const { action, mode, revision, maxMinutes } = body
    if (typeof action !== 'string' || !actions.includes(action) ||
      typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      return json(400, { error: 'Select a valid service access option.' })
    }
    if (revision !== current.revision) return json(409, { error: 'Service settings changed. Refresh and try again.' })

    const legacy = !Object.hasOwn(body, 'servicePlan') && !Object.hasOwn(body, 'agentStatus') &&
      ['save', 'activate_test', 'pause', 'revoke'].includes(action)
    const nextMode = actionModes[action] ?? mode
    const enabling = action === 'activate' || action === 'reactivate'
    const temporary = nextMode === 'internal_test'
    const granting = temporary || nextMode === 'manual'
    const selectedPlan = legacy ? (granting ? body.plan : current.plan_override) : body.servicePlan
    const agentStatus = enabling ? 'live' : legacy ? current.agent_status_override : body.agentStatus
    if (typeof nextMode !== 'string' || !modes.includes(nextMode) ||
      (enabling && nextMode !== 'automatic' && !granting) ||
      (selectedPlan != null && !isServicePlan(selectedPlan)) ||
      (agentStatus != null && (typeof agentStatus !== 'string' || !agentStatuses.includes(agentStatus)))) {
      return json(400, { error: 'Select valid service, plan and agent settings.' })
    }
    if (enabling && nextMode === 'automatic' && !current.billing_current) {
      return json(409, { error: 'Choose manual authorization to activate a client with no current Stripe payment.' })
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const expires = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : null
    const validAllowance = typeof maxMinutes === 'number' && Number.isInteger(maxMinutes) && maxMinutes >= 1 && maxMinutes <= 100_000_000
    if (granting && (!reason || reason.length > 1000 ||
      (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) ||
      (temporary && (expires === null || !validAllowance)) ||
      (!temporary && !current.configured_minutes && !validAllowance) ||
      (legacy && (expires === null || !isServicePlan(selectedPlan))))) {
      return json(400, { error: 'Provide an authorization reason and valid allowance. Temporary access requires a future expiration.' })
    }

    const needsAssignment = granting || agentStatus === 'live' || agentStatus === 'testing'
    if (needsAssignment && (!current.assignment_valid || !current.agent_id || body.agentId !== current.agent_id)) {
      return json(409, { error: 'Verify the saved Retell agent is assigned exclusively to this client, then refresh.' })
    }

    const targetAgentStatus = agentStatus ?? current.provisioned_agent_status
    const admitting = (granting || (nextMode === 'automatic' && current.billing_current)) &&
      (targetAgentStatus === 'live' || (targetAgentStatus === 'testing' && temporary))
    if ((legacy && granting) || (!legacy && admitting)) {
      if (!deployment.key) return json(503, { error: 'The Retell workspace key for this deployment is missing.' })
      const servicePlan = isServicePlan(selectedPlan) ? selectedPlan : current.billing_plan ?? 'Recepta Standard'
      try {
        if (legacy) {
          if (!current.phone_number) return json(409, { error: 'Assign a Retell phone number before activating service.' })
          const [, issue] = await Promise.all([
            getPublishedRetellAgent(deployment.key, current.agent_id!),
            inspectRetellPhoneRoute(deployment.key, current.phone_number, deployment.previewOrigin ?? receptaRetellOrigin(false)),
          ])
          if (issue) return json(409, { error: issue })
        } else {
          await syncClientReceptionist(db, clientId, current, servicePlan, deployment)
        }
      } catch (error) {
        return json(409, { error: retellScheduleSyncMessage(error) })
      }
    }

    const common = {
      p_client: clientId, p_actor: user.id, p_action: action, p_mode: nextMode,
      p_plan: selectedPlan ?? null, p_agent: current.agent_id,
      p_reason: granting ? reason : null, p_expires_at: granting && expires !== null ? new Date(expires).toISOString() : null,
      p_max_minutes: validAllowance ? maxMinutes : null, p_revision: revision,
    }
    const { data, error } = legacy
      ? await db.rpc('recepta_save_service_access', common)
      : await db.rpc('recepta_manage_client_service', { ...common, p_agent_status: agentStatus ?? (granting ? current.provisioned_agent_status : null) })
    if (error) {
      if (['40001', '22023', 'P0002'].includes(error.code)) return json(409, { error: error.message })
      throw error
    }
    return json(200, { access: data })
  } catch (error) {
    console.error('Could not manage Recepta service access', error)
    return json(503, { error: 'Service access could not be loaded or saved.' })
  }
}
