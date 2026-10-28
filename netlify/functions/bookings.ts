import { requestAuth, json } from '../lib/requestAuth'
import { BookingError, checked, loadBookingAccount, normalizeBooking, validateBookingTime } from '../lib/bookings'
import { deliverGoogleBookingJobs, googleReady, loadGoogleConnection, syncGoogleAvailability } from '../lib/googleCalendar'
import { loadClientScheduleContext } from '../lib/employeeSchedule'
import { normalizeAppointmentFields, normalizeEmailNotificationsEnabled, normalizeSmsNotificationsEnabled, syncRetellSchedule } from '../lib/retell'

export default async (request: Request) => {
  if (!['GET','POST','PATCH','DELETE'].includes(request.method)) return json(405,{error:'Method not allowed.'})
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    const { db, user } = auth
    const account = await loadBookingAccount(db,user.id,request.method === 'POST')
    if (request.method !== 'GET') {
      const body = await request.json() as Record<string,unknown>
      if (body.action === 'settings') {
        if (!account.paid) throw new BookingError('An active paid Recepta Pro plan is required.',403)
        if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.capacity) || Number(body.capacity)<1 || Number(body.capacity)>50 ||
          !Number.isInteger(body.duration_minutes) || Number(body.duration_minutes)<5 || Number(body.duration_minutes)>480 ||
          !Number.isInteger(body.buffer_minutes) || Number(body.buffer_minutes)<0 || Number(body.buffer_minutes)>120) throw new BookingError('Choose valid booking limits, duration and buffer.')
        if (body.enabled) {
          if (account.schedule.mode === 'unconfigured') throw new BookingError('Save your business hours on the Agent page before enabling bookings.')
          if (!account.agent?.retell_agent_id || !process.env.RETELL_API_KEY) throw new BookingError('Your AI agent must be assigned before enabling bookings.',409)
          const context = await loadClientScheduleContext({supabase:db,clientId:user.id,businessHours:account.agent.business_hours})
          await syncRetellSchedule({apiKey:process.env.RETELL_API_KEY,agentId:account.agent.retell_agent_id,
            ...context,liveBookingTools:true,appointmentFields:normalizeAppointmentFields(user.user_metadata?.appointment_custom_fields),
            emailNotificationsEnabled:normalizeEmailNotificationsEnabled(user.user_metadata?.appointment_email_notifications_enabled),
            smsNotificationsEnabled:normalizeSmsNotificationsEnabled(user.user_metadata?.appointment_sms_notifications_enabled)})
        }
        checked(await db.rpc('update_recepta_booking_settings',{p_client_id:user.id,p_enabled:body.enabled,p_capacity:body.capacity,p_duration:body.duration_minutes,p_buffer:body.buffer_minutes}))
      } else if (request.method === 'DELETE') {
        if (typeof body.id !== 'string' || !Number.isInteger(body.version)) throw new BookingError('Choose a booking to cancel.')
        checked(await db.rpc('cancel_recepta_booking',{p_client_id:user.id,p_id:body.id,p_version:body.version}))
        await deliverGoogleBookingJobs(db,user.id)
      } else {
        if (!account.paid) throw new BookingError('An active paid Recepta Pro plan is required.',403)
        if (request.method==='PATCH' && (typeof body.id!=='string'||!Number.isInteger(body.version))) throw new BookingError('Choose an existing booking to update.')
        if (typeof body.booking_key !== 'string' || body.booking_key.length>100) throw new BookingError('A booking request key is required.')
        const input = normalizeBooking(body,account.settings.duration_minutes)
        await validateBookingTime(db,user.id,account,input,typeof body.id==='string'?body.id:undefined)
        await deliverGoogleBookingJobs(db,user.id)
        await syncGoogleAvailability(db,user.id)
        const result = await db.rpc('reserve_recepta_booking',{p_client_id:user.id,p_booking_key:body.booking_key,p_details:{...input,source:'dashboard'},
          p_id:request.method==='PATCH'?body.id:null,p_version:request.method==='PATCH'?body.version:null})
        if (result.error) throw new BookingError(result.error.message,409)
        await deliverGoogleBookingJobs(db,user.id)
      }
    }
    const fields='id,customer_name,customer_phone,customer_email,service,notes,appointment_time,appointment_end_time,duration_minutes,employee_id,status,source,booking_key,booking_version,requested_date,requested_time,requested_timezone'
    const [appointments,requests,cancelled,employees,external,jobs,connection] = await Promise.all([
      db.from('appointments').select(fields).eq('client_id',user.id).eq('status','booked').gte('appointment_time',new Date(Date.now()-8*3600000).toISOString()).order('appointment_time').limit(250),
      db.from('appointments').select(fields).eq('client_id',user.id).eq('status','pending').order('created_at',{ascending:false}).limit(100),
      db.from('appointments').select(fields).eq('client_id',user.id).eq('status','cancelled').order('updated_at',{ascending:false}).limit(10),
      db.from('employees').select('id,name').eq('client_id',user.id).eq('is_active',true),
      db.from('booking_calendar_events').select('calendar_id,event_id,starts_at,ends_at,title,html_link,local_appointment_id').eq('client_id',user.id).gte('ends_at',new Date().toISOString()).order('starts_at').limit(250),
      db.from('booking_calendar_jobs').select('appointment_id,last_error').eq('client_id',user.id),
      loadGoogleConnection(db,user.id),
    ])
    const current = await loadBookingAccount(db,user.id)
    return json(200,{appointments:[...(checked(appointments)??[]),...(checked(requests)??[]),...(checked(cancelled)??[])],employees:checked(employees),external:checked(external),calendarJobs:checked(jobs),
      settings:current.settings,paid:current.paid,timeZone:current.schedule.timeZone,google:{configured:googleReady(),connected:Boolean(connection),
        selectedCalendars:connection?.selected_calendars??[],writeCalendarId:connection?.write_calendar_id??null,syncedAt:connection?.synced_at??null,error:connection?.sync_error??null}})
  } catch (error) { return json(error instanceof SyntaxError?400:error instanceof BookingError?error.status:500,{error:error instanceof BookingError?error.message:'Could not load or update bookings. Please refresh and try again.'}) }
}
