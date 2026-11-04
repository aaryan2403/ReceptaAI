import { requestAuth, json } from '../lib/requestAuth'
import { getAvailableRetellAgent, listAvailableRetellAgents, retellAccessDetails } from '../lib/retell'

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const apiKey = process.env.RETELL_API_KEY?.trim()
    if (!apiKey) return json(503, { error: 'RETELL_API_KEY is missing from this deployment. Configure it in Netlify for Production with Functions access, then redeploy.' })
    const params = new URL(request.url).searchParams
    const cursor = params.get('cursor') || undefined
    const agentId = params.get('agentId')?.trim() || undefined
    if (cursor && cursor.length > 2048) return json(400, { error: 'Invalid agent-list cursor.' })
    if (agentId && (!/^agent_[\w-]{1,194}$/.test(agentId) || cursor)) return json(400, { error: 'Enter a complete Retell Agent ID. Direct agent checks cannot use a list cursor.' })
    try {
      // Checking an entered ID must not depend on the separate list endpoint.
      const page = agentId
        ? { agents: [await getAvailableRetellAgent({ apiKey, agentId })], nextCursor: null }
        : await listAvailableRetellAgents(apiKey, cursor)
      return json(200, { ...page, checkedAt: new Date().toISOString() })
    } catch (error) {
      // Never return raw provider bodies, prompts, credentials or request headers.
      return json(502, retellAccessDetails(error, agentId ? 'agent' : 'list'))
    }
  } catch {
    return json(503, { error: 'Could not verify admin access. Sign in again and retry the connection check.' })
  }
}
