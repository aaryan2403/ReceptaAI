import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { billingOrigin } from '../lib/billingNotifications'

const json = (status: number, body: object) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

export default async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY } = process.env
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY) return json(500, { error: 'Billing is not configured.' })
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return json(401, { error: 'Please sign in again.' })
  const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  const { data: { user }, error: authError } = await db.auth.getUser(token)
  if (authError || !user) return json(401, { error: 'Please sign in again.' })
  try {
    const { data, error } = await db.from('subscriptions').select('stripe_customer_id')
      .eq('client_id', user.id).maybeSingle()
    if (error) throw error
    if (!data?.stripe_customer_id) return json(409, { error: 'Complete your first subscription payment before managing billing.' })
    const stripe = new Stripe(STRIPE_SECRET_KEY)
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${billingOrigin()}/dashboard/billing`,
      ...(process.env.STRIPE_PORTAL_CONFIGURATION_ID ? { configuration: process.env.STRIPE_PORTAL_CONFIGURATION_ID } : {}),
    })
    return json(200, { url: session.url })
  } catch (error) {
    console.error('Could not open Stripe billing portal:', error)
    return json(500, { error: 'Could not open billing management. Please contact Recepta.' })
  }
}
