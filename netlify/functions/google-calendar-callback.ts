import { createClient } from '@supabase/supabase-js'
import { billingOrigin } from '../lib/billingNotifications'
import { checked, loadBookingAccount } from '../lib/bookings'
import { encryptGoogleToken, googleRedirectUri, googleTokenExchange, hashGoogleState } from '../lib/googleCalendar'

export default async (request:Request) => {
  const target=new URL('/dashboard/bookings',billingOrigin())
  try {
    if (request.method!=='GET') throw new Error('Invalid callback.')
    const url=new URL(request.url),state=url.searchParams.get('state'),code=url.searchParams.get('code')
    const cookie=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('recepta_google_oauth='))?.split('=')[1]
    if (!state||!cookie) throw new Error('Authorization state is missing.')
    const db=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SECRET_KEY!,{auth:{persistSession:false,autoRefreshToken:false}})
    const row=checked(await db.from('google_calendar_oauth_states').delete().eq('state_hash',hashGoogleState(state)).eq('browser_hash',hashGoogleState(cookie)).gt('expires_at',new Date().toISOString()).select('client_id').maybeSingle())
    if (!row||!code||url.searchParams.has('error')) throw new Error('Authorization was cancelled or expired.')
    await loadBookingAccount(db,row.client_id,true)
    const client=checked(await db.from('clients').select('deletion_pending').eq('id',row.client_id).maybeSingle())
    if (!client||client.deletion_pending) throw new Error('Account unavailable.')
    const tokens=await googleTokenExchange({grant_type:'authorization_code',code,redirect_uri:googleRedirectUri()})
    const scopes=new Set(tokens.scope?.split(' ')??[])
    if (!tokens.refresh_token||!scopes.has('https://www.googleapis.com/auth/calendar.events')||!scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly')) throw new Error('Required calendar permissions were not granted.')
    checked(await db.from('google_calendar_connections').upsert({client_id:row.client_id,encrypted_refresh_token:encryptGoogleToken(tokens.refresh_token),sync_error:null,updated_at:new Date().toISOString()},{onConflict:'client_id'}))
    target.searchParams.set('google','connected')
  } catch { target.searchParams.set('google','failed') }
  return new Response(null,{status:303,headers:{Location:target.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':'recepta_google_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/.netlify/functions/google-calendar-callback; Max-Age=0'}})
}
