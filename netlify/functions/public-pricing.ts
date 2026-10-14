import { createClient } from '@supabase/supabase-js'
import { EXTRA_PHONE_NUMBER_MONTHLY_CAD, PII_REDACTION_PER_MINUTE_CAD, SAFETY_GUARDRAILS_PER_MINUTE_CAD } from '../lib/pricing'

export default async (request: Request) => {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return new Response(null, { status: 503 })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.from('ai_models').select('id, display_name, tier_name, customer_price_per_minute_cad').eq('is_active', true).order('sort_order', { ascending: true })
  if (error) return new Response(null, { status: 503 })
  return new Response(JSON.stringify({
    models: (data ?? []).filter(model => Number.isFinite(Number(model.customer_price_per_minute_cad)) && model.customer_price_per_minute_cad !== null && Number(model.customer_price_per_minute_cad) >= 0),
    piiRate: PII_REDACTION_PER_MINUTE_CAD, guardrailRate: SAFETY_GUARDRAILS_PER_MINUTE_CAD, extraNumberRate: EXTRA_PHONE_NUMBER_MONTHLY_CAD,
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
}
