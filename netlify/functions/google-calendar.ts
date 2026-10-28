import { randomBytes } from 'node:crypto'
import { requestAuth, json } from '../lib/requestAuth'
import { BookingError, checked, loadBookingAccount } from '../lib/bookings'
import { decryptGoogleToken, deliverGoogleBookingJobs, googleReady, googleRedirectUri, hashGoogleState, listGoogleCalendars, loadGoogleConnection, syncGoogleAvailability } from '../lib/googleCalendar'

export default async (request: Request) => {
  if (!['GET','POST'].includes(request.method)) return json(405,{error:'Method not allowed.'})
  try {
    const auth=await requestAuth(request)
    if (auth.response) return auth.response
    const {db,user}=auth
    await loadBookingAccount(db,user.id,request.method==='POST')
    const connection=await loadGoogleConnection(db,user.id)
    if (request.method==='GET') return json(200,{calendars:connection?await listGoogleCalendars(connection):[]})
    const body=await request.json() as Record<string,unknown>
    if (body.action==='connect') {
      if (!googleReady()) throw new BookingError('Google Calendar setup is required. Contact Recepta to enable the connection.',503)
      const state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url')
      checked(await db.from('google_calendar_oauth_states').delete().lt('expires_at',new Date().toISOString()))
      checked(await db.from('google_calendar_oauth_states').insert({state_hash:hashGoogleState(state),browser_hash:hashGoogleState(browser),client_id:user.id,expires_at:new Date(Date.now()+600000).toISOString()}))
      const query=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID!,redirect_uri:googleRedirectUri(),response_type:'code',access_type:'offline',prompt:'consent',state,
        scope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events'})
      const response=json(200,{url:`https://accounts.google.com/o/oauth2/v2/auth?${query}`})
      response.headers.set('Set-Cookie',`recepta_google_oauth=${browser}; HttpOnly; Secure; SameSite=Lax; Path=/.netlify/functions/google-calendar-callback; Max-Age=600`)
      return response
    }
    if (!connection) throw new BookingError('Connect Google Calendar first.',409)
    if (body.action==='disconnect') {
      // Revoke before erasing the local credential; failures remain recoverable.
      const response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:decryptGoogleToken(connection.encrypted_refresh_token)}),signal:AbortSignal.timeout(7000)})
      if (!response.ok && response.status!==400) throw new BookingError('Google could not confirm disconnection. Please try again.',503)
      checked(await db.rpc('disconnect_recepta_calendar',{p_client_id:user.id}))
      return json(200,{success:true})
    }
    if (body.action==='select') {
      if (!Array.isArray(body.calendar_ids)||body.calendar_ids.length<1||body.calendar_ids.length>5||typeof body.write_calendar_id!=='string') throw new BookingError('Select 1–5 calendars and a calendar for new bookings.')
      const available=await listGoogleCalendars(connection)
      const calendars=available.filter(c=>(body.calendar_ids as unknown[]).includes(c.id))
      if (calendars.length!==new Set(body.calendar_ids).size) throw new BookingError('One of those calendars is unavailable.')
      const writer=calendars.find(c=>c.id===body.write_calendar_id&&['writer','owner'].includes(c.accessRole))
      if (!writer) throw new BookingError('Choose a selected calendar you have permission to edit.')
      if (connection.write_calendar_id && connection.write_calendar_id!==writer.id) {
        const existing=checked(await db.from('appointments').select('id').eq('client_id',user.id).eq('status','booked').eq('google_calendar_id',connection.write_calendar_id).gte('appointment_time',new Date().toISOString()).limit(1))
        if (existing?.length) throw new BookingError('Keep the current destination calendar while it contains upcoming Recepta bookings.')
      }
      checked(await db.from('google_calendar_connections').update({selected_calendars:calendars,write_calendar_id:writer.id,synced_at:null,sync_error:null,updated_at:new Date().toISOString()}).eq('client_id',user.id))
    } else if (body.action!=='refresh') throw new BookingError('Unknown Google Calendar action.')
    await deliverGoogleBookingJobs(db,user.id)
    await syncGoogleAvailability(db,user.id)
    return json(200,{success:true})
  } catch(error) { return json(error instanceof BookingError?error.status:500,{error:error instanceof BookingError?error.message:'Google Calendar could not be updated. Please try again.'}) }
}
