import { createClient } from '@supabase/supabase-js'
import { deliverCallNotices } from '../lib/callNotifications'

export const config = { schedule: '*/5 * * * *' }

export default async () => {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Call notification retry configuration is missing.')
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  await deliverCallNotices(db)
  return new Response(null, { status: 204 })
}
