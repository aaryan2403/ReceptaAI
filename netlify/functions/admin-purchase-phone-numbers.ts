import { createClient } from '@supabase/supabase-js'
import { normalizePhonePurchase, MAX_TOTAL_PHONE_NUMBERS } from '../lib/phoneNumbers'
import { calculateMonthlyPriceCad } from '../lib/pricing'
import { saveSubscriptionConfiguration } from '../lib/subscriptionConfiguration'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

// Prepare a quote. The verified Checkout webhook purchases and assigns numbers
// only after payment, using the exact configuration that was purchased.
export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Unauthorized.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, ADMIN_EMAIL } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !ADMIN_EMAIL) return json(503, { error: 'Billing is not configured.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data: { user }, error } = await db.auth.getUser(auth.slice(7))
    if (error || !user || user.email?.trim().toLowerCase() !== ADMIN_EMAIL.trim().toLowerCase()) return json(403, { error: 'Admin access required.' })
    let body
    try { body = await request.json() } catch { return json(400, { error: 'Invalid request body.' }) }
    const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : ''
    if (!clientId) return json(400, { error: 'Client ID is required.' })
    const purchase = normalizePhonePurchase({ count: body.quantity, countryCode: body.countryCode, areaCode: body.areaCode })
    if (purchase.purchaseCount < 1) return json(400, { error: 'Choose at least one additional phone number.' })
    const [subscriptionResult, agentResult, phoneResult] = await Promise.all([
      db.from('subscriptions').select('*').eq('client_id', clientId).maybeSingle(),
      db.from('agents').select('retell_agent_id').eq('client_id', clientId).maybeSingle(),
      db.from('agent_phone_numbers').select('phone_number').eq('client_id', clientId),
    ])
    if (subscriptionResult.error || agentResult.error || phoneResult.error) throw new Error('Could not load the client configuration.')
    const subscription = subscriptionResult.data
    if (!subscription || !agentResult.data?.retell_agent_id) return json(409, { error: 'Configure the client subscription and Retell agent first.' })
    const configuration = { ...subscription, ...(subscription.pending_configuration ?? {}) }
    const totalNumbers = Math.max((phoneResult.data ?? []).length, Number(configuration.extra_phone_numbers ?? 0) + 1) + purchase.purchaseCount
    if (totalNumbers > MAX_TOTAL_PHONE_NUMBERS) return json(400, { error: `A client can have at most ${MAX_TOTAL_PHONE_NUMBERS} numbers.` })
    const { data: model, error: modelError } = await db.from('ai_models').select('customer_price_per_minute_cad').eq('id', configuration.ai_model_id).eq('is_active', true).maybeSingle()
    const rate = Number(model?.customer_price_per_minute_cad)
    if (modelError || !model || !Number.isFinite(rate) || rate < 0) throw new Error('The assigned model price is invalid.')
    const monthlyPrice = calculateMonthlyPriceCad({ planName: configuration.plan_name, monthlyMinutes: Number(configuration.monthly_minutes), modelPricePerMinuteCad: rate, piiRedactionEnabled: configuration.pii_redaction_enabled, safetyGuardrailsEnabled: configuration.safety_guardrails_enabled, extraPhoneNumbers: totalNumbers - 1 })
    await saveSubscriptionConfiguration(db, clientId, {
      plan_name: configuration.plan_name, monthly_price: monthlyPrice, monthly_minutes: Number(configuration.monthly_minutes), ai_model_id: configuration.ai_model_id,
      pii_redaction_enabled: configuration.pii_redaction_enabled, safety_guardrails_enabled: configuration.safety_guardrails_enabled,
      extra_phone_numbers: totalNumbers - 1, phone_number_country: purchase.countryCode,
      phone_number_area_code: purchase.areaCode === null ? null : String(purchase.areaCode),
    })
    return json(200, { success: true, paymentRequired: true, purchasedPhoneNumbers: [], phoneNumbers: (phoneResult.data ?? []).map(row => row.phone_number), monthlyPrice, totalNumbers })
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Could not prepare the phone-number quote.' })
  }
}
