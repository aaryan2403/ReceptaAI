import { createClient } from '@supabase/supabase-js'
import { normalizeTransferNumber, syncHumanCallTransfer } from '../lib/callTransfer'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const token = request.headers.get('authorization')
  if (!token?.startsWith('Bearer ')) return json(401, { error: 'Sign in to configure call transfers.' })

  const { SUPABASE_URL, SUPABASE_SECRET_KEY, RETELL_API_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !RETELL_API_KEY) {
    return json(503, { error: 'Call transfer setup is not configured on the server.' })
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: authData, error: authError } =
    await db.auth.getUser(token.slice('Bearer '.length))
  const user = authData.user
  if (authError || !user) return json(401, { error: 'Please sign in again.' })

  let raw: { transferPhoneNumber?: unknown; existingBusinessNumber?: unknown }
  try { raw = await request.json() }
  catch { return json(400, { error: 'Invalid request body.' }) }

  let transferPhone: string | null
  let existingBusinessNumber: string | null
  try {
    transferPhone = normalizeTransferNumber(raw.transferPhoneNumber)
    existingBusinessNumber = normalizeTransferNumber(raw.existingBusinessNumber)
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : 'Invalid phone number.' })
  }

  if (transferPhone && transferPhone === existingBusinessNumber) {
    return json(400, {
      error: 'Use a different direct worker number. Transferring to a business number that forwards to Recepta can loop.',
    })
  }

  const [agentResult, subscriptionResult, directNumberResult, legacyPhoneResult] =
    await Promise.all([
      db.from('agents')
        .select('retell_agent_id, phone_number')
        .eq('client_id', user.id).maybeSingle(),
      db.from('subscriptions')
        .select('status').eq('client_id', user.id).maybeSingle(),
      transferPhone
        ? db.from('agent_phone_numbers').select('client_id').eq('phone_number', transferPhone).limit(1)
        : Promise.resolve({ data: [], error: null }),
      transferPhone
        ? db.from('agents').select('client_id').eq('phone_number', transferPhone).limit(1)
        : Promise.resolve({ data: [], error: null }),
    ])

  if (agentResult.error || subscriptionResult.error || directNumberResult.error || legacyPhoneResult.error) {
    return json(503, { error: 'Could not verify the phone-number configuration.' })
  }
  const agent = agentResult.data
  if (!agent?.retell_agent_id) {
    return json(409, { error: 'Assign your Retell agent before configuring call transfers.' })
  }
  // A shared Retell agent would make one client's transfer destination affect
  // another client's calls. Require a dedicated agent before publishing.
  const assignments = await db.from('agents')
    .select('client_id').eq('retell_agent_id', agent.retell_agent_id).limit(2)
  if (assignments.error || assignments.data?.length !== 1) {
    return json(409, {
      error: 'A dedicated Retell agent is required for each client before enabling transfers.',
    })
  }
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (subscriptionResult.data?.status !== 'active' && (!adminEmail || user.email?.toLowerCase() !== adminEmail)) {
    return json(403, { error: 'An active subscription is required to enable call transfers.' })
  }
  if (
    transferPhone && (
      transferPhone === agent.phone_number ||
      (directNumberResult.data?.length ?? 0) > 0 ||
      (legacyPhoneResult.data?.length ?? 0) > 0
    )
  ) {
    return json(400, {
      error: 'The transfer destination cannot be a Recepta AI number. Enter the worker’s direct line.',
    })
  }

  // Retell is modified only after all account and number checks succeed.
  // If Retell rejects the update, do not claim a saved or active transfer.
  try {
    await syncHumanCallTransfer({
      apiKey: RETELL_API_KEY,
      agentId: agent.retell_agent_id,
      destination: transferPhone,
    })
  } catch (error) {
    return json(502, {
      error: error instanceof Error ? error.message : 'Retell could not enable transfers.',
    })
  }

  const metadata = {
    ...(user.user_metadata ?? {}),
    recepta_transfer_phone_number: transferPhone,
    recepta_existing_business_number: existingBusinessNumber,
    recepta_transfer_enabled: Boolean(transferPhone),
  }
  const updated = await db.auth.admin.updateUserById(user.id, { user_metadata: metadata })
  if (updated.error) {
    return json(503, {
      error: 'Retell updated but the dashboard could not save the settings. Contact Recepta before changing them again.',
    })
  }

  return json(200, {
    success: true,
    enabled: Boolean(transferPhone),
    transferPhoneNumber: transferPhone,
    existingBusinessNumber,
    needsRealCallTest: true,
  })
}
