import { createClient } from '@supabase/supabase-js'
import { verifyEmailWebhook } from '../lib/emailDelivery'
import { json } from '../lib/requestAuth'

const statuses:Record<string,string>={ 'email.delivered':'delivered','email.delivery_delayed':'delivery_delayed','email.bounced':'bounced','email.complained':'complained','email.failed':'failed','email.suppressed':'suppressed' }
export default async (request:Request) => {
  if (request.method!=='POST') return json(405,{ error:'Method not allowed.' })
  const { SUPABASE_URL,SUPABASE_SECRET_KEY }=process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return json(503,{ error:'Delivery tracking is unavailable.' })
  const raw=await request.text()
  if (raw.length>1_000_000) return json(413,{ error:'Payload too large.' })
  const db=createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  const stored=await db.from('integration_settings').select('value').eq('key','resend_webhook').maybeSingle()
  const secret=process.env.RESEND_WEBHOOK_SECRET || stored.data?.value?.secret
  if (stored.error || !secret) return json(503,{ error:'Delivery webhook setup is incomplete.' })
  if (!verifyEmailWebhook(raw,request.headers,secret)) return json(401,{ error:'Invalid email webhook signature.' })
  try {
    const event=JSON.parse(raw)
    const status=statuses[event.type]
    if (!status) return json(200,{ received:true })
    if (typeof event.data?.email_id!=='string' || !Number.isFinite(Date.parse(event.created_at))) return json(400,{ error:'Invalid email delivery event.' })
    const saved=await db.from('email_delivery_receipts').upsert({ event_id:request.headers.get('svix-id'),provider_message_id:event.data.email_id,status,event_at:new Date(event.created_at).toISOString() },{ onConflict:'event_id',ignoreDuplicates:true })
    if (saved.error) throw saved.error
    const updated=await db.rpc('apply_recepta_email_delivery',{ p_provider_id:event.data.email_id })
    if (updated.error) throw updated.error
    return json(200,{ received:true })
  } catch { return json(500,{ error:'Could not preserve delivery status; retry this event.' }) }
}
