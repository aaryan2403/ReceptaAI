import { supabase } from './supabase'
export type Booking = { id:string; customer_name:string|null; customer_phone:string|null; customer_email:string|null; service:string|null; notes:string|null; appointment_time:string|null; appointment_end_time:string|null; duration_minutes:number|null; employee_id:string|null; status:string; source:string; booking_key:string|null; booking_version:number; requested_date:string|null; requested_time:string|null }
export type BookingSettings = { enabled:boolean; capacity:number; duration_minutes:number; buffer_minutes:number }
export type CalendarChoice = { id:string; summary:string; accessRole:string; timeZone?:string }
export type BookingWorkspace = { appointments:Booking[]; employees:Array<{id:string;name:string}>; external:Array<{calendar_id:string;event_id:string;starts_at:string;ends_at:string;title:string;local_appointment_id:string|null}>;calendarJobs:Array<{appointment_id:string;last_error:string|null}>;
  settings:BookingSettings;paid:boolean;timeZone:string;google:{configured:boolean;connected:boolean;selectedCalendars:CalendarChoice[];writeCalendarId:string|null;syncedAt:string|null;error:string|null} }
export const bookingRequest = async <T>(path='bookings',method='GET',body?:unknown):Promise<T> => {
  const controller=new AbortController()
  let timer:ReturnType<typeof setTimeout>|undefined
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('The request timed out. Refresh to check whether your booking was saved before trying again.'))},45000)})
  try {
    return await Promise.race([(async()=>{
      const {data:{session}}=await supabase.auth.getSession()
      if (controller.signal.aborted) throw new Error('Request timed out.')
      if (!session?.access_token) throw new Error('Please sign in again.')
      const response=await fetch(`/.netlify/functions/${path}`,{method,signal:controller.signal,headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
      const data=await response.json()
      if (!response.ok) throw new Error(data.error||'Could not update bookings.')
      return data as T
    })(),deadline])
  } finally {clearTimeout(timer)}
}
