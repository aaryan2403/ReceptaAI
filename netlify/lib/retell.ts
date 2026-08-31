import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

const RETELL_API_BASE = 'https://api.retellai.com'

const PII_CATEGORIES = [
  'person_name',
  'address',
  'email',
  'phone_number',
  'ssn',
  'passport',
  'driver_license',
  'credit_card',
  'bank_account',
  'password',
  'pin',
  'medical_id',
  'date_of_birth',
  'customer_account_number',
]

const GUARDRAIL_OUTPUT_TOPICS = [
  'harassment',
  'self_harm',
  'sexual_exploitation',
  'violence',
  'defense_and_national_security',
  'illicit_and_harmful_activity',
  'gambling',
  'regulated_professional_advice',
  'child_safety_and_exploitation',
]

const GUARDRAIL_INPUT_TOPICS = [
  'platform_integrity_jailbreaking',
]

type RetellVersion = {
  version: number
  is_published: boolean
}

type RetellVersionList = {
  items?: RetellVersion[]
}

type RetellAgent = {
  version?: number
}

type RetellSyncOptions = {
  apiKey: string
  agentId: string
  phoneNumber?: string | null
  active: boolean
  piiRedactionEnabled: boolean
  safetyGuardrailsEnabled: boolean
}

const retellRequest = async <T>(
  apiKey: string,
  path: string,
  init: RequestInit = {}
) => {
  const response = await fetch(
    `${RETELL_API_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body
          ? {
              'Content-Type':
                'application/json',
            }
          : {}),
        ...init.headers,
      },
    }
  )

  const text = await response.text()
  let body: unknown = null

  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!response.ok) {
    const message =
      body &&
      typeof body === 'object' &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : `Retell request failed with status ${response.status}.`

    throw new Error(message)
  }

  return body as T
}

export const normalizeE164 = (
  phoneNumber?: string | null
) => {
  if (!phoneNumber) return null

  const normalized =
    phoneNumber.trim().replace(/[^\d+]/g, '')

  return /^\+[1-9]\d{7,14}$/.test(normalized)
    ? normalized
    : null
}

export const verifyRetellSignature = (
  rawBody: string,
  signature: string | null,
  apiKey: string
) => {
  if (!signature) return false

  const match =
    /^v=(\d+),d=([a-fA-F0-9]+)$/.exec(
      signature.trim()
    )

  if (!match) return false

  const timestamp = Number(match[1])
  const suppliedDigest = match[2]

  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) >
      5 * 60 * 1000
  ) {
    return false
  }

  const expectedDigest = createHmac(
    'sha256',
    apiKey
  )
    .update(`${rawBody}${timestamp}`)
    .digest('hex')

  const expected = Buffer.from(
    expectedDigest,
    'hex'
  )
  const supplied = Buffer.from(
    suppliedDigest,
    'hex'
  )

  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  )
}

const updateAndPublishAgent = async ({
  apiKey,
  agentId,
  piiRedactionEnabled,
  safetyGuardrailsEnabled,
}: Omit<
  RetellSyncOptions,
  'active' | 'phoneNumber'
>) => {
  const versions =
    await retellRequest<RetellVersionList>(
      apiKey,
      `/list-agent-versions/${encodeURIComponent(
        agentId
      )}?limit=1000&sort_order=descending`
    )

  const versionRows =
    Array.isArray(versions.items)
      ? versions.items
      : []

  const baseVersion =
    versionRows.find(
      (item) => item.is_published
    )?.version ?? versionRows[0]?.version

  if (
    typeof baseVersion !== 'number'
  ) {
    throw new Error(
      'Retell agent has no version to update.'
    )
  }

  await retellRequest<RetellAgent>(
    apiKey,
    `/create-agent-version/${encodeURIComponent(
      agentId
    )}`,
    {
      method: 'POST',
      body: JSON.stringify({
        base_version: baseVersion,
      }),
    }
  )

  const updatedAgent =
    await retellRequest<RetellAgent>(
      apiKey,
      `/update-agent/${encodeURIComponent(
        agentId
      )}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          data_storage_setting:
            piiRedactionEnabled
              ? 'everything_except_pii'
              : 'everything',
          pii_config: {
            mode: 'post_call',
            categories:
              piiRedactionEnabled
                ? PII_CATEGORIES
                : [],
          },
          guardrail_config: {
            output_topics:
              safetyGuardrailsEnabled
                ? GUARDRAIL_OUTPUT_TOPICS
                : [],
            input_topics:
              safetyGuardrailsEnabled
                ? GUARDRAIL_INPUT_TOPICS
                : [],
          },
        }),
      }
    )

  if (
    typeof updatedAgent.version !== 'number'
  ) {
    throw new Error(
      'Retell did not return the updated agent version.'
    )
  }

  await retellRequest<unknown>(
    apiKey,
    `/publish-agent-version/${encodeURIComponent(
      agentId
    )}`,
    {
      method: 'POST',
      body: JSON.stringify({
        version: updatedAgent.version,
        version_title:
          'Recepta subscription sync',
        version_description:
          'Automatically applied paid Recepta add-ons.',
      }),
    }
  )
}

const updatePhoneBinding = async ({
  apiKey,
  agentId,
  phoneNumber,
  active,
}: Pick<
  RetellSyncOptions,
  'apiKey' | 'agentId' | 'phoneNumber' | 'active'
>) => {
  const normalizedPhone =
    normalizeE164(phoneNumber)

  if (!normalizedPhone) {
    return false
  }

  const encodedPhone =
    encodeURIComponent(normalizedPhone)

  const lookupResponse = await fetch(
    `${RETELL_API_BASE}/get-phone-number/${encodedPhone}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }
  )

  if (lookupResponse.status === 404) {
    return false
  }

  if (!lookupResponse.ok) {
    const body = await lookupResponse.text()

    throw new Error(
      body ||
        `Could not verify Retell phone number (${lookupResponse.status}).`
    )
  }

  const agents = active
    ? [
        {
          agent_id: agentId,
          agent_version:
            'latest_published',
          weight: 1,
        },
      ]
    : null

  const siteUrl =
    process.env.URL?.trim().replace(/\/$/, '')

  const inboundWebhookUrl = siteUrl
    ? `${siteUrl}/.netlify/functions/retell-inbound`
    : null

  await retellRequest<unknown>(
    apiKey,
    `/update-phone-number/${encodedPhone}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        inbound_agents: agents,
        outbound_agents: agents,
        ...(inboundWebhookUrl
          ? {
              inbound_webhook_url:
                inboundWebhookUrl,
            }
          : {}),
      }),
    }
  )

  return true
}

export const syncRetellPhoneBinding = async (
  options: Pick<
    RetellSyncOptions,
    'apiKey' | 'agentId' | 'phoneNumber' | 'active'
  >
) => updatePhoneBinding(options)

export const syncRetellSubscription = async (
  options: RetellSyncOptions
) => {
  if (options.active) {
    await updateAndPublishAgent({
      apiKey: options.apiKey,
      agentId: options.agentId,
      piiRedactionEnabled:
        options.piiRedactionEnabled,
      safetyGuardrailsEnabled:
        options.safetyGuardrailsEnabled,
    })
  }

  const phoneBindingUpdated =
    await updatePhoneBinding(options)

  return {
    agentUpdated: options.active,
    phoneBindingUpdated,
  }
}
