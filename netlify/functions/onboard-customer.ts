import { createClient } from '@supabase/supabase-js'
import { json } from '../lib/requestAuth'
import { phoneFeatureEnabled } from '../lib/phoneSetup'

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const token = request.headers.get('authorization')
  if (!token?.startsWith('Bearer ')) return json(401, { error: 'Please sign in.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, ADMIN_EMAIL } = process.env
  if (!phoneFeatureEnabled() || !SUPABASE_URL || !SUPABASE_SECRET_KEY || !ADMIN_EMAIL) {
    return json(503, { error: 'Self-service signup is currently unavailable.' })
  }
  try {
    const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error } = await db.auth.getUser(token.slice(7))
    if (error || !user?.email || !user.email_confirmed_at) return json(403, { error: 'Confirm your email before setting up Recepta.' })
    if (user.email.toLowerCase() === ADMIN_EMAIL.trim().toLowerCase()) return json(403, { error: 'Use a customer email for self-service signup.' })
    const { recepta_self_service, company_name, requested_plan } = user.user_metadata
    if (recepta_self_service !== true || typeof company_name !== 'string' || company_name.trim().length < 2 ||
      company_name.length > 120 || !['Recepta Standard', 'Recepta Pro'].includes(requested_plan)) {
      return json(400, { error: 'Complete the customer signup form first.' })
    }
    const initialized = await db.rpc('initialize_recepta_customer', {
      p_client_id: user.id, p_email: user.email, p_company: company_name, p_plan: requested_plan,
    })
    if (initialized.error) return json(503, { error: 'Your account setup could not finish. Sign in again to retry.' })
    return json(200, { created: initialized.data === true })
  } catch {
    return json(503, { error: 'Your account setup could not finish. Sign in again to retry.' })
  }
}
