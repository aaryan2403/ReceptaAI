import { createClient } from '@supabase/supabase-js'
import { verifyRetellSignature } from '../lib/retell'
import { json, isDeletingClient } from '../lib/requestAuth'
import { BookingError, checked, loadBookingAccount, normalizeBooking, validateBookingTime } from '../lib/bookings'
import { deliverGoogleBookingJobs, syncGoogleAvailability } from '../lib/googleCalendar'

export default async (request: Request) => {
  if (request.method!=='POST') return json(405,{error:'Method not allowed.'})
  const { SUPABASE_URL,SUPABASE_SECRET_KEY,RETELL_API_KEY }=process.env
  if (!SUPABASE_URL||!SUPABASE_SECRET_KEY||!RETELL_API_KEY) return json(503,{error:'Booking tools are not configured.'})
  const raw=await request.text()
  if (!verifyRetellSignature(raw,request.headers.get('x-retell-signature'),RETELL_API_KEY)) return json(401,{error:'Invalid Retell signature.'})
  try {
    const payload=JSON.parse(raw) as {name:string;args?:Record<string,unknown>;call?:{call_id?:string;agent_id?:string;metadata?:Record<string,unknown>}}
    if (!['recepta_check_availability','recepta_book_appointment','recepta_list_employees'].includes(payload.name)) throw new BookingError('Unknown booking tool.')
    if (!payload.call?.call_id||!payload.call.agent_id) throw new BookingError('A provider call and agent ID are required.')
    const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
    const agent=checked(await db.from('agents').select('client_id').eq('retell_agent_id',payload.call.agent_id).maybeSingle())
    const clientId=agent?.client_id
    if (!clientId|| (payload.call.metadata?.recepta_client_id && payload.call.metadata.recepta_client_id!==clientId)) throw new BookingError('Agent assignment could not be verified.',403)
    if (await isDeletingClient(db,clientId)) throw new BookingError('This account is unavailable.',403)
    const account=await loadBookingAccount(db,clientId,true)
    if (!account.settings.enabled) return json(200,{enabled:false,instruction:'Booking is not enabled. Use recepta_save_appointment_details to record a request. Do not confirm a reservation.'})
    if (payload.name==='recepta_list_employees') {
      const employees=checked(await db.from('employees').select('id,name,role').eq('client_id',clientId).eq('is_active',true))
      return json(200,{employees,timeZone:account.schedule.timeZone,durationMinutes:account.settings.duration_minutes})
    }
    const args=payload.args??{}
    const input=normalizeBooking({...args,customer_name:payload.name==='recepta_check_availability'?'Availability check':args.customer_name},account.settings.duration_minutes)
    await deliverGoogleBookingJobs(db,clientId)
    await syncGoogleAvailability(db,clientId)
    if (payload.name==='recepta_check_availability') {
      const options=[]
      // Check the exact requested time, then nearby starts. Every returned
      // option includes its full date and timezone for the caller to confirm.
      for (let i=0;i<9;i++) {
        const option={...input,start:new Date(Date.parse(input.start)+i*30*60000).toISOString()}
        try {
          await validateBookingTime(db,clientId,account,option)
          const buffer=account.settings.buffer_minutes*60000
          const remaining=checked(await db.rpc('recepta_booking_remaining',{p_client_id:clientId,p_start:new Date(Date.parse(option.start)-buffer).toISOString(),p_end:new Date(Date.parse(option.start)+(option.duration_minutes*60000)+buffer).toISOString()}))
          if (Number(remaining)>0) options.push({start:option.start,duration_minutes:option.duration_minutes,remaining:Number(remaining)})
        } catch (error) { if (!(error instanceof BookingError)) throw error }
        if (options.length===3) break
      }
      return json(200,{enabled:true,timeZone:account.schedule.timeZone,options,instruction:'These are current options, not reservations. Confirm the caller’s choice, then use recepta_book_appointment. If no options are available, ask for another day or save a pending request.'})
    }
    await validateBookingTime(db,clientId,account,input)
    const result=await db.rpc('reserve_recepta_booking',{p_client_id:clientId,p_booking_key:`retell:${payload.call.call_id}`,p_details:{...input,source:'retell',retell_call_id:payload.call.call_id}})
    if (result.error) throw new BookingError(result.error.message,409)
    const appointment=result.data
    if (appointment.status!=='booked') return json(200,{status:appointment.status,instruction:'This call already has an appointment record. Do not claim a new reservation.'})
    await deliverGoogleBookingJobs(db,clientId)
    return json(200,{success:true,status:'booked',appointment_id:appointment.id,start:appointment.appointment_time,end:appointment.appointment_end_time,timeZone:account.schedule.timeZone,
      instruction:'The reservation is confirmed in Recepta. Read back the confirmed date and time. Do not claim email/SMS delivery or Google sync succeeded.'})
  } catch (error) { return json(error instanceof SyntaxError?400:error instanceof BookingError?error.status:503,{success:false,error:error instanceof BookingError?error.message:'Booking could not be verified. Please try again or save an appointment request.',instruction:'Do not claim an appointment is booked. A capacity conflict requires checking another time.'}) }
}
