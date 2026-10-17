import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { billingOrigin } from './billingNotifications'

export type ServiceJob = {
  job_key:string; client_id:string; kind:string; payload:Record<string, unknown>
  lease_token:string; mail_payload:Record<string, unknown>|null; first_send_at:string|null; attempts:number
}
class ContinueWork extends Error {}
const check = (error: unknown) => { if (error) throw error }
const missing = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'resource_missing'

export const providerDelete = async (path:string, init:RequestInit = { method:'DELETE' }) => {
  if (!process.env.RETELL_API_KEY) throw new Error('Retell cleanup configuration is missing.')
  const response = await fetch('https://api.retellai.com'+path, {
    ...init, signal:AbortSignal.timeout(4000), headers:{ Authorization:`Bearer ${process.env.RETELL_API_KEY}`, 'Content-Type':'application/json' },
  })
  if (!response.ok && (response.status!==404 || init.method==='POST')) throw new Error(`Retell cleanup failed (${response.status}).`)
  return response.status===404 || response.status===204 ? null : await response.json()
}

const checkpoint = async (db:SupabaseClient, job:ServiceJob, values:Record<string,unknown>) => {
  const result = await db.from('service_jobs').update(values).eq('job_key',job.job_key).eq('lease_token',job.lease_token)
    .gt('lease_expires_at',new Date().toISOString()).select('job_key').maybeSingle()
  if (result.error || !result.data) throw new Error('Cleanup lease expired; progress will be retried.')
}

const callbackEmail = async (db:SupabaseClient, job:ServiceJob) => {
  const key=process.env.RESEND_API_KEY
  if (!key) throw new Error('Callback email configuration is missing.')
  let mail=job.mail_payload
  if (!mail) {
    const [callback,client] = await Promise.all([
      db.from('callback_requests').select('caller_number,reason,created_at').eq('id',job.payload.callback_id).eq('client_id',job.client_id).maybeSingle(),
      db.from('clients').select('contact_email,company_name,deletion_pending').eq('id',job.client_id).maybeSingle(),
    ])
    check(callback.error);check(client.error)
    if (!callback.data || !client.data || client.data.deletion_pending) return
    const email=client.data.contact_email?.trim()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Business callback email is missing or invalid.')
    mail={ from:process.env.CALL_NOTIFICATION_FROM_EMAIL?.trim() || process.env.APPOINTMENT_FROM_EMAIL?.trim() || 'Recepta <notifications@mail.recepta.ca>', to:[email],
      subject:`Missed call — ${client.data.company_name || 'your business'} needs a callback`,
      text:`Your AI could not accept a call at ${callback.data.created_at}.\nCaller: ${callback.data.caller_number || 'Caller ID unavailable'}\nReason: ${callback.data.reason.replaceAll('_',' ')}\nNo AI minutes were used.\nReview and track the follow-up: ${billingOrigin()}/dashboard/calls`,
    }
    await checkpoint(db,job,{ mail_payload:mail,first_send_at:new Date().toISOString() })
  }
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',signal:AbortSignal.timeout(3000),headers:{ Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':job.job_key },body:JSON.stringify(mail),
  })
  if (!response.ok) throw new Error(`Callback email rejected (${response.status}).`)
  const receipt=await response.json() as { id?:string }
  if (!receipt.id) throw new Error('Callback email acceptance was not confirmed.')
  await checkpoint(db,job,{ provider_message_id:receipt.id,delivery_status:'accepted' })
}

const deleteClient = async (db:SupabaseClient,job:ServiceJob,deadline:number) => {
  const payload={ ...job.payload }
  const continueBeforeDeadline = () => { if (Date.now()>deadline-4500) throw new ContinueWork() }
  const progress=async (values:Record<string,unknown>) => {
    Object.assign(payload,values)
    await checkpoint(db,job,{ payload })
  }
  // Never remove local records when external billing cleanup failed.
  if (!payload.billing_done) {
    const customer=payload.stripe_customer_id as string|null, subscription=payload.stripe_subscription_id as string|null
    if (customer || subscription) {
      if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe cleanup configuration is missing.')
      const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{ timeout:4000,maxNetworkRetries:0 })
      if (subscription) {
        try {
          const current=await stripe.subscriptions.retrieve(subscription)
          if (current.status!=='canceled') await stripe.subscriptions.cancel(subscription)
        } catch(error) { if (!missing(error)) throw error }
      }
      continueBeforeDeadline()
      if (customer) {
        // Customer deletion also cancels duplicate Stripe subscriptions that are
        // not represented by the single local subscription row.
        try { await stripe.customers.del(customer) } catch(error) { if (!missing(error)) throw error }
      }
    }
    await progress({ billing_done:true })
  }
  const agentId=payload.agent_id as string|null
  if (agentId && !payload.ownership_checked) {
    const others=await db.from('agents').select('client_id').eq('retell_agent_id',agentId).neq('client_id',job.client_id).limit(1)
    check(others.error)
    if (others.data?.length) throw new Error('Retell agent is shared by another client. Separate its resources before deleting this account.')
    await progress({ ownership_checked:true })
  }
  const numbers=(payload.numbers ?? []) as Array<{ number:string;source:string }>
  const done=(payload.numbers_done ?? []) as string[]
  for (const number of numbers) {
    if (done.includes(number.number)) continue
    continueBeforeDeadline()
    if (number.source==='retell') await providerDelete('/delete-phone-number/'+encodeURIComponent(number.number))
    else await providerDelete('/update-phone-number/'+encodeURIComponent(number.number), { method:'PATCH',body:JSON.stringify({ inbound_agents:null,outbound_agents:null,inbound_webhook_url:null }) })
    done.push(number.number)
    await progress({ numbers_done:done })
  }
  // Remove provider calls that may not have reached our webhook yet. Each
  // successful DELETE makes the next first page smaller.
  if (agentId && !payload.calls_done) {
    while (true) {
      continueBeforeDeadline()
      const result=await providerDelete('/v3/list-calls',{ method:'POST',body:JSON.stringify({ filter_criteria:{ agent:[{ agent_id:agentId }] },limit:10,sort_order:'ascending' }) })
      if (!Array.isArray(result?.items)) throw new Error('Retell did not confirm the call list; cleanup is paused.')
      const calls=result.items as Array<{ call_id:string; call_status?:string }>
      if (!calls.length) break
      for (const call of calls) {
        if (['ongoing','registered'].includes(call.call_status ?? '')) throw new ContinueWork('Waiting for the current call to finish.')
        continueBeforeDeadline()
        await providerDelete('/v2/delete-call/'+encodeURIComponent(call.call_id))
      }
    }
    await progress({ calls_done:true })
  }
  if (!agentId) {
    const saved=await db.from('calls').select('id,retell_call_id,provider_erased_at').eq('client_id',job.client_id)
    check(saved.error)
    for (const call of saved.data ?? []) {
      if (!call.retell_call_id || call.provider_erased_at) continue
      continueBeforeDeadline()
      await providerDelete('/v2/delete-call/'+encodeURIComponent(call.retell_call_id))
      const erased=await db.rpc('erase_recepta_call_content',{ p_call_id:call.id,p_client_id:job.client_id })
      check(erased.error)
    }
  }
  if (agentId && !payload.agent_done) {
    continueBeforeDeadline()
    await providerDelete('/delete-agent/'+encodeURIComponent(agentId))
    await progress({ agent_done:true })
  }
  continueBeforeDeadline()
  const user=await db.auth.admin.getUserById(job.client_id)
  if (user.error && user.error.code!=='user_not_found') throw user.error
  if (user.data?.user) {
    const banned=await db.auth.admin.updateUserById(job.client_id,{ ban_duration:'876000h' })
    check(banned.error)
    const removed=await db.auth.admin.deleteUser(job.client_id)
    if (removed.error && removed.error.code!=='user_not_found') throw removed.error
  }
  // Auth FK cascade clears tenant records; jobs deliberately survive that.
  const removed=await db.from('clients').delete().eq('id',job.client_id)
  check(removed.error)
  const jobs=await db.from('service_jobs').delete().eq('client_id',job.client_id).neq('job_key',job.job_key)
  check(jobs.error)
}

const eraseRetainedCall = async (db:SupabaseClient,job:ServiceJob) => {
  const callId=job.payload.retell_call_id as string|null
  if (callId) await providerDelete('/v2/delete-call/'+encodeURIComponent(callId))
  const erased=await db.rpc('erase_recepta_call_content',{ p_call_id:job.payload.call_id,p_client_id:job.client_id })
  check(erased.error)
}

export const processServiceJobs = async (db:SupabaseClient, key?:string) => {
  const deadline=Date.now()+22_000
  const claimed=await db.rpc('claim_recepta_service_jobs',{ p_limit:2,p_key:key ?? null })
  check(claimed.error)
  for (const job of (claimed.data ?? []) as ServiceJob[]) {
    if (Date.now()>deadline-4500) break
    try {
      if (job.kind==='callback_email') await callbackEmail(db,job)
      else if (job.kind==='delete_client') await deleteClient(db,job,deadline)
      else if (job.kind==='retention_call') await eraseRetainedCall(db,job)
      else throw new Error('Unknown service job type.')
      const done=await db.rpc('finish_recepta_service_job',{ p_key:job.job_key,p_lease:job.lease_token,p_error:null })
      if (done.error || !done.data) throw new Error('Could not confirm service-job completion.')
    } catch(error) {
      if (error instanceof ContinueWork) {
        await checkpoint(db,job,{ status:'queued',lease_token:null,lease_expires_at:null,attempts:Math.max(0,job.attempts-1),last_error:error.message || null,next_attempt_at:new Date(Date.now()+5000).toISOString() })
      } else {
        const message=error instanceof Error ? error.message : 'Service cleanup failed.'
        const saved=await db.rpc('finish_recepta_service_job',{ p_key:job.job_key,p_lease:job.lease_token,p_error:message })
        if (saved.error) console.error('Could not record service-job failure; lease will expire.')
      }
    }
  }
}
