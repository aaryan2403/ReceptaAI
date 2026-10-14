import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { demoJson, hashDemoToken, verifyDemoAgent } from '../lib/demoLinks'

export default async (request: Request) => {
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) return demoJson(405, { error: 'Method not allowed.' })
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return demoJson(401, { error: 'Unauthorized.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, RETELL_API_KEY, ADMIN_EMAIL } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !ADMIN_EMAIL || !RETELL_API_KEY) return demoJson(503, { error: 'Demo sharing is not configured.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7))
    if (error || !user) return demoJson(401, { error: 'Unauthorized.' })
    if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL.trim().toLowerCase()) return demoJson(403, { error: 'Admin access required.' })
    if (request.method === 'GET') {
      const result = await db.from('recepta_demo_links').select('id, label, retell_agent_id, created_at, expires_at, max_attempts, attempts, revoked').order('created_at', { ascending: false }).limit(100)
      if (result.error) throw new Error('Could not load demo links.')
      return demoJson(200, { links: result.data })
    }
    let body
    try { body = await request.json() } catch { return demoJson(400, { error: 'Invalid JSON.' }) }
    if (request.method === 'PATCH') {
      if (typeof body?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.id)) return demoJson(400, { error: 'Invalid demo link.' })
      const result = await db.from('recepta_demo_links').update({ revoked: true }).eq('id', body.id)
      if (result.error) throw new Error('Could not revoke demo link.')
      return demoJson(200, { success: true })
    }
    const label = typeof body?.label === 'string' ? body.label.trim() : ''
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    if (!label || label.length > 100 || !/^[a-zA-Z0-9_-]{1,120}$/.test(agentId)) return demoJson(400, { error: 'Enter a demo name and the full Retell Agent ID.' })
    const assigned = await db.from('agents').select('client_id').eq('retell_agent_id', agentId).limit(1)
    if (assigned.error) throw new Error('Could not check agent assignment.')
    if (assigned.data?.length) return demoJson(409, { error: 'Use a separate demo agent that is not assigned to a client account.' })
    const version = await verifyDemoAgent(RETELL_API_KEY, agentId)
    const token = randomBytes(32).toString('hex')
    const result = await db.from('recepta_demo_links').insert({ label, retell_agent_id: agentId, agent_version: version, token_hash: hashDemoToken(token) }).select('id, expires_at, max_attempts').single()
    if (result.error || !result.data) throw new Error('Could not create demo link.')
    // The token stays out of request paths, server logs and referrers.
    return demoJson(201, { ...result.data, url: `https://recepta.ca/demo#${token}` })
  } catch (error) {
    return demoJson(400, { error: error instanceof Error ? error.message : 'Could not manage demo links.' })
  }
}
