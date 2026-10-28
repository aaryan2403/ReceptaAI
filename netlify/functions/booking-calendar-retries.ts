import { createClient } from '@supabase/supabase-js'
import { deliverGoogleBookingJobs } from '../lib/googleCalendar'
export const config={schedule:'*/5 * * * *'}
export default async () => {
  if (!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY) throw new Error('Booking retry configuration is missing.')
  const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
  await deliverGoogleBookingJobs(db)
  return new Response(null,{status:204})
}
