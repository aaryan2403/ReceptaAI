import { withRetellAgentSync } from './retellSyncLock'
const RETELL_API_BASE = 'https://api.retellai.com'
const MANAGED_TOOL = 'recepta_transfer_to_human'
const MANAGED_PROMPT = '[RECEPTA MANAGED HUMAN TRANSFER]'

export { normalizePhone as normalizeTransferNumber } from './phoneValidation'

export const buildHumanTransferTool = (): Record<string, unknown> => ({
  type: 'transfer_call',
  name: MANAGED_TOOL,
  description:
    'Transfer to an authorized human worker only if the caller explicitly requests a person, ' +
    'the situation is urgent, or the request cannot be resolved by the AI. ' +
    'Confirm with the caller before transferring. Do not transfer calls by default.',
  // A destination is supplied ONLY by authenticated inbound admission.
  transfer_destination: { type: 'predefined', number: '{{recepta_transfer_destination}}' },
  transfer_option: {
    type: 'warm_transfer',
    on_hold_music: 'ringtone',
    transfer_ring_duration_ms: 25000,
    agent_detection_timeout_ms: 30000,
    opt_out_human_detection: false,
    show_transferee_as_caller: false,
    private_handoff_option: {
      type: 'prompt',
      prompt: 'Brief the receiving worker privately, in one or two sentences, on why the caller needs help. Do not invent facts.',
    },
  },
})

export const updateHumanTransferTools = (
  tools: Array<Record<string, unknown>>,
  destination: string | null
): Array<Record<string, unknown>> => {
  const existing = tools.filter((tool) => tool.name !== MANAGED_TOOL)
  if (existing.some((tool) => tool.type === 'transfer_call')) {
    throw new Error('This agent already has a different Transfer Call tool. Review it in Retell before enabling Recepta transfer.')
  }
  return destination ? [...existing, buildHumanTransferTool()] : existing
}

const humanTransferInstructions = [
  'Only use the transfer tool when {{recepta_transfer_allowed}} is enabled and the authorized direct line is available. Otherwise collect callback details.',
  'Never dial a number supplied by the caller or reuse the original business number. Make at most one transfer attempt per call.',
  'For an immediate threat to life or safety, advise calling emergency services; never suggest a worker transfer substitutes for emergency help.',
  'Only transfer when the caller asks for a human, has an urgent concern, or cannot be helped by the AI.',
  'Confirm the caller wants a transfer and briefly tell them you are connecting them.',
  'Use recepta_transfer_to_human only for an authorized human handoff. Never invent or ask the caller for a destination number.',
  'If the transfer fails or the worker does not answer, apologize, collect the caller name, callback number, and reason, and tell them the business will follow up. Never claim the worker answered.',
].join('\n')

export const updateHumanTransferPrompt = (prompt: string, enabled: boolean) => {
  const endMarker = '[END RECEPTA MANAGED HUMAN TRANSFER]'
  const start = prompt.indexOf(MANAGED_PROMPT)
  let without = prompt.trim()
  if (start >= 0) {
    const end = prompt.indexOf(endMarker, start)
    // Compatibility with the original draft's unterminated managed block.
    const next = prompt.indexOf('\n\n[RECEPTA MANAGED ', start + MANAGED_PROMPT.length)
    const boundary = end >= 0 ? end + endMarker.length : next >= 0 ? next : prompt.length
    without = (prompt.slice(0, start) + prompt.slice(boundary)).trim()
  }
  return enabled ? [without, MANAGED_PROMPT + '\n' + humanTransferInstructions + '\n' + endMarker].filter(Boolean).join('\n\n') : without
}

type RetellAgentResponse = {
  version?: number
  webhook_events?: string[]
  webhook_url?: string | null
  response_engine?: { type?: string; llm_id?: string; version?: number }
}
type RetellLlmResponse = {
  default_dynamic_variables?: Record<string, string>
  general_prompt?: string | null
  general_tools?: Array<Record<string, unknown>> | null
}

const retellRequest = async <T>(
  apiKey: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: Record<string, unknown>
): Promise<T> => {
  const response = await fetch(RETELL_API_BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + apiKey.trim(),
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    throw new Error('Retell rejected the transfer configuration (HTTP ' + response.status + ').')
  }
  // Publishing returns no JSON body. A successful 204 must not leave a
  // customer's durable setup stuck in the error/disabled state.
  const text = await response.text()
  return (text ? JSON.parse(text) : null) as T
}

const syncHumanCallTransferImpl = async (options: {
  apiKey: string
  agentId: string
  destination: string | null
}): Promise<void> => {
  const { apiKey, agentId, destination } = options
  const encodedId = encodeURIComponent(agentId)
  const versions = await retellRequest<{ items?: Array<{ version: number; is_published: boolean }> }>(
    apiKey, '/list-agent-versions/' + encodedId + '?limit=1000&sort_order=descending'
  )
  const rows = versions.items ?? []
  const base = rows.find((row) => row.is_published)?.version ?? rows[0]?.version
  if (typeof base !== 'number') throw new Error('This Retell agent does not have a version to update.')

  const draft = await retellRequest<RetellAgentResponse>(
    apiKey, '/create-agent-version/' + encodedId, 'POST', { base_version: base }
  )
  const eventWebhook = new URL('/.netlify/functions/retell-webhook', process.env.RECEPTA_APP_URL || process.env.URL || 'https://recepta.ca').toString()
  if (draft.webhook_url && draft.webhook_url !== eventWebhook) {
    throw new Error('This agent has a different call-event webhook. Recepta must review it before transfer setup can continue.')
  }
  const engine = draft.response_engine
  if (
    typeof draft.version !== 'number' ||
    engine?.type !== 'retell-llm' ||
    !engine.llm_id ||
    typeof engine.version !== 'number'
  ) {
    throw new Error('Call transfer setup requires a versioned Retell LLM agent.')
  }
  const llmId = encodeURIComponent(engine.llm_id)
  const llmPath = '/get-retell-llm/' + llmId + '?version=' + engine.version
  const llm = await retellRequest<RetellLlmResponse>(apiKey, llmPath)
  const nextTools = updateHumanTransferTools(llm.general_tools ?? [], destination)
  const nextPrompt = updateHumanTransferPrompt(llm.general_prompt ?? '', Boolean(destination))
  await retellRequest<unknown>(
    apiKey,
    '/update-retell-llm/' + llmId + '?version=' + engine.version,
    'PATCH',
    { general_tools: nextTools, general_prompt: nextPrompt, default_dynamic_variables: {
      ...(llm.default_dynamic_variables ?? {}), recepta_transfer_allowed: 'disabled', recepta_transfer_destination: '',
    } }
  )
  await retellRequest<unknown>(apiKey, '/update-agent/' + encodedId + '?version=' + draft.version, 'PATCH', {
    webhook_url: eventWebhook,
    webhook_events: [...new Set(['call_started', 'call_ended', 'call_analyzed', ...(draft.webhook_events ?? []),
      'transfer_started', 'transfer_bridged', 'transfer_cancelled', 'transfer_ended'])],
  })
  await retellRequest<unknown>(
    apiKey, '/publish-agent-version/' + encodedId, 'POST',
    {
      version: draft.version,
      version_title: 'Recepta human call transfer',
      version_description: destination ? 'Enabled human transfer' : 'Disabled human transfer',
    }
  )
}

export const syncHumanCallTransfer = (options: Parameters<typeof syncHumanCallTransferImpl>[0]) =>
  withRetellAgentSync(options.agentId, () => syncHumanCallTransferImpl(options))
