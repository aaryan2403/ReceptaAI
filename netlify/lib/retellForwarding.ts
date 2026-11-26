import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { isBusinessOpen } from './businessHours'
import { getStoredBusinessSchedule } from './employeeSchedule'
import { normalizeE164, receptaRetellOrigin, retellRequest } from './retell'
import { loadServiceAccess, type ServiceAccess, type serviceDeployment } from './serviceAccess'
import { normalizeHours, normalizeTimeZone } from './storeSchedule'

type Deployment = ReturnType<typeof serviceDeployment>
type Phone = {
  phone_number: string
  phone_number_type?: string
  inbound_webhook_url?: string | null
  inbound_agent_id?: string | null
  inbound_agents?: unknown[] | null
  fallback_number?: string | null
  inbound_fallback_enabled?: boolean
}
type Route = {
  client_id: string
  phone_number: string
  business_hours: string | null
  human_number: string | null
  unsafe_destination: boolean
}

const parseForwardingPhone = (value: unknown) =>
  typeof value === 'string' && value.length <= 40 && /^[+\d\s().-]+$/.test(value)
    ? parsePhoneNumberFromString(value, 'CA')
    : undefined

export const businessForwardingNumber = (value: unknown) => {
  const phone = parseForwardingPhone(value)
  return phone?.isPossible() ? phone.number : null
}

export const humanForwardingNumber = (value: unknown) => {
  const phone = parseForwardingPhone(value)
  const type = phone?.getType()
  if (!phone?.isValid() || !['US', 'CA'].includes(phone.country ?? '') ||
      !type || !['FIXED_LINE', 'MOBILE', 'FIXED_LINE_OR_MOBILE', 'VOIP'].includes(type) ||
      phone.nationalNumber.slice(3, 6) === '976') return null
  return phone.number
}

function outsideAiHours(hours: string | null, now: Date) {
  const schedule = getStoredBusinessSchedule(hours)
  if (schedule.mode !== 'custom' || schedule.answeringMode !== 'business_hours') return false
  try {
    normalizeTimeZone(schedule.timeZone)
    normalizeHours(schedule.hours)
    return !isBusinessOpen(schedule, now)
  } catch {
    return false
  }
}

const managedTypes = new Set(['retell-twilio', 'retell-telnyx', 'retell-bandwidth'])

async function inventory(key: string, signal: AbortSignal) {
  const numbers = new Map<string, Phone>()
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const query = new URLSearchParams({ limit: '250' })
    if (cursor) query.set('pagination_key', cursor)
    const page = await retellRequest<{ items?: Phone[]; has_more?: boolean; pagination_key?: string }>(
      key, '/v2/list-phone-numbers?' + query,
      { method: 'POST', body: '{}', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
    )
    if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean' ||
        (page.has_more && (!page.pagination_key || seen.has(page.pagination_key)))) {
      throw new Error('Retell did not return a complete phone inventory.')
    }
    for (const phone of page.items) {
      const number = normalizeE164(phone.phone_number)
      if (number) numbers.set(number, phone)
    }
    cursor = page.has_more ? page.pagination_key : undefined
    if (cursor) seen.add(cursor)
  } while (cursor)
  return numbers
}

const matches = (phone: Phone, destination: string | null) =>
  (phone.fallback_number ?? null) === destination &&
  (phone.inbound_fallback_enabled === true) === Boolean(destination)

async function setForwarding(key: string, listed: Phone, destination: string | null, webhook: string, signal: AbortSignal) {
  const number = encodeURIComponent(listed.phone_number)
  const read = () => retellRequest<Phone>(key, '/get-phone-number/' + number, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
  })
  const current = await read()
  const managed = (phone: Phone) => phone.phone_number === listed.phone_number &&
    phone.phone_number_type === listed.phone_number_type && phone.inbound_webhook_url === webhook
  if (!managed(current)) throw new Error('Retell phone ownership changed.')
  if (destination && (current.inbound_agent_id || current.inbound_agents?.length)) {
    throw new Error('A static inbound agent could bypass Recepta call admission.')
  }
  if (matches(current, destination)) return false

  try {
    await retellRequest(key, '/update-phone-number/' + number, {
      method: 'PATCH',
      body: JSON.stringify({ fallback_number: destination, inbound_fallback_enabled: Boolean(destination) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    })
  } catch {
    // A timed-out PATCH may already have applied. Verify instead of repeating it.
  }
  const verified = await read()
  if (!managed(verified) || !matches(verified, destination)) throw new Error('Retell did not confirm the forwarding update.')
  return true
}

export async function reconcileRetellForwarding(db: SupabaseClient, deployment: Deployment, clientId?: string, timeout = 23500) {
  const key = deployment.key
  if (!deployment.isolated || !key ||
      (deployment.preview && key === process.env.RETELL_API_KEY?.trim())) {
    throw new Error('The isolated Retell workspace is unavailable.')
  }
  const origin = deployment.previewOrigin ?? receptaRetellOrigin(false)
  const webhook = new URL('/.netlify/functions/retell-inbound', origin).toString()
  const token = randomUUID()
  const signal = AbortSignal.timeout(timeout)
  const { data: claimed, error: lockError } = await db.rpc('recepta_claim_retell_forwarding', { p_token: token }).abortSignal(signal)
  if (lockError) throw lockError
  if (claimed !== true) return { checked: 0, updated: 0, pending: 1, unsafe: 0 }
  try {
    const phones = await inventory(key, signal)
    const managed = [...phones.values()].filter(phone =>
      phone.inbound_webhook_url === webhook && managedTypes.has(phone.phone_number_type ?? ''))
    if (!managed.length) return { checked: 0, updated: 0, pending: 0, unsafe: 0 }

    const { data, error } = await db.rpc('recepta_retell_forwarding_routes', {
      p_numbers: managed.map(phone => phone.phone_number), p_client: clientId ?? null,
    }).abortSignal(signal)
    if (error || !Array.isArray(data)) throw new Error('Could not load Recepta phone assignments.')
    const routes = new Map((data as Route[]).map(route => [route.phone_number, route]))
    const access = new Map<string, Promise<ServiceAccess | null>>()
    // Clear routes first. This includes unassigned numbers that still carry this
    // deployment's inbound webhook, for example after a cancelled account is removed.
    const queue = managed.filter(phone => !clientId || routes.has(phone.phone_number)).sort((left, right) =>
      Number(Boolean(right.fallback_number || right.inbound_fallback_enabled)) -
      Number(Boolean(left.fallback_number || left.inbound_fallback_enabled)))
    const result = { checked: queue.length, updated: 0, pending: 0, unsafe: 0 }
    const checkNumber = async (phone: Phone) => {
      const route = routes.get(phone.phone_number)
      let destination: string | null = null
      if (route?.human_number && outsideAiHours(route.business_hours, new Date())) {
        const human = humanForwardingNumber(route.human_number)
        if (!human || route.unsafe_destination || phones.has(human) || phone.inbound_agent_id || phone.inbound_agents?.length) {
          result.unsafe++
        } else {
          if (!access.has(route.client_id)) {
            access.set(route.client_id, loadServiceAccess(db, route.client_id, signal).catch(() => null))
          }
          const service = await access.get(route.client_id)
          if (!service) result.pending++
          if (service?.status === 'active' && service.can_reserve && service.service_status !== 'paused') {
            if (outsideAiHours(route.business_hours, new Date())) destination = human
          }
        }
      }
      if (!matches(phone, destination) && await setForwarding(key, phone, destination, webhook, signal)) result.updated++
    }
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (!signal.aborted) {
        const phone = queue.shift()
        if (!phone) return
        try {
          await checkNumber(phone)
        } catch {
          result.pending++
        }
      }
    })
    await Promise.all(workers)
    result.pending += queue.length
    return result
  } finally {
    await db.from('retell_forwarding_lock').delete().eq('token', token).abortSignal(AbortSignal.timeout(1000))
  }
}

export async function refreshClientRetellForwarding(db: SupabaseClient, deployment: Deployment, clientId: string) {
  if (!deployment.key) return
  try {
    const destination = await db.from('phone_transfer_destinations').select('id').eq('client_id', clientId)
      .eq('is_primary', true).eq('enabled', true).maybeSingle()
    if (destination.error) throw destination.error
    if (!destination.data) return
    const result = await reconcileRetellForwarding(db, deployment, clientId, 7500)
    if (result.pending) console.warn('Retell forwarding will retry on the next scheduled run.')
  } catch {
    console.warn('Retell forwarding refresh could not complete. The scheduled run will retry.')
  }
}
