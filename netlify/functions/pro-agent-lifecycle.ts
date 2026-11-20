import { createClient } from '@supabase/supabase-js'
import { runProLifecycle } from '../lib/proLifecycle'
import { serviceDeployment } from '../lib/serviceAccess'

export const config = { schedule: '*/5 * * * *' }

export default async (request: Request) => {
  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return new Response('This preview must use Recepta Staging.', { status:503 })
  const { SUPABASE_URL,SUPABASE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Service lifecycle configuration is missing.')
  const db = createClient(SUPABASE_URL,SUPABASE_SECRET_KEY,{ auth:{ persistSession:false,autoRefreshToken:false } })
  await runProLifecycle(db,deployment)
  return new Response(null,{ status:204 })
}
