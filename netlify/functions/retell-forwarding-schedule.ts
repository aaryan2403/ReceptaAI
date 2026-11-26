import { createClient } from '@supabase/supabase-js'
import { reconcileRetellForwarding } from '../lib/retellForwarding'
import { serviceDeployment } from '../lib/serviceAccess'

export const config = { schedule: '* * * * *' }

export default async (request: Request) => {
  const deployment = serviceDeployment(request)
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !deployment.isolated) {
    throw new Error('Retell forwarding requires the matching Recepta database.')
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const result = await reconcileRetellForwarding(db, deployment)
  if (result.pending || result.unsafe) console.warn('Retell forwarding needs reconciliation:', result)
  return new Response(null, { status: 204 })
}
