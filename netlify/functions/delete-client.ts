import { requestAuth,json } from '../lib/requestAuth'
import { processServiceJobs } from '../lib/serviceJobs'

// Netlify keeps the cleanup task alive after returning an immediate 202 response.
// The scheduled worker is the fallback if the request's background task fails.
type BackgroundContext = { waitUntil?: (promise: Promise<unknown>) => void }

export default async (request:Request, context?:BackgroundContext) => {
  if (request.method!=='POST') return json(405,{ error:'Method not allowed.' })
  try {
    const auth=await requestAuth(request,true)
    if (auth.response) return auth.response
    const { clientId }=await request.json()
    if (typeof clientId!=='string' || !/^[\da-f-]{36}$/i.test(clientId)) return json(400,{ error:'A valid client ID is required.' })
    if (clientId===auth.user.id) return json(409,{ error:'You cannot delete your own admin account.' })
    const result=await auth.db.rpc('start_recepta_client_deletion',{ p_client_id:clientId })
    if (result.error) return json(409,{ error:'Deletion could not be scheduled. Check that this is a client account.' })
    const response = json(202,{ success:true,pending:true,jobKey:result.data,message:'Client paused. Secure cleanup started; the scheduled worker will retry unfinished work.' })
    if (typeof result.data === 'string' && context?.waitUntil) {
      context.waitUntil(processServiceJobs(auth.db, result.data).catch(error => {
        console.error('Immediate client cleanup failed; scheduled retries remain enabled.', error)
      }))
    }
    return response
  } catch { return json(500,{ error:'Could not schedule client deletion.' }) }
}
