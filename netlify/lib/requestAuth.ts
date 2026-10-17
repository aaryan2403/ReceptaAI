import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export const isDeletingClient = async (db:SupabaseClient,clientId:string) => {
  const result=await db.from('clients').select('deletion_pending').eq('id',clientId).maybeSingle()
  if (result.error) throw new Error('Could not verify account availability.')
  return result.data?.deletion_pending === true
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

export const requestAuth = async (request: Request, admin = false) => {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, ADMIN_EMAIL } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || (admin && !ADMIN_EMAIL)) throw new Error('Server configuration is missing.')
  const token = request.headers.get('authorization')
  if (!token?.startsWith('Bearer ')) return { response: json(401, { error:'Please sign in.' }) }
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth:{ persistSession:false, autoRefreshToken:false } })
  const { data:{ user }, error } = await db.auth.getUser(token.slice(7))
  if (error || !user) return { response:json(401, { error:'Please sign in again.' }) }
  if (admin && user.email?.toLowerCase() !== ADMIN_EMAIL?.trim().toLowerCase()) return { response:json(403, { error:'Admin access required.' }) }
  if (!admin) {
    const client = await db.from('clients').select('deletion_pending').eq('id', user.id).maybeSingle()
    if (client.error) throw new Error('Could not verify account availability.')
    if (!client.data || client.data.deletion_pending) return { response:json(403, { error:'This account is unavailable or awaiting deletion.' }) }
  }
  return { db, user }
}
