import { objectValue, uuid } from '../lib/appointmentScheduling'
import { json, requestAuth } from '../lib/requestAuth'
import { getPublishedRetellAgent, inspectRetellPhoneRoute, receptaRetellOrigin, retellScheduleSyncMessage } from '../lib/retell'
import { loadServiceAccess, serviceDeployment } from '../lib/serviceAccess'

const actions = ['save', 'activate_test', 'pause', 'revoke']
const modes = ['automatic', 'manual', 'internal_test', 'paused', 'pending']

export default async (request: Request) => {
  if (!['GET', 'PUT'].includes(request.method)) return json(405, { error: 'Method not allowed.' })
  const clientId = new URL(request.url).searchParams.get('clientId')
  if (!uuid(clientId)) return json(400, { error: 'A valid client is required.' })

  const { isolated, key, previewOrigin } = serviceDeployment(request)
  if (!isolated) return json(503, { error: 'This preview must use Recepta Staging.' })

  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const { db, user } = auth
    const current = await loadServiceAccess(db, clientId)
    if (current.reason === 'client_unavailable') return json(404, { error: 'The client is unavailable.' })
    if (request.method === 'GET') return json(200, { access: current })

    const body = objectValue(await request.json().catch(() => null))
    const { action, mode, revision, plan, maxMinutes } = body
    if (typeof action !== 'string' || !actions.includes(action) ||
      (action === 'save' && (typeof mode !== 'string' || !modes.includes(mode))) ||
      typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      return json(400, { error: 'Select a valid service access option.' })
    }
    if (revision !== current.revision) return json(409, { error: 'Service access changed. Refresh and try again.' })
    const temporary = action === 'activate_test' || (action === 'save' && mode === 'internal_test')
    const granting = temporary || (action === 'save' && mode === 'manual')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const expires = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN
    if (granting) {
      if (!reason || reason.length > 1000 || !Number.isFinite(expires) || expires <= Date.now() ||
        (plan !== 'Recepta Standard' && plan !== 'Recepta Pro') ||
        (temporary && (typeof maxMinutes !== 'number' || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 100_000_000))) {
        return json(400, { error: 'Choose a plan, enter an authorization reason and future expiration, and provide a whole-number allowance for temporary access.' })
      }
      if (!current.assignment_valid || !current.agent_id) {
        return json(409, { error: 'Assign and save an agent that belongs only to this client.' })
      }
      if (body.agentId !== current.agent_id) {
        return json(409, { error: 'The assigned agent changed. Refresh and review the assignment before authorizing access.' })
      }
      if (!key) return json(503, { error: 'The Retell workspace key for this deployment is missing.' })
      try {
        if (!current.phone_number) return json(409, { error: 'Assign and save a Retell phone number before activating service.' })
        const [, routeIssue] = await Promise.all([
          getPublishedRetellAgent(key, current.agent_id),
          inspectRetellPhoneRoute(key, current.phone_number, previewOrigin ?? receptaRetellOrigin(false)),
        ])
        if (routeIssue) return json(409, { error: routeIssue })
      } catch (error) {
        return json(409, { error: retellScheduleSyncMessage(error) })
      }
    }

    const { data, error } = await db.rpc('recepta_save_service_access', {
      p_client: clientId, p_actor: user.id, p_action: action, p_mode: action === 'save' ? mode : null,
      p_plan: granting ? plan : null, p_agent: granting ? current.agent_id : null,
      p_reason: granting ? reason : null, p_expires_at: granting ? new Date(expires).toISOString() : null,
      p_max_minutes: temporary ? maxMinutes : null, p_revision: revision,
    })
    if (error) {
      if (error.code === '40001' || error.code === '22023' || error.code === 'P0002') {
        return json(409, { error: error.message })
      }
      throw error
    }
    return json(200, { access: data })
  } catch (error) {
    console.error('Could not manage Recepta service access', error)
    return json(503, { error: 'Service access could not be loaded or saved.' })
  }
}
