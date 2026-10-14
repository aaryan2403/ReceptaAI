import { createHash } from 'node:crypto'

export const hashDemoToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const isDemoToken = (token: string) => /^[a-f0-9]{64}$/.test(token)
export const demoJson = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

const retellRead = async (apiKey: string, path: string) => {
  const response = await fetch(`https://api.retellai.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(7000),
  })
  if (!response.ok) throw new Error('Could not verify this agent in the connected Retell workspace.')
  return response.json()
}

// Only dedicated, published prompt agents with no external tools are shareable.
// Recheck the exact version at every start; never change a customer's live agent.
export const verifyDemoAgent = async (apiKey: string, agentId: string, version?: number): Promise<number> => {
  const agent = await retellRead(apiKey, `/get-agent/${encodeURIComponent(agentId)}?version=${version ?? 'latest_published'}`)
  const publishedVersion = agent.version
  const engine = agent.response_engine
  if (agent.agent_id !== agentId || !Number.isInteger(publishedVersion) || publishedVersion < 0 || agent.is_published !== true || (version !== undefined && publishedVersion !== version)) {
    throw new Error('Publish the demo agent in Retell before creating a link. For an old link, create a new one if its version was unpublished.')
  }
  if (engine?.type !== 'retell-llm' || !engine.llm_id || !Number.isInteger(engine.version)) {
    throw new Error('Use a separate single-prompt or multi-prompt Retell agent for this voice demo.')
  }
  const llm = await retellRead(apiKey, `/get-retell-llm/${encodeURIComponent(engine.llm_id)}?version=${engine.version}`)
  const tools = [...(llm.general_tools ?? []), ...(llm.states ?? []).flatMap((state: { tools?: Array<{ type?: string }> }) => state.tools ?? [])]
  if (tools.some((tool: { type?: string }) => tool.type !== 'end_call') || agent.pre_session_tools?.length) {
    throw new Error('Remove booking, transfer, custom and other external tools from the demo agent. Only End Call is allowed.')
  }
  return publishedVersion
}
