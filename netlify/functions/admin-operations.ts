import { requestAuth,json } from '../lib/requestAuth'
import { configureEmailDelivery } from '../lib/emailDelivery'

export default async (request:Request) => {
  if (!['GET','POST'].includes(request.method)) return json(405,{ error:'Method not allowed.' })
  try {
    const auth=await requestAuth(request,true)
    if (auth.response) return auth.response
    const { db }=auth
    if (request.method==='POST') {
      const body=await request.json()
      if (body.action==='connect_email_tracking') await configureEmailDelivery(db)
      else if (body.action==='retention') {
        const days=Number(body.days)
        if (!Number.isInteger(days) || days<7 || days>365 || typeof body.clientId!=='string') return json(400,{ error:'Call content retention must be 7–365 days.' })
        const result=await db.from('clients').update({ call_retention_days:days }).eq('id',body.clientId)
        if (result.error) throw result.error
      } else if (body.action==='retry_cleanup') {
        const job=await db.from('service_jobs').select('kind,status').eq('job_key',body.jobKey).maybeSingle()
        if (job.error) throw job.error
        if (!job.data || !['delete_client','retention_call'].includes(job.data.kind) || job.data.status!=='needs_attention') return json(409,{ error:'Only paused cleanup jobs can be resumed here.' })
        const result=await db.from('service_jobs').update({ status:'queued',attempts:0,next_attempt_at:new Date().toISOString(),last_error:null }).eq('job_key',body.jobKey).eq('status','needs_attention')
        if (result.error) throw result.error
      } else return json(400,{ error:'Unknown operations action.' })
    }
    const bad='delivery_status.in.(bounced,complained,failed,suppressed,delivery_delayed)'
    const results=await Promise.all([
      db.from('service_jobs').select('job_key,client_id,kind,status,attempts,last_error,created_at,delivery_status').or(`status.neq.complete,${bad}`).order('created_at',{ ascending:false }).limit(50),
      db.from('call_notifications').select('notification_key,client_id,status,attempts,last_error,created_at,delivery_status').or(`status.eq.needs_attention,last_error.not.is.null,${bad}`).order('created_at',{ ascending:false }).limit(50),
      db.from('billing_notifications').select('notification_key,client_id,attempts,last_error,created_at,sent_at,delivery_status').or(`last_error.not.is.null,${bad}`).order('created_at',{ ascending:false }).limit(50),
      db.from('clients').select('id,company_name,call_retention_days,deletion_pending').order('company_name'),
      db.from('integration_settings').select('key').eq('key','resend_webhook').maybeSingle(),
    ])
    for (const result of results) if (result.error) throw result.error
    return json(200,{ jobs:results[0].data,callAlerts:results[1].data,billingAlerts:results[2].data,clients:results[3].data,
      configuration:{ emailSending:Boolean(process.env.RESEND_API_KEY),deliveryTracking:Boolean(process.env.RESEND_WEBHOOK_SECRET || results[4].data),retell:Boolean(process.env.RETELL_API_KEY),stripe:Boolean(process.env.STRIPE_SECRET_KEY) } })
  } catch(error) { return json(500,{ error:error instanceof Error ? error.message : 'Could not load operations.' }) }
}
