import { createClient } from '@supabase/supabase-js'
import { configureEmailDelivery } from '../lib/emailDelivery'

export const config={ schedule:'*/15 * * * *' }
export default async () => {
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Email delivery setup configuration is missing.')
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  try {
    await configureEmailDelivery(db)
    const saved=await db.from('integration_settings').upsert({ key:'resend_setup_status',value:{ ready:true },updated_at:new Date().toISOString() },{ onConflict:'key' })
    if (saved.error) throw saved.error
  } catch(error) {
    const saved=await db.from('integration_settings').upsert({ key:'resend_setup_status',value:{ ready:false,error:error instanceof Error ? error.message : 'Email delivery setup failed.' },updated_at:new Date().toISOString() },{ onConflict:'key' })
    if (saved.error) throw saved.error
  }
  return new Response(null,{ status:204 })
}
