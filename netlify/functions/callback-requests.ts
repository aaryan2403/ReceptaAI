import { requestAuth, json } from '../lib/requestAuth'

export default async (request: Request) => {
  if (!['GET','PATCH'].includes(request.method)) return json(405, { error:'Method not allowed.' })
  try {
    const auth = await requestAuth(request)
    if (auth.response) return auth.response
    const { db, user } = auth
    if (request.method === 'PATCH') {
      const { id, status } = await request.json()
      if (typeof id !== 'string' || !['pending','contacted','resolved','unreachable'].includes(status)) return json(400, { error:'Choose a valid callback status.' })
      const updated = await db.from('callback_requests').update({ status, updated_at:new Date().toISOString() })
        .eq('id', id).eq('client_id', user.id).select('id').maybeSingle()
      if (updated.error) throw updated.error
      if (!updated.data) return json(404, { error:'Callback not found.' })
    }
    const result = await db.from('callback_requests').select('id, caller_number, called_number, reason, status, created_at')
      .eq('client_id', user.id).order('created_at', { ascending:false }).limit(100)
    if (result.error) throw result.error
    return json(200, { callbacks:result.data })
  } catch { return json(500, { error:'Could not load or update callbacks.' }) }
}
