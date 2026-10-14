import { createClient } from '@supabase/supabase-js'
import { DEMO_CALL_MAX_SECONDS } from '../lib/callMinutes'
import { demoJson, hashDemoToken, isDemoToken, verifyDemoAgent } from '../lib/demoLinks'

export default async (request: Request) => {
  if (request.method !== 'POST') return demoJson(405, { error: 'Method not allowed.' })
  const token = request.headers.get('x-recepta-demo') ?? ''
  if (!isDemoToken(token)) return demoJson(404, { error: 'This demo link is unavailable.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, RETELL_API_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !RETELL_API_KEY) return demoJson(503, { error: 'The demo is not configured.' })
  let body
  try { body = await request.json() } catch { return demoJson(400, { error: 'Invalid request.' }) }
  if (body?.action !== 'inspect' && body?.action !== 'start') return demoJson(400, { error: 'Invalid demo action.' })
  if (body.action === 'start' && body.consent !== true) return demoJson(400, { error: 'Accept the demo notice before starting.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const tokenHash = hashDemoToken(token)
    const { data: link, error } = await db.from('recepta_demo_links').select('label, retell_agent_id, agent_version, expires_at, attempts, max_attempts, revoked').eq('token_hash', tokenHash).maybeSingle()
    if (error) throw new Error('Could not load the demo.')
    if (!link || link.revoked || Date.parse(link.expires_at) <= Date.now() || link.attempts >= link.max_attempts) return demoJson(404, { error: 'This demo link has expired or has no attempts left. Ask Recepta for a new one.' })
    if (body.action === 'inspect') return demoJson(200, { label: link.label, expiresAt: link.expires_at, attemptsRemaining: link.max_attempts - link.attempts })
    await verifyDemoAgent(RETELL_API_KEY, link.retell_agent_id, link.agent_version)
    const claimed = await db.rpc('claim_recepta_demo', { p_token_hash: tokenHash })
    if (claimed.error) throw new Error('Could not reserve this demo attempt.')
    const admission = claimed.data?.[0]
    if (!admission) return demoJson(409, { error: 'This demo is no longer available. Ask Recepta for a new link.' })
    // Ignore every browser-supplied agent, duration, tool and metadata field.
    const response = await fetch('https://api.retellai.com/v3/create-web-call', {
      method: 'POST', headers: { Authorization: `Bearer ${RETELL_API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        agent_id: admission.retell_agent_id, agent_version: admission.agent_version,
        metadata: { recepta_demo: true, demo_link_id: admission.id },
        agent_override: {
          agent: { max_call_duration_ms: DEMO_CALL_MAX_SECONDS * 1000, data_storage_setting: 'basic_attributes_only', webhook_events: [], contact_memory_config: { enable_read: false, enable_update: false } },
          retell_llm: { begin_message: 'Hi! I’m Recepta’s AI receptionist demo. Try asking a question or making a pretend appointment request. This demo lasts up to three minutes and does not make real bookings.' },
        },
      }),
    })
    if (!response.ok) throw new Error('The voice demo could not connect. This attempt was counted; contact Recepta if you need a replacement link.')
    const result = await response.json()
    if (typeof result.access_token !== 'string' || typeof result.call_id !== 'string' || result.transport !== 'gateway' || !Array.isArray(result.ice_servers)) throw new Error('The voice provider returned an unsupported connection.')
    return demoJson(201, { call_id: result.call_id, access_token: result.access_token, transport: result.transport, ice_servers: result.ice_servers, expires_at: result.expires_at })
  } catch {
    return demoJson(502, { error: 'The demo could not connect. Check microphone permission and ask Recepta for help or a replacement link.' })
  }
}
