import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { objectValue, textValue, uuid, validDate, validTime } from './appointmentScheduling'
import { normalizeE164 } from './retell'

export const CALLER_APPOINTMENT_TOOLS = ['find_appointment','reschedule_appointment','cancel_appointment'] as const
type CallerTool = typeof CALLER_APPOINTMENT_TOOLS[number]
export const isCallerAppointmentTool = (name: unknown): name is CallerTool =>
  CALLER_APPOINTMENT_TOOLS.some(tool => tool === name)

type Context = { clientId: string; agentId: string; callId: string; phone: string; key: string }
const TTL = 15 * 60_000
const failed = (reason = 'verification_failed') => ({
  success: false, reason,
  instruction: 'Do not disclose any booking details or claim a change. If verification fails, direct the caller to the business.',
})
const mac = (context: Context, id: string, version: number, expires: number) =>
  createHmac('sha256',context.key).update(JSON.stringify([
    'recepta-caller-appointment-v1',context.clientId,context.agentId,context.callId,context.phone,id,version,expires,
  ])).digest('base64url')
export const appointmentSession = (context: Context, id: string, version: number, now = Date.now()) => {
  const expires = now+TTL
  return version+'.'+expires+'.'+mac(context,id,version,expires)
}
export const verifyAppointmentSession = (context: Context, id: string, token: unknown, now = Date.now()) => {
  if (typeof token !== 'string' || !/^\d{1,10}\.\d{13}\.[A-Za-z0-9_-]{43}$/.test(token)) return null
  const [v, exp, signature] = token.split('.')
  const version = Number(v), expires = Number(exp)
  if (!Number.isInteger(version) || version<0 || expires<=now || expires>now+TTL) return null
  const expected = Buffer.from(mac(context,id,version,expires))
  const actual = Buffer.from(signature)
  return actual.length===expected.length && timingSafeEqual(actual,expected) ? version : null
}

export const manageCallerAppointment = async (
  db: SupabaseClient, tool: CallerTool, call: Record<string,unknown>, args: Record<string,unknown>,
  identity: Omit<Context,'phone'>,
) => {
  // Do not accept a phone number, tenant ID or call ID from tool arguments.
  // The endpoint has already verified the raw signed Retell wrapper. SQL also
  // requires an active, unexpired inbound minute reservation for this exact call.
  const phone = normalizeE164(textValue(call.from_number,60))
  if (!phone || call.call_type !== 'phone_call' || call.direction !== 'inbound') return failed()
  const context = { ...identity, phone }
  const invoke = async (id: string, action: string, version: number|null = null) => {
    const {data,error} = await db.rpc('recepta_caller_appointment',{
      p_client:context.clientId,p_agent:context.agentId,p_call:context.callId,p_phone:phone,p_ref:id,
      p_action:action,p_version:version,
      p_date:action==='reschedule' ? args.new_date : null,
      p_time:action==='reschedule' ? args.new_time : null,
      p_confirmed:action==='cancel' && args.confirmed===true,
    })
    if (error) throw error
    return objectValue(data)
  }
  const verified = (record: Record<string,unknown>) => {
    if (!uuid(record.appointment_id) || !Number.isInteger(record.booking_version)) throw new Error('Invalid caller appointment response.')
    const id = record.appointment_id.toLowerCase()
    return {
      appointment_id:id,status:record.status,start:record.start,time_zone:record.time_zone,
      duration_minutes:record.duration_minutes,
      verified_session_token:appointmentSession(context,id,Number(record.booking_version)),
    }
  }
  if (tool==='find_appointment') {
    const refs = args.booking_references
    if (!Array.isArray(refs) || refs.length<1 || refs.length>5 || !refs.every(uuid)) return failed()
    const records = []
    for (const ref of new Set(refs.map(ref=>ref.toLowerCase()))) {
      const record = await invoke(ref,'find')
      if (record.success!==true) return failed(record.reason==='service_unavailable' ? 'service_unavailable' : 'verification_failed')
      records.push(verified(record))
    }
    return {success:true,appointments:records,instruction:'Read only the verified appointment times and timezone. Never speak or ask the caller for the session token. If multiple appointments were verified, ask the caller to select one.'}
  }
  if (!uuid(args.appointment_id)) return failed()
  const id = args.appointment_id.toLowerCase()
  const version = verifyAppointmentSession(context,id,args.verified_session_token)
  if (version===null) return failed()
  if (tool==='cancel_appointment' && args.confirmed!==true) return failed('confirmation_required')
  if (tool==='reschedule_appointment' && (!validDate(args.new_date) || !validTime(args.new_time))) return failed('invalid_local_date_or_time')
  const action = tool==='cancel_appointment' ? 'cancel' : 'reschedule'
  const record = await invoke(id,action,version)
  if (record.success!==true) {
    if (record.reason==='verification_failed' || record.reason==='service_unavailable') return failed(String(record.reason))
    return {success:false,reason:record.reason,alternatives:record.alternatives ?? [],time_zone:record.time_zone,
      instruction:'The appointment has not changed. Offer only returned alternatives; otherwise ask the caller to contact the business. If the appointment changed, verify again.'}
  }
  if (action==='cancel') {
    if (record.status!=='cancelled') throw new Error('Cancellation not confirmed.')
    return {success:true,status:'cancelled',appointment_id:id,already_applied:record.already_applied===true,
      instruction:'Confirm cancellation. Do not claim an email was delivered.'}
  }
  if (record.status!=='booked' || typeof record.start!=='string') throw new Error('Reschedule not confirmed.')
  return {success:true,...verified(record),already_applied:record.already_applied===true,
    instruction:'Confirm the updated time and timezone. Do not claim an email was delivered.'}
}
