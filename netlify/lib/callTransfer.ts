const RETELL_API_BASE = 'https://api.retellai.com'
const MANAGED_TOOL = 'recepta_transfer_to_human'
const MANAGED_PROMPT = '[RECEPTA MANAGED HUMAN TRANSFER]'

export const normalizeTransferNumber = (value: unknown): string | null => {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const digits = String(value).replace(/[^\d]/g, '')
  const number = digits.length === 10 ? '1' + digits : digits
  // Restrict the first release to NANP phone numbers. Other countries require
  // separate carrier, tariff, and anti-fraud validation.
  if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(number)) {
    throw new Error('Enter a valid US or Canadian number including its area code.')
  }
  if (number.slice(1, 4) === '900' || number.slice(4, 7) === '976') {
    throw new Error('Premium-rate transfer destinations are not supported.')
  }
  return '+' + number
}

export const buildHumanTransferTool = (number: string): Record<string, unknown> => ({
  type: 'transfer_call',
  name: MANAGED_TOOL,
  description:
    'Transfer to an authorized human worker only if the caller explicitly requests a person, ' +
    'the situation is urgent, or the request cannot be resolved by the AI. ' +
    'Confirm with the caller before transferring. Do not transfer calls by default.',
  transfer_destination: { type: 'predefined', number },
  transfer_option: {
    type: 'warm_transfer',
    on_hold_music: 'ringtone',
    transfer_ring_duration_ms: 25000,
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
  if (destination && existing.some((tool) => tool.type === 'transfer_call')) {
    throw new Error('This agent already has a different Transfer Call tool. Review it in Retell before enabling Recepta transfer.')
  }
  return destination ? [...existing, buildHumanTransferTool(destination)] : existing
}

const humanTransferInstructions = [
  'Only transfer when the caller asks for a human, has an urgent concern, or cannot be helped by the AI.',
  'Confirm the caller wants a transfer and briefly tell them you are connecting them.',
  'Use recepta_transfer_to_human only for an authorized human handoff. Never invent or ask the caller for a destination number.',
  'If the transfer fails or the worker does not answer, apologize, collect the caller name, callback number, and reason, and tell them the business will follow up. Never claim the worker answered.',
].join('\n')

export const updateHumanTransferPrompt = (prompt: string, enabled: boolean) => {
  const start = prompt.indexOf(MANAGED_PROMPT)
  const next = start < 0 ? -1 : prompt.indexOf('\n\n[RECEPTA MANAGED ', start + MANAGED_PROMPT.length)
  const without = start < 0 ? prompt.trim() :
    (prompt.slice(0, start) + (next < 0 ? '' : prompt.slice(next))).trim()
  return enabled ? [without, MANAGED_PROMPT + '\n' + humanTransferInstructions].filter(Boolean).join('\n\n') : without
}

type RetellAgentResponse = {
  version?: number
  response_engine?: { type?: string; llm_id?: string; version?: number }
}
type RetellLlmResponse = {
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
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    throw new Error('Retell rejected the transfer configuration (HTTP ' + response.status + ').')
  }
  return await response.json() as T
}

export const syncHumanCallTransfer = async (options: {
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
    { general_tools: nextTools, general_prompt: nextPrompt }
  )
  await retellRequest<unknown>(
    apiKey, '/publish-agent-version/' + encodedId, 'POST',
    {
      version: draft.version,
      version_title: 'Recepta human call transfer',
      version_description: destination ? 'Enabled human transfer' : 'Disabled human transfer',
    }
  )
}
