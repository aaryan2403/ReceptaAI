import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { billingOrigin } from './billingNotifications'

export const verifyEmailWebhook = (body:string,headers:Headers,secret:string,now=Date.now()) => {
  const id=headers.get('svix-id'),timestamp=headers.get('svix-timestamp'),signature=headers.get('svix-signature')
  if (!id || id.length>128 || !timestamp || !/^\d+$/.test(timestamp) || !signature || Math.abs(now/1000-Number(timestamp))>300) return false
  try {
    const key=Buffer.from(secret.replace(/^whsec_/,''),'base64')
    if (key.length<16) return false
    const expected=createHmac('sha256',key).update(`${id}.${timestamp}.${body}`).digest()
    return signature.split(' ').some(item => {
      const [version,value]=item.split(',')
      if (version!=='v1' || !value) return false
      const actual=Buffer.from(value,'base64')
      return actual.length===expected.length && timingSafeEqual(actual,expected)
    })
  } catch { return false }
}

const resend = async (path:string,init:RequestInit = {}) => {
  const key=process.env.RESEND_API_KEY
  if (!key) throw new Error('Email service is not configured.')
  const response=await fetch('https://api.resend.com'+path,{ ...init,signal:AbortSignal.timeout(4000),headers:{ Authorization:`Bearer ${key}`,'Content-Type':'application/json' } })
  if (response.status===401 || response.status===403) throw new Error(`Resend rejected delivery tracking setup (${response.status}). Check that RESEND_API_KEY in Netlify is a valid Resend key with Full access (webhook access is required). Update the key if needed, redeploy Recepta, then try connecting again.`)
  if (!response.ok) throw new Error(`Resend could not connect email delivery tracking (${response.status}). Please try again later.`)
  return response.json()
}

const configureResendWebhook = async (db:SupabaseClient) => {
  const stored=await db.from('integration_settings').select('value').eq('key','resend_webhook').maybeSingle()
  if (stored.error) throw stored.error
  if (stored.data?.value?.secret) return
  const endpoint=billingOrigin()+'/.netlify/functions/resend-webhook'
  if (!endpoint.startsWith('https://')) throw new Error('Delivery webhooks require the production HTTPS address.')
  const list=await resend('/webhooks')
  const existing=(list.data ?? []).find((hook:{ endpoint:string }) => hook.endpoint===endpoint)
  const events=['email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed']
  if (existing) await resend('/webhooks/'+encodeURIComponent(existing.id),{ method:'PATCH',body:JSON.stringify({ status:'enabled',events }) })
  const hook=existing ? await resend('/webhooks/'+encodeURIComponent(existing.id)) : await resend('/webhooks',{
    method:'POST',body:JSON.stringify({ endpoint,events }),
  })
  const secret=hook.signing_secret
  if (typeof secret!=='string' || !secret.startsWith('whsec_')) throw new Error('The email webhook signing secret was not returned.')
  const saved=await db.from('integration_settings').upsert({ key:'resend_webhook',value:{ id:hook.id,secret,endpoint },updated_at:new Date().toISOString() },{ onConflict:'key' })
  if (saved.error) throw saved.error
}

export const configureEmailDelivery = async (db:SupabaseClient) => {
  try {
    await configureResendWebhook(db)
    const saved=await db.from('integration_settings').upsert({ key:'resend_setup_status',value:{ ready:true },updated_at:new Date().toISOString() },{ onConflict:'key' })
    if (saved.error) throw saved.error
  } catch(error) {
    const saved=await db.from('integration_settings').upsert({ key:'resend_setup_status',value:{ ready:false,error:error instanceof Error ? error.message : 'Email delivery setup failed.' },updated_at:new Date().toISOString() },{ onConflict:'key' })
    if (saved.error) throw saved.error
    throw error
  }
}
