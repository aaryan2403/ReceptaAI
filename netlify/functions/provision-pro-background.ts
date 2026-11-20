import { uuid } from '../lib/appointmentScheduling'
import { requestAuth, json } from '../lib/requestAuth'
import { serviceDeployment } from '../lib/serviceAccess'
import { processServiceJobs } from '../lib/serviceJobs'

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const deployment = serviceDeployment(request)
  if (!deployment.isolated) return json(503, { error: 'This preview must use Recepta Staging.' })
  const auth = await requestAuth(request, true)
  if (auth.response) return auth.response
  const body = await request.json().catch(() => null)
  if (!uuid(body?.clientId)) return json(400, { error: 'Choose a valid client.' })
  await processServiceJobs(auth.db, 'provision-pro:' + body.clientId, deployment)
  return new Response(null, { status: 204 })
}
