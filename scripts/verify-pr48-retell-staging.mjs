import { createClient } from '@supabase/supabase-js'
import { build } from 'esbuild'

const preview = 'https://deploy-preview-48--receptaai.netlify.app'
const stage = 'https://mvufjeqxqvpcfqwmihpy.supabase.co'
const clientId = 'bebd295c-7a0e-49c1-966b-b6ef28792a22'
const agentId = 'agent_9b727a696b1dd6722fe2332353'
const retell = 'https://api.retellai.com'
const marker = 'pr48-retell-report:'

if (process.env.CONTEXT === 'deploy-preview' && process.env.DEPLOY_PRIME_URL?.replace(/\/$/, '') === preview) {
  const databaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')
  const dbKey = process.env.SUPABASE_SECRET_KEY
  const key = process.env.RETELL_STAGING_API_KEY?.trim()
  if (databaseUrl !== stage || !dbKey) throw new Error('PR 48 diagnostic requires its isolated staging database.')
  const db = createClient(stage, dbKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const requests = []
  const report = { run: process.env.COMMIT_REF ?? 'unknown', keyPresent: Boolean(key), requests }
  const saveReport = async () => {
    const saved = await db.from('booking_settings').update({ sync_error: marker + JSON.stringify(report) })
      .eq('client_id', clientId).select('client_id').single()
    if (saved.error) throw new Error('Unable to save sanitized staging diagnostic.')
  }
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(retell + path, {
      method, headers: { authorization: 'Bearer ' + key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(7500),
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, data,
      providerSaysWrongAsset: typeof data?.message === 'string' && /cannot find requested asset under given api key/i.test(data.message) }
  }

  try {
    if (!key || key === process.env.RETELL_API_KEY?.trim()) throw new Error('staging_key_missing_or_matches_production')
    const assigned = await db.from('agents').select('retell_agent_id').eq('client_id', clientId).single()
    if (assigned.error || assigned.data?.retell_agent_id !== agentId) throw new Error('unexpected_staging_assignment')
    const path = '/get-agent/' + agentId
    const [latest, published, versions] = await Promise.all([
      request(path), request(path + '?version=latest_published'),
      request('/list-agent-versions/' + agentId + '?limit=4&sort_order=descending'),
    ])
    const summarizeAgent = ({ status, data, providerSaysWrongAsset }) => ({
      status, providerSaysWrongAsset, matches: data?.agent_id === agentId,
      version: Number.isInteger(data?.version) ? data.version : null,
      published: data?.is_published === true,
      engineId: /^llm_[A-Za-z0-9_-]+$/.test(data?.response_engine?.llm_id ?? '') ? data.response_engine.llm_id : null,
      engineVersion: Number.isInteger(data?.response_engine?.version) ? data.response_engine.version : null,
    })
    report.latest = summarizeAgent(latest)
    report.published = summarizeAgent(published)
    report.versions = { status: versions.status, providerSaysWrongAsset: versions.providerSaysWrongAsset,
      versions: Array.isArray(versions.data?.items) ? versions.data.items.map(a => ({
        version: a.version, published: a.is_published === true,
      })) : [] }
    await saveReport()
    if (!report.published.matches || !report.published.published) {
      const list = await request('/list-agents', 'POST', { limit: 10 })
      report.list = { status: list.status, matchingAgentListed: Array.isArray(list.data?.items)
        && list.data.items.some(a => a.agent_id === agentId), hasMore: list.data?.has_more === true }
      throw new Error('published_staging_agent_not_accessible')
    }
    const engine = report.published
    if (!engine.engineId || engine.engineVersion === null) throw new Error('staging_engine_not_versioned')
    const getEngine = (id, version) => request('/get-retell-llm/' + id + '?version=' + version)
    const baseline = await getEngine(engine.engineId, engine.engineVersion)
    report.engine = { status: baseline.status, providerSaysWrongAsset: baseline.providerSaysWrongAsset,
      matches: baseline.data?.llm_id === engine.engineId && baseline.data?.version === engine.engineVersion }
    await saveReport()
    if (!report.engine.matches) throw new Error('published_staging_engine_not_accessible')

    const result = await build({ entryPoints: ['netlify/lib/appointmentAgentSetup.ts'],
      bundle: true, platform: 'node', format: 'esm', write: false })
    const { repairAppointmentAgent } = await import('data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64'))
    const access = await db.rpc('recepta_service_access', { p_client: clientId })
    if (access.error || access.data?.plan !== 'Recepta Pro' || access.data?.agent_id !== agentId) {
      throw new Error('staging_pro_binding_not_verified')
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const response = await originalFetch(input, options)
      if (url.origin === retell) requests.push({ operation: url.pathname.split('/')[1],
        method: options?.method ?? 'GET', status: response.status })
      return response
    }
    try {
      const repaired = await repairAppointmentAgent(db, clientId, { key, previewOrigin: preview }, {
        agentId, plan: 'Recepta Pro', expectedPlan: 'Recepta Pro', revision: access.data.revision, ensureCallEvents: false,
      })
      report.syncVersion = repaired.version
    } finally {
      globalThis.fetch = originalFetch
    }
    const live = summarizeAgent(await request(path + '?version=latest_published'))
    report.live = live
    if (!live.matches || !live.published || live.version !== report.syncVersion || !live.engineId) {
      throw new Error('published_version_readback_mismatch')
    }
    const registration = await getEngine(live.engineId, live.engineVersion)
    const names = ['find_appointment', 'check_appointment_availability', 'reschedule_appointment', 'cancel_appointment']
    const expectedUrl = preview + '/.netlify/functions/retell-appointment'
    if (!Array.isArray(registration.data?.general_tools)) throw new Error('published_tools_not_accessible')
    report.tools = names.map(name => {
      const matches = registration.data.general_tools.filter(tool => tool.name === name)
      const tool = matches[0]
      return { name, unique: matches.length === 1, stagingEndpoint: tool?.url === expectedUrl,
        post: tool?.method === 'POST', fullSignedPayload: tool?.args_at_root === false }
    })
    report.ok = report.tools.every(tool => tool.unique && tool.stagingEndpoint && tool.post && tool.fullSignedPayload)
  } catch (error) {
    const known = new Set(['staging_key_missing_or_matches_production','unexpected_staging_assignment','published_staging_agent_not_accessible',
      'staging_engine_not_versioned','published_staging_engine_not_accessible','staging_pro_binding_not_verified',
      'published_version_readback_mismatch','published_tools_not_accessible'])
    report.error = known.has(error?.message) ? error.message : 'staging_api_or_sync_error'
    if (typeof error?.status === 'number') report.status = error.status
  }
  await saveReport()
}
