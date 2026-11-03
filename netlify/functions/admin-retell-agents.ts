import { requestAuth, json } from '../lib/requestAuth'
import { listAvailableRetellAgents, retellAccessMessage } from '../lib/retell'

export default async (request: Request) => {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' })
  try {
    const auth = await requestAuth(request, true)
    if (auth.response) return auth.response
    const apiKey = process.env.RETELL_API_KEY
    if (!apiKey) return json(503, { error: 'RETELL_API_KEY is missing from this deployment. Configure it in Netlify for Production with Functions access, then redeploy.' })
    const cursor = new URL(request.url).searchParams.get('cursor') || undefined
    if (cursor && cursor.length > 2048) return json(400, { error: 'Invalid agent-list cursor.' })
    try {
      const page = await listAvailableRetellAgents(apiKey, cursor)
      return json(200, { ...page, checkedAt: new Date().toISOString() })
    } catch (error) {
      // Never return raw provider bodies, prompts, credentials or request headers.
      return json(502, { error: retellAccessMessage(error) })
    }
  } catch {
    return json(503, { error: 'Could not verify admin access. Sign in again and retry the connection check.' })
  }
}
