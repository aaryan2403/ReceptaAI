import { createClient } from '@supabase/supabase-js'
import { processServiceJobs } from '../lib/serviceJobs'

// Fast fallback for queued deletion/provisioning and retries; claims are lease-protected.
export const config={ schedule:'* * * * *' }
export default async () => {
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Service job configuration is missing.')
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  await processServiceJobs(db)
  return new Response(null,{ status:204 })
}
