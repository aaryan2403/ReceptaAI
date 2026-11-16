import { json, requestAuth } from '../lib/requestAuth'
import { objectValue, uuid } from '../lib/appointmentScheduling'

const agentIdValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{3,200}$/.test(value)

export default async (request: Request) => {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    return json(405, { error: 'Method not allowed.' })
  }
  try {
    // Existing live admin authentication; never allow a customer to issue their own grant.
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const { db, user } = auth

    const body = request.method === 'GET' ? null :
      objectValue(await request.json().catch(() => null))
    const query = new URL(request.url).searchParams
    const clientId = request.method === 'GET' ? query.get('clientId') : body?.clientId
    const agentId = request.method === 'GET' ? query.get('agentId') : body?.agentId
    if (!uuid(clientId) || !agentIdValid(agentId)) {
      return json(400, { error: 'Explicit client ID and Retell agent ID are required.' })
    }

    if (request.method === 'GET') {
      const { data, error } = await db.from('recepta_appointment_test_grants')
        .select('id, client_id, retell_agent_id, scope, expires_at, max_calls, used_calls, max_invocations, used_invocations, granted_at, revoked_at')
        .eq('client_id', clientId).eq('retell_agent_id', agentId)
        .order('granted_at', { ascending: false }).limit(5)
      if (error) throw error
      return json(200, { grants: data })
    }

    if (request.method === 'DELETE') {
      const { data, error } = await db.rpc('recepta_revoke_appointment_test', {
        p_client: clientId, p_agent: agentId, p_actor: user.id,
      })
      if (error) throw error
      return json(200, { revoked: data === true })
    }

    const expiresAt = body?.expiresAt
    const maxCalls = body?.maxCalls
    const maxInvocations = body?.maxInvocations
    const expiration = typeof expiresAt === 'string' ? new Date(expiresAt) : null
    if (!expiration || !Number.isFinite(expiration.getTime()) ||
        expiration.getTime() < Date.now() + 15 * 60 * 1000 ||
        expiration.getTime() > Date.now() + 48 * 60 * 60 * 1000 ||
        !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 10 ||
        !Number.isInteger(maxInvocations) || maxInvocations < maxCalls || maxInvocations > 50) {
      return json(400, { error: 'Use an expiration 15 minutes to 48 hours ahead, 1–10 distinct calls and at most 50 tool actions.' })
    }
    // The SQL function revalidates the unique agent assignment, selected pending Pro
    // plan, absent paid Stripe subscription and single-active-grant rule atomically.
    const { data, error } = await db.rpc('recepta_grant_appointment_test', {
      p_client: clientId, p_agent: agentId, p_expires_at: expiration.toISOString(),
      p_max_calls: maxCalls, p_max_invocations: maxInvocations, p_actor: user.id,
    })
    if (error) {
      if (error.code === '22023') {
        return json(409, { error: 'The selected client and agent are not eligible for an internal appointment test.' })
      }
      throw error
    }
    return json(201, { grant: data, notice: 'Appointment tools only. Billing, inbound calls, and transfers are unchanged.' })
  } catch (error) {
    console.error('Internal appointment test entitlement management failed', {
      code: typeof error === 'object' && error && 'code' in error ? error.code : null,
    })
    return json(503, { error: 'The internal test entitlement could not be managed.' })
  }
}
