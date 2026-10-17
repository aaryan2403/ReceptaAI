import { createClient } from '@supabase/supabase-js'

export const config={ schedule:'17 * * * *' }
export default async () => {
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Retention job configuration is missing.')
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  const result=await db.rpc('queue_recepta_retention')
  if (result.error) throw result.error
  return new Response(null,{ status:204 })
}
