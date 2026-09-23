import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

const RETELL_API_BASE = 'https://api.retellai.com'

const ALL_RETELL_PII_CATEGORIES = [
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
] as const

const ALL_RETELL_GUARDRAIL_OUTPUT_TOPICS = [
  'harassment',
  'self_harm',
  'sexual_exploitation',
  'violence',
  'defense_and_national_security',
  'illicit_and_harmful_activity',
  'gambling',
  'regulated_professional_advice',
  'child_safety_and_exploitation',
] as const

const ALL_RETELL_GUARDRAIL_INPUT_TOPICS = [
  'platform_integrity_jailbreaking',
] as const

const buildRetellProtectionConfig = ({
  piiRedactionEnabled,
  safetyGuardrailsEnabled,
}: Pick<
  RetellSyncOptions,
  'piiRedactionEnabled' | 'safetyGuardrailsEnabled'
>) => ({
  data_storage_setting: piiRedactionEnabled
    ? 'everything_except_pii'
    : 'everything',
  pii_config: {
    mode: 'post_call',
    categories: piiRedactionEnabled
      ? [...ALL_RETELL_PII_CATEGORIES]
      : [],
  },
  guardrail_config: {
    output_topics: safetyGuardrailsEnabled
      ? [...ALL_RETELL_GUARDRAIL_OUTPUT_TOPICS]
      : [],
    input_topics: safetyGuardrailsEnabled
      ? [...ALL_RETELL_GUARDRAIL_INPUT_TOPICS]
      : [],
  },
})

type RetellVersion = {
  version: number
  is_published: boolean
}

type RetellVersionList = {
  items?: RetellVersion[]
}

type RetellAgent = {
  version?: number
  response_engine?: {
    type?: string
    llm_id?: string
    version?: number
  }
}

type RetellLlm = {
  default_dynamic_variables?: Record<string, string> | null
  general_prompt?: string | null
  general_tools?: Array<Record<string, unknown>> | null
}

export type RetellOperatingDay = {
  day: string
  open: boolean
  start: string
  end: string
}

export type RetellSchedule = {
  mode: '24/7' | 'custom'
  timeZone: string
  hours: RetellOperatingDay[]
}

type RetellSyncOptions = {
  apiKey: string
  agentId: string
  phoneNumber?: string | null
  phoneNumbers?: string[] | null
  active: boolean
  piiRedactionEnabled: boolean
  safetyGuardrailsEnabled: boolean
  aiModelId?: string | null
}

const RETELL_MODEL_BY_RECEPTA_ID = {
  'gpt-4-1': 'gpt-4.1',
  'gpt-5-6-luna': 'gpt-5.6-luna',
  'gpt-5-6-terra': 'gpt-5.6-terra',
  'claude-5-sonnet': 'claude-5-sonnet',
} as const

export const getRetellModel = (
  aiModelId: string
) => {
  const retellModel =
    RETELL_MODEL_BY_RECEPTA_ID[
      aiModelId as keyof typeof RETELL_MODEL_BY_RECEPTA_ID
    ]

  if (!retellModel) {
    throw new Error(
      `AI model ${aiModelId} is not mapped to a Retell model.`
    )
  }

  return retellModel
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

export const assertRetellAgentAvailable = async ({
  apiKey,
  agentId,
}: {
  apiKey: string
  agentId: string
}) => {
  try {
    const versions =
      await retellRequest<RetellVersionList>(
        apiKey,
        `/list-agent-versions/${encodeURIComponent(
          agentId
        )}?limit=1&sort_order=descending`
      )

    if (
      !Array.isArray(versions.items) ||
      versions.items.length === 0
    ) {
      throw new Error(
        'The Retell agent has no version to sync.'
      )
    }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : 'Retell agent verification failed.'

    if (
      /not found|status 404|does not exist/i.test(
        detail
      )
    ) {
      throw new Error(
        'Retell could not find this Agent ID in the workspace connected to Recepta. Copy the full Agent ID from Retell and make sure RETELL_API_KEY belongs to the same Retell workspace.'
      )
    }

    throw new Error(
      `Could not verify the Retell agent: ${detail}`
    )
  }
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
  aiModelId,
}: Omit<
  RetellSyncOptions,
  'active' | 'phoneNumber' | 'phoneNumbers'
>) => {
  const retellModel = aiModelId
    ? getRetellModel(aiModelId)
    : null

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

  const draftAgent =
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

  if (retellModel) {
    const responseEngine =
      draftAgent.response_engine

    if (
      responseEngine?.type !== 'retell-llm' ||
      !responseEngine.llm_id ||
      typeof responseEngine.version !== 'number'
    ) {
      throw new Error(
        'The assigned Retell agent does not use a versioned Retell LLM response engine.'
      )
    }

    await retellRequest<unknown>(
      apiKey,
      `/update-retell-llm/${encodeURIComponent(
        responseEngine.llm_id
      )}?version=${responseEngine.version}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          model: retellModel,
        }),
      }
    )
  }

  if (typeof draftAgent.version !== 'number') {
    throw new Error(
      'Retell did not return the draft agent version.'
    )
  }

  const updatedAgent =
    await retellRequest<RetellAgent>(
      apiKey,
      `/update-agent/${encodeURIComponent(
        agentId
      )}?version=${draftAgent.version}`,
      {
        method: 'PATCH',
        body: JSON.stringify(
          buildRetellProtectionConfig({
            piiRedactionEnabled,
            safetyGuardrailsEnabled,
          })
        ),
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
          retellModel
            ? `Changed the Recepta AI model to ${retellModel} and applied paid add-ons.`
            : 'Automatically applied paid Recepta add-ons.',
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

const BUSINESS_HOURS_PROMPT_MARKER =
  '[RECEPTA MANAGED BUSINESS HOURS]'

const EMPLOYEE_SCHEDULE_PROMPT_MARKER =
  '[RECEPTA MANAGED EMPLOYEE AVAILABILITY]'

const APPOINTMENT_BOOKING_PROMPT_MARKER =
  '[RECEPTA MANAGED APPOINTMENT BOOKING]'

const APPOINTMENT_FIELDS_PROMPT_MARKER =
  '[RECEPTA MANAGED APPOINTMENT FIELDS]'

const EMAIL_CONFIRMATIONS_PROMPT_MARKER =
  '[RECEPTA MANAGED EMAIL CONFIRMATIONS]'

const RECEPTA_CALENDAR_TOOL_NAMES = new Set([
  'recepta_list_employees',
  'recepta_check_availability',
  'recepta_book_appointment',
])

const buildReceptaCalendarTools = (siteUrl: string) => {
  const url = `${siteUrl}/.netlify/functions/retell-calendar`

  return [
    {
      type: 'custom',
      name: 'recepta_list_employees',
      description:
        'List the active employees that callers may choose for an appointment. Call this when the caller asks who is available or does not know which employee to select.',
      url,
      method: 'POST',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      type: 'custom',
      name: 'recepta_check_availability',
      description:
        'Check live Recepta calendar availability for a requested date, duration, preferred time, and optional employee. Always call this before offering appointment times.',
      url,
      method: 'POST',
      parameters: {
        type: 'object',
        required: ['date', 'duration_minutes'],
        properties: {
          employee_name: {
            type: 'string',
            description:
              'The employee requested by the caller. Omit only when the caller has no employee preference.',
          },
          date: {
            type: 'string',
            description:
              'Requested local calendar date in YYYY-MM-DD format.',
          },
          preferred_time: {
            type: 'string',
            description:
              'Optional preferred local start time in 24-hour HH:MM format.',
          },
          duration_minutes: {
            type: 'integer',
            description:
              'Required appointment length in minutes, between 5 and 480.',
          },
        },
      },
    },
    {
      type: 'custom',
      name: 'recepta_book_appointment',
      description:
        'Create a confirmed appointment in the live Recepta employee calendar. Use only after checking availability, collecting the required caller details, and receiving the caller’s explicit confirmation.',
      url,
      method: 'POST',
      parameters: {
        type: 'object',
        required: [
          'employee_name',
          'date',
          'time',
          'duration_minutes',
          'customer_name',
        ],
        properties: {
          employee_name: {
            type: 'string',
            description: 'Full name of the selected employee.',
          },
          date: {
            type: 'string',
            description: 'Confirmed local date in YYYY-MM-DD format.',
          },
          time: {
            type: 'string',
            description:
              'Confirmed local start time in 24-hour HH:MM format.',
          },
          duration_minutes: {
            type: 'integer',
            description: 'Confirmed appointment duration in minutes.',
          },
          customer_name: {
            type: 'string',
            description: 'Caller’s full name, confirmed with the caller.',
          },
          customer_email: {
            type: 'string',
            description:
              'Caller’s email address when buyer email confirmations are enabled or the caller chooses to provide it. Read it back before booking.',
          },
          customer_phone: {
            type: 'string',
            description: 'Caller’s phone number when provided.',
          },
          customer_sms_consent: {
            type: 'boolean',
            description:
              'True only when buyer SMS confirmations are enabled and the caller explicitly agrees to receive this appointment confirmation by SMS.',
          },
          customer_company: {
            type: 'string',
            description: 'Caller’s company when applicable.',
          },
          service: {
            type: 'string',
            description: 'Reason or service requested for the appointment.',
          },
          notes: {
            type: 'string',
            description:
              'Short customer-approved details useful for the appointment.',
          },
        },
      },
    },
  ]
}

const LEGACY_MANAGED_PROMPT_LINES: Record<string, string[][]> = {
  [BUSINESS_HOURS_PROMPT_MARKER]: [
    [
      'The current store schedule mode is {{recepta_schedule_mode}}.',
      'The current store hours are supplied in {{recepta_business_hours}} and use {{recepta_business_timezone}}.',
      'Use these values when answering whether the business is open or describing store hours. Never invent hours.',
    ],
  ],
  [EMPLOYEE_SCHEDULE_PROMPT_MARKER]: [
    [
      'The current active employee schedule is supplied in {{recepta_employee_schedule}}.',
      'The business timezone is {{recepta_employee_schedule_timezone}}.',
      'Use this information when answering employee-availability questions.',
      'Do not expose private contact details, invent availability, or claim an appointment is booked unless an authorized booking tool confirms it.',
    ],
  ],
  [APPOINTMENT_FIELDS_PROMPT_MARKER]: [
    [
      'The additional appointment fields configured in the Recepta dashboard are supplied in {{recepta_appointment_fields}}.',
      'Collect those fields when they are relevant to the caller\'s booking and include the values in the booking notes.',
    ],
  ],
}

const appendManagedPrompt = (
  currentPrompt: string,
  marker: string,
  lines: string[]
) => {
  const managedBlock = [marker, ...lines].join('\n')

  if (!currentPrompt.includes(marker)) {
    return `${currentPrompt.trim()}\n\n${managedBlock}`.trim()
  }

  for (const legacyLines of LEGACY_MANAGED_PROMPT_LINES[marker] ?? []) {
    const legacyBlock = [marker, ...legacyLines].join('\n')

    if (currentPrompt.includes(legacyBlock)) {
      return currentPrompt.replace(legacyBlock, managedBlock)
    }
  }

  return currentPrompt
}

const replaceManagedPrompt = (
  currentPrompt: string,
  marker: string,
  lines: string[]
) => {
  const managedBlock = [marker, ...lines].join('\n')
  const markerIndex = currentPrompt.indexOf(marker)

  if (markerIndex === -1) {
    return `${currentPrompt.trim()}\n\n${managedBlock}`.trim()
  }

  const nextMarkerIndex = currentPrompt.indexOf(
    '\n\n[RECEPTA MANAGED ',
    markerIndex + marker.length
  )
  const before = currentPrompt.slice(0, markerIndex).trimEnd()
  const after =
    nextMarkerIndex === -1
      ? ''
      : currentPrompt.slice(nextMarkerIndex).trimStart()

  return [before, managedBlock, after].filter(Boolean).join('\n\n')
}

const formatBusinessHours = (schedule: RetellSchedule) => {
  if (schedule.mode === '24/7') {
    return `The business and AI receptionist are available 24 hours a day, 7 days a week. Timezone: ${schedule.timeZone}.`
  }

  const formatTime = (value: string) => {
    const match = /^(\d{2}):(\d{2})/.exec(value)

    if (!match) return value

    const hour = Number(match[1])
    const minute = match[2]
    const displayHour = hour % 12 || 12
    const period = hour < 12 ? 'a.m.' : 'p.m.'

    return `${displayHour}:${minute} ${period}`
  }

  const hours = schedule.hours.map((item) =>
    item.open
      ? `${item.day}: ${formatTime(item.start)} to ${formatTime(item.end)}`
      : `${item.day}: closed`
  )

  return [
    `Business timezone: ${schedule.timeZone}.`,
    'Current weekly store and AI receptionist hours:',
    ...hours.map((item) => `- ${item}`),
  ].join('\n')
}

export const normalizeAppointmentFields = (value: unknown) => {
  if (!Array.isArray(value)) return []

  const labels: string[] = []
  value.forEach((item) => {
    if (typeof item !== 'string') return
    const label = item.trim().slice(0, 60)
    if (
      label &&
      !labels.some((existing) => existing.toLowerCase() === label.toLowerCase())
    ) {
      labels.push(label)
    }
  })

  return labels.slice(0, 20)
}

export const normalizeEmailNotificationsEnabled = (value: unknown) =>
  value !== false

export const normalizeSmsNotificationsEnabled = (value: unknown) =>
  value === true

export const formatAppointmentFields = (fields: string[]) =>
  fields.length > 0
    ? fields.map((field) => `- ${field}`).join('\n')
    : 'No additional appointment fields are configured.'

export const syncRetellSchedule = async ({
  apiKey,
  agentId,
  schedule,
  employeeSchedule,
  employeeScheduleTimeZone,
  appointmentFields,
  emailNotificationsEnabled = true,
  smsNotificationsEnabled = false,
}: {
  apiKey: string
  agentId: string
  schedule: RetellSchedule
  employeeSchedule?: string
  employeeScheduleTimeZone?: string
  appointmentFields?: string[]
  emailNotificationsEnabled?: boolean
  smsNotificationsEnabled?: boolean
}) => {
  const versions =
    await retellRequest<RetellVersionList>(
      apiKey,
      `/list-agent-versions/${encodeURIComponent(
        agentId
      )}?limit=1000&sort_order=descending`
    )

  const versionRows = Array.isArray(versions.items)
    ? versions.items
    : []
  const baseVersion =
    versionRows.find((item) => item.is_published)?.version ??
    versionRows[0]?.version

  if (typeof baseVersion !== 'number') {
    throw new Error('Retell agent has no version to update.')
  }

  const draftAgent = await retellRequest<RetellAgent>(
    apiKey,
    `/create-agent-version/${encodeURIComponent(agentId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ base_version: baseVersion }),
    }
  )

  const responseEngine = draftAgent.response_engine

  if (
    responseEngine?.type !== 'retell-llm' ||
    !responseEngine.llm_id ||
    typeof responseEngine.version !== 'number'
  ) {
    throw new Error(
      'The assigned Retell agent does not use a versioned Retell LLM response engine.'
    )
  }

  if (typeof draftAgent.version !== 'number') {
    throw new Error('Retell did not return the draft agent version.')
  }

  const currentLlm = await retellRequest<RetellLlm>(
    apiKey,
    `/get-retell-llm/${encodeURIComponent(
      responseEngine.llm_id
    )}?version=${responseEngine.version}`
  )
  let generalPrompt = appendManagedPrompt(
    currentLlm.general_prompt ?? '',
    BUSINESS_HOURS_PROMPT_MARKER,
    [
      'The Recepta dashboard is the authoritative source for current store and call-answering hours.',
      'Schedule mode: {{recepta_schedule_mode}}.',
      'Current hours: {{recepta_business_hours}}',
      'Use the timezone in {{recepta_business_timezone}} when answering.',
      'If the mode is 24/7, clearly say the business and AI receptionist are available 24 hours a day, 7 days a week.',
      'If the mode is custom, answer with the exact saved day and time. Never invent or assume hours.',
    ]
  )

  if (employeeSchedule) {
    generalPrompt = appendManagedPrompt(
      generalPrompt,
      EMPLOYEE_SCHEDULE_PROMPT_MARKER,
      [
        'The Recepta dashboard is the authoritative source for active employee availability.',
        'Current active employee schedule: {{recepta_employee_schedule}}',
        'Employee hours use timezone {{recepta_employee_schedule_timezone}}.',
        'When asked when an employee such as Mark is available, answer with that employee\'s exact saved days and times.',
        'If the employee or hours are not configured, say so clearly instead of guessing.',
        'Do not expose private contact details, invent availability, or claim an appointment is booked unless an authorized booking tool confirms it.',
      ]
    )
  }

  generalPrompt = appendManagedPrompt(
    generalPrompt,
    APPOINTMENT_FIELDS_PROMPT_MARKER,
    [
      'The Recepta dashboard is the authoritative source for additional appointment fields.',
      'Configured fields: {{recepta_appointment_fields}}',
      'Collect each configured field when it is relevant to the caller\'s request and include the label and value in the booking notes.',
      'If no additional fields are configured, do not ask for invented fields.',
    ]
  )

  generalPrompt = replaceManagedPrompt(
    generalPrompt,
    EMAIL_CONFIRMATIONS_PROMPT_MARKER,
    [
      'The Recepta business customer always receives the plan-appropriate call notification email.',
      emailNotificationsEnabled
        ? 'Buyer appointment email confirmations are enabled. Collect and confirm the buyer’s email address before booking.'
        : 'Buyer appointment email confirmations are disabled. Do not require the buyer’s email address or promise a buyer email.',
      smsNotificationsEnabled
        ? 'Buyer appointment SMS is available. Ask the buyer whether they want a confirmation text and set customer_sms_consent to true only after explicit consent.'
        : 'Buyer appointment SMS is disabled. Do not promise or claim that a confirmation text will be sent.',
      'Tell the buyer that email or SMS was sent only when the booking tool reports that delivery as successful.',
    ]
  )

  const siteUrl = process.env.URL?.trim().replace(/\/$/, '')
  const existingTools = currentLlm.general_tools ?? []
  let generalTools = existingTools

  if (siteUrl) {
    generalPrompt = appendManagedPrompt(
      generalPrompt,
      APPOINTMENT_BOOKING_PROMPT_MARKER,
      [
        'For appointment requests, the live Recepta calendar tools are the only authoritative source for employees, availability, and completed bookings.',
        'Ask whether the caller wants a particular employee. If not, use recepta_check_availability without an employee preference and offer the earliest suitable options.',
        'Always call recepta_check_availability before offering a time. Never invent availability from the weekly schedule alone.',
        'Before booking, collect and confirm the caller\'s full name, selected employee, date, time, duration, and reason for the appointment. Follow the managed email and SMS rules for optional buyer contact details.',
        'Call recepta_book_appointment only after the caller explicitly approves the final details.',
        'Never say an appointment is booked unless recepta_book_appointment returns success. If it fails, apologize and check availability again.',
      ]
    )
    generalTools = [
      ...existingTools.filter((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : ''
        return !RECEPTA_CALENDAR_TOOL_NAMES.has(name)
      }),
      ...buildReceptaCalendarTools(siteUrl),
    ]
  }

  await retellRequest<unknown>(
    apiKey,
    `/update-retell-llm/${encodeURIComponent(
      responseEngine.llm_id
    )}?version=${responseEngine.version}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        general_prompt: generalPrompt,
        general_tools: generalTools,
        default_dynamic_variables: {
          ...(currentLlm.default_dynamic_variables ?? {}),
          recepta_schedule_mode: schedule.mode,
          recepta_business_hours: formatBusinessHours(schedule),
          recepta_business_timezone: schedule.timeZone,
          recepta_email_confirmations: emailNotificationsEnabled
            ? 'enabled'
            : 'disabled',
          recepta_sms_confirmations: smsNotificationsEnabled
            ? 'enabled'
            : 'disabled',
          ...(employeeSchedule
            ? {
                recepta_employee_schedule: employeeSchedule,
                recepta_employee_schedule_timezone:
                  employeeScheduleTimeZone ?? schedule.timeZone,
              }
            : {}),
          ...(appointmentFields
            ? {
                recepta_appointment_fields:
                  formatAppointmentFields(appointmentFields),
              }
            : {}),
        },
      }),
    }
  )

  await retellRequest<unknown>(
    apiKey,
    `/publish-agent-version/${encodeURIComponent(agentId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        version: draftAgent.version,
        version_title: 'Recepta schedule sync',
        version_description:
          schedule.mode === '24/7'
            ? 'Set Recepta availability to 24/7.'
            : `Updated Recepta custom hours (${schedule.timeZone}).`,
      }),
    }
  )

  return {
    agentUpdated: true,
    version: draftAgent.version,
  }
}

export const syncRetellEmployeeSchedule = async ({
  apiKey,
  agentId,
  employeeSchedule,
  timeZone,
}: {
  apiKey: string
  agentId: string
  employeeSchedule: string
  timeZone: string
}) => {
  const versions = await retellRequest<RetellVersionList>(
    apiKey,
    `/list-agent-versions/${encodeURIComponent(
      agentId
    )}?limit=1000&sort_order=descending`
  )
  const versionRows = Array.isArray(versions.items)
    ? versions.items
    : []
  const baseVersion =
    versionRows.find((item) => item.is_published)?.version ??
    versionRows[0]?.version

  if (typeof baseVersion !== 'number') {
    throw new Error('Retell agent has no version to update.')
  }

  const draftAgent = await retellRequest<RetellAgent>(
    apiKey,
    `/create-agent-version/${encodeURIComponent(agentId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ base_version: baseVersion }),
    }
  )
  const responseEngine = draftAgent.response_engine

  if (
    responseEngine?.type !== 'retell-llm' ||
    !responseEngine.llm_id ||
    typeof responseEngine.version !== 'number'
  ) {
    throw new Error(
      'The assigned Retell agent does not use a versioned Retell LLM response engine.'
    )
  }

  if (typeof draftAgent.version !== 'number') {
    throw new Error('Retell did not return the draft agent version.')
  }

  const currentLlm = await retellRequest<RetellLlm>(
    apiKey,
    `/get-retell-llm/${encodeURIComponent(
      responseEngine.llm_id
    )}?version=${responseEngine.version}`
  )
  const currentPrompt = currentLlm.general_prompt ?? ''
  const generalPrompt = appendManagedPrompt(
    currentPrompt,
    EMPLOYEE_SCHEDULE_PROMPT_MARKER,
    [
      'The Recepta dashboard is the authoritative source for active employee availability.',
      'Current active employee schedule: {{recepta_employee_schedule}}',
      'Employee hours use timezone {{recepta_employee_schedule_timezone}}.',
      'When asked when an employee such as Mark is available, answer with that employee\'s exact saved days and times.',
      'If the employee or hours are not configured, say so clearly instead of guessing.',
      'Do not expose private contact details, invent availability, or claim an appointment is booked unless an authorized booking tool confirms it.',
    ]
  )

  await retellRequest<unknown>(
    apiKey,
    `/update-retell-llm/${encodeURIComponent(
      responseEngine.llm_id
    )}?version=${responseEngine.version}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        general_prompt: generalPrompt,
        default_dynamic_variables: {
          ...(currentLlm.default_dynamic_variables ?? {}),
          recepta_employee_schedule: employeeSchedule,
          recepta_employee_schedule_timezone: timeZone,
        },
      }),
    }
  )

  await retellRequest<unknown>(
    apiKey,
    `/publish-agent-version/${encodeURIComponent(agentId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        version: draftAgent.version,
        version_title: 'Recepta employee schedule sync',
        version_description:
          'Updated active employee availability from the Recepta dashboard.',
      }),
    }
  )

  return {
    agentUpdated: true,
    version: draftAgent.version,
  }
}

export const syncRetellPhoneBinding = async (
  options: Pick<
    RetellSyncOptions,
    'apiKey' | 'agentId' | 'phoneNumber' | 'active'
  >
) => updatePhoneBinding(options)

export const syncRetellPhoneBindings = async ({
  apiKey,
  agentId,
  phoneNumbers,
  active,
}: {
  apiKey: string
  agentId: string
  phoneNumbers: string[]
  active: boolean
}) => {
  const normalizedNumbers = Array.from(
    new Set(
      phoneNumbers
        .map((phoneNumber) => normalizeE164(phoneNumber))
        .filter((phoneNumber): phoneNumber is string => Boolean(phoneNumber))
    )
  )
  const results: Array<{
    phoneNumber: string
    updated: boolean
  }> = []

  for (const phoneNumber of normalizedNumbers) {
    const updated = await updatePhoneBinding({
      apiKey,
      agentId,
      phoneNumber,
      active,
    })

    results.push({ phoneNumber, updated })
  }

  return results
}

export const purchaseRetellPhoneNumber = async ({
  apiKey,
  agentId,
  countryCode,
  areaCode,
  nickname,
}: {
  apiKey: string
  agentId: string
  countryCode: 'CA' | 'US'
  areaCode?: number | null
  nickname: string
}) => {
  const siteUrl = process.env.URL?.trim().replace(/\/$/, '')
  const inboundWebhookUrl = siteUrl
    ? `${siteUrl}/.netlify/functions/retell-inbound`
    : null
  const agents = [
    {
      agent_id: agentId,
      agent_version: 'latest_published',
      weight: 1,
    },
  ]
  const purchased = await retellRequest<{
    phone_number?: string
  }>(apiKey, '/create-phone-number', {
    method: 'POST',
    body: JSON.stringify({
      inbound_agents: agents,
      outbound_agents: agents,
      country_code: countryCode,
      number_provider: 'twilio',
      toll_free: false,
      nickname,
      ...(countryCode === 'US' && areaCode
        ? { area_code: areaCode }
        : {}),
      ...(inboundWebhookUrl
        ? { inbound_webhook_url: inboundWebhookUrl }
        : {}),
    }),
  })
  const phoneNumber = normalizeE164(purchased.phone_number)

  if (!phoneNumber) {
    throw new Error('Retell did not return a valid purchased phone number.')
  }

  return phoneNumber
}

export const releaseRetellPhoneNumber = async ({
  apiKey,
  phoneNumber,
}: {
  apiKey: string
  phoneNumber: string
}) => {
  const normalizedPhone = normalizeE164(phoneNumber)

  if (!normalizedPhone) return false

  await retellRequest<unknown>(
    apiKey,
    `/delete-phone-number/${encodeURIComponent(normalizedPhone)}`,
    { method: 'DELETE' }
  )

  return true
}

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
      aiModelId: options.aiModelId,
    })
  }

  const phoneNumbers =
    options.phoneNumbers && options.phoneNumbers.length > 0
      ? options.phoneNumbers
      : options.phoneNumber
        ? [options.phoneNumber]
        : []
  const phoneBindingResults = await syncRetellPhoneBindings({
    apiKey: options.apiKey,
    agentId: options.agentId,
    phoneNumbers,
    active: options.active,
  })

  return {
    agentUpdated: options.active,
    phoneBindingUpdated: phoneBindingResults.some(
      (result) => result.updated
    ),
    phoneBindingResults,
  }
}
