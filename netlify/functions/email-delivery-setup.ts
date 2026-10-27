import { createClient } from '@supabase/supabase-js'
import { configureEmailDelivery } from '../lib/emailDelivery'

export const config={ schedule:'*/15 * * * *' }
export default async () => {
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Email delivery setup configuration is missing.')
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  try {
    await configureEmailDelivery(db)
  } catch(error) {
    console.error('Email delivery setup needs attention:',error instanceof Error ? error.message : 'Setup failed.')
  }
  return new Response(null,{ status:204 })
}
