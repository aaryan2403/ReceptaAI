import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { billingOrigin } from './billingNotifications'
import { localBookingTime } from '../../src/lib/bookingTime'
import { BookingError, checked } from './bookings'

export const googleReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && tokenKey(false))
const tokenKey = (required = true) => {
  const key = Buffer.from(process.env.GOOGLE_CALENDAR_TOKEN_KEY ?? '', 'base64')
  if (key.length === 32) return key
  if (required) throw new Error('Google Calendar token encryption is not configured.')
  return null
}
export const encryptGoogleToken = (token: string) => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', tokenKey()!, iv)
  return Buffer.concat([iv, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}
export const decryptGoogleToken = (value: string) => {
  const data = Buffer.from(value, 'base64')
  const cipher = createDecipheriv('aes-256-gcm', tokenKey()!, data.subarray(0,12))
  cipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([cipher.update(data.subarray(12,-16)), cipher.final()]).toString('utf8')
}
export const hashGoogleState = (value: string) => createHash('sha256').update(value).digest('hex')
export const googleRedirectUri = () => `${billingOrigin()}/.netlify/functions/google-calendar-callback`
const apiRequest = async (url: string, init: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(7000) })
  return response
}
export const googleTokenExchange = async (fields: Record<string,string>) => {
  const response = await apiRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '', ...fields }) })
  if (!response.ok) throw new BookingError('Google authorization expired or was rejected. Reconnect Google Calendar.', 409)
  return await response.json() as { access_token: string; refresh_token?: string; scope?: string }
}
export type SelectedCalendar = { id: string; summary: string; timeZone?: string; accessRole: string }
export type GoogleConnection = { client_id: string; encrypted_refresh_token: string; selected_calendars: SelectedCalendar[]; write_calendar_id: string | null; synced_at: string | null; sync_error: string | null; updated_at:string }
export const loadGoogleConnection = async (db: SupabaseClient, clientId: string) => checked(await db.from('google_calendar_connections').select('*').eq('client_id', clientId).maybeSingle()) as GoogleConnection | null
const accessToken = async (connection: GoogleConnection) => (await googleTokenExchange({ grant_type: 'refresh_token', refresh_token: decryptGoogleToken(connection.encrypted_refresh_token) })).access_token
const googleFetch = async (token: string, path: string, init: RequestInit = {}) => apiRequest(`https://www.googleapis.com/calendar/v3${path}`, {
  ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
})
export const listGoogleCalendars = async (connection: GoogleConnection) => {
  const token = await accessToken(connection)
  const calendars: SelectedCalendar[] = []
  let page = ''
  do {
    const response = await googleFetch(token, '/users/me/calendarList?maxResults=250' + (page ? `&pageToken=${encodeURIComponent(page)}` : ''))
    if (!response.ok) throw new BookingError('Could not read your Google calendars. Reconnect or check permissions.', 409)
    const data = await response.json() as { items?: SelectedCalendar[]; nextPageToken?: string }
    calendars.push(...(data.items ?? []).filter(c => ['reader','writer','owner'].includes(c.accessRole)))
    page = data.nextPageToken ?? ''
    if (calendars.length > 1000) throw new BookingError('This Google account has too many calendars. Use a dedicated business account.')
  } while (page)
  return calendars
}
type CalendarEvent = { id: string; iCalUID?:string; status?: string; transparency?: string; summary?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }
type SnapshotEvent = { calendar_id: string; event_id: string; starts_at?: string; ends_at?: string; title?: string; html_link?: string; cancelled: boolean; uid?:string }

export const syncGoogleAvailability = async (db: SupabaseClient, clientId: string) => {
  const connection = await loadGoogleConnection(db, clientId)
  if (!connection) return
  if (!connection.selected_calendars.length || !connection.write_calendar_id) throw new BookingError('Select the Google calendars to check and the calendar to save bookings to.', 409)
  try {
    const token = await accessToken(connection)
    const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 92 * 86400000).toISOString()
    const snapshots = await Promise.all([...connection.selected_calendars].sort((a,b)=>Number(b.id===connection.write_calendar_id)-Number(a.id===connection.write_calendar_id)).map(async calendar => {
      const events: SnapshotEvent[] = []
      let page = '', pages = 0
      do {
        const query = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', timeMin: from, timeMax: to, maxResults: '2500' })
        if (page) query.set('pageToken', page)
        const response = await googleFetch(token, `/calendars/${encodeURIComponent(calendar.id)}/events?${query}`)
        if (!response.ok) throw new Error('Google calendar could not be read.')
        const data = await response.json() as { items?: CalendarEvent[]; nextPageToken?: string; timeZone?: string }
        for (const e of data.items ?? []) {
          if (e.status === 'cancelled') { events.push({ calendar_id: calendar.id, event_id: e.id, cancelled: true }); continue }
          if (e.transparency === 'transparent') continue
          const zone = calendar.timeZone ?? data.timeZone ?? 'America/Toronto'
          const start = e.start?.dateTime ?? (e.start?.date ? localBookingTime(`${e.start.date}T00:00`, zone) : null)
          const end = e.end?.dateTime ?? (e.end?.date ? localBookingTime(`${e.end.date}T00:00`, zone) : null)
          if (!start || !end || !Number.isFinite(Date.parse(start)) || Date.parse(end) <= Date.parse(start)) throw new Error('Google returned an incomplete busy event.')
          events.push({ calendar_id: calendar.id, event_id: e.id, starts_at: start, ends_at: end, title: e.summary?.slice(0,300) || 'Calendar appointment', html_link: e.htmlLink, cancelled: false,uid:e.iCalUID })
        }
        page = data.nextPageToken ?? ''
        if (++pages >= 10 && page) throw new Error('The calendar contains too many events to safely check.')
      } while (page)
      // Deleted managed events may be absent from a time-bounded list. Verify
      // those IDs individually before reflecting a cancellation locally.
      if (calendar.id === connection.write_calendar_id) {
        const appointments = checked(await db.from('appointments').select('id').eq('client_id', clientId).eq('google_calendar_id',calendar.id).eq('status','booked').gte('appointment_time',from).lt('appointment_time',to)) ?? []
        const jobs = checked(await db.from('booking_calendar_jobs').select('appointment_id').eq('client_id',clientId)) ?? []
        for (const a of appointments) {
          const eventId = `recepta${a.id.replaceAll('-','')}`
          if (events.some(e => e.event_id === eventId) || jobs.some(j => j.appointment_id === a.id)) continue
          // Appointments created before Google connection have no mirror yet.
          if (!connection.synced_at) continue
          const response = await googleFetch(token, `/calendars/${encodeURIComponent(calendar.id)}/events/${eventId}`)
          if (response.status === 404 || response.status === 410) { events.push({ calendar_id: calendar.id, event_id: eventId, cancelled: true }); continue }
          if (!response.ok) throw new Error('A Google booking could not be verified.')
          const event = await response.json() as CalendarEvent
          if (event.status === 'cancelled') events.push({ calendar_id: calendar.id, event_id: eventId, cancelled: true })
        }
      }
      return events
    }))
    const seen=new Set<string>()
    const events=snapshots.flat().filter(e=>{
      if(!e.uid||e.cancelled)return true
      const key=`${e.uid}:${e.starts_at}:${e.ends_at}`
      if(seen.has(key))return false
      seen.add(key);return true
    })
    checked(await db.rpc('sync_recepta_calendar_snapshot', { p_client_id: clientId, p_events: events, p_synced_at: new Date().toISOString(),p_connection_version:connection.updated_at }))
  } catch (error) {
    checked(await db.from('google_calendar_connections').update({ sync_error: 'Calendar refresh failed. New bookings are paused until Google Calendar can be checked.' }).eq('client_id',clientId))
    throw error instanceof BookingError ? error : new BookingError('Could not verify Google Calendar availability. No new booking was made. Please refresh or reconnect.', 503)
  }
}

export const deliverGoogleBookingJobs = async (db: SupabaseClient, clientId: string | null = null) => {
  const deadline=Date.now()+18000
  const jobs = checked(await db.rpc('claim_recepta_calendar_jobs', { p_client_id: clientId })) ?? []
  for (const job of jobs) {
    if(Date.now()>deadline){checked(await db.from('booking_calendar_jobs').update({lease_token:null,lease_expires_at:null}).eq('appointment_id',job.appointment_id).eq('lease_token',job.lease_token));continue}
    try {
      const lease=checked(await db.from('booking_calendar_jobs').update({lease_expires_at:new Date(Date.now()+90000).toISOString()}).eq('appointment_id',job.appointment_id).eq('lease_token',job.lease_token).gt('lease_expires_at',new Date().toISOString()).select('appointment_id').maybeSingle())
      if(!lease)continue
      const connection = await loadGoogleConnection(db, job.client_id)
      if (!connection) throw new Error('Google Calendar is disconnected.')
      const appointment = checked(await db.from('appointments').select('*').eq('id',job.appointment_id).eq('client_id',job.client_id).maybeSingle())
      if (!appointment) continue
      const token = await accessToken(connection)
      const eventId = `recepta${appointment.id.replaceAll('-','')}`
      const path = `/calendars/${encodeURIComponent(job.calendar_id)}/events`
      let response: Response
      if (appointment.status === 'cancelled') {
        response = await googleFetch(token, `${path}/${eventId}`, { method: 'DELETE' })
        if (![200,204,404,410].includes(response.status)) throw new Error('Calendar cancellation failed.')
      } else {
        // No attendees: buyer notifications remain controlled by the existing notification settings.
        const body = { id: eventId, summary: `${appointment.service || 'Appointment'} — ${appointment.customer_name}`, description: 'Managed by Recepta. Edit or cancel from your Recepta Bookings page.',
          start: { dateTime: appointment.appointment_time }, end: { dateTime: appointment.appointment_end_time },
          extendedProperties: { private: { recepta_booking_id: appointment.id } } }
        response = await googleFetch(token, `${path}/${eventId}`, { method: 'PUT', body: JSON.stringify(body) })
        if (response.status === 404) response = await googleFetch(token, path, { method: 'POST', body: JSON.stringify(body) })
        if (response.status === 409) response = await googleFetch(token, `${path}/${eventId}`, { method: 'PUT', body: JSON.stringify(body) })
        if (!response.ok) throw new Error('Calendar booking update failed.')
      }
      checked(await db.from('appointments').update({ google_calendar_id:job.calendar_id }).eq('id',job.appointment_id).eq('client_id',job.client_id))
      // A newer edit retains the job; leases prevent older writes overtaking newer writes.
      checked(await db.from('booking_calendar_jobs').delete().eq('appointment_id',job.appointment_id).eq('lease_token',job.lease_token).eq('version',job.version))
      checked(await db.from('booking_calendar_jobs').update({ lease_token:null,lease_expires_at:null }).eq('appointment_id',job.appointment_id).eq('lease_token',job.lease_token))
    } catch {
      checked(await db.from('booking_calendar_jobs').update({ last_error:'Google Calendar update failed; it will retry automatically.', retry_at:new Date(Date.now()+Math.min(60,2 ** Math.min(job.attempts,6))*60000).toISOString(),lease_token:null,lease_expires_at:null })
        .eq('appointment_id',job.appointment_id).eq('lease_token',job.lease_token))
    }
  }
}
