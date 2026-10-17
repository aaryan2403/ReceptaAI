import { requestAuth,json } from '../lib/requestAuth'

export default async (request:Request) => {
  if (request.method!=='POST') return json(405,{ error:'Method not allowed.' })
  try {
    const auth=await requestAuth(request,true)
    if (auth.response) return auth.response
    const { clientId }=await request.json()
    if (typeof clientId!=='string' || !/^[\da-f-]{36}$/i.test(clientId)) return json(400,{ error:'A valid client ID is required.' })
    if (clientId===auth.user.id) return json(409,{ error:'You cannot delete your own admin account.' })
    const result=await auth.db.rpc('start_recepta_client_deletion',{ p_client_id:clientId })
    if (result.error) return json(409,{ error:'Deletion could not be scheduled. Check that this is a client account.' })
    return json(202,{ success:true,pending:true,jobKey:result.data,message:'Client paused. Deletion completes only after Stripe and Retell cleanup succeeds.' })
  } catch { return json(500,{ error:'Could not schedule client deletion.' }) }
}
