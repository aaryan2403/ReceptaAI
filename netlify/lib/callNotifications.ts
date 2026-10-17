import type { SupabaseClient } from '@supabase/supabase-js'
import { buildCallNotification, type CallEmailPayload } from './callNotificationEmail'
import { getStoredBusinessSchedule } from './employeeSchedule'
import { isDeletingClient } from './requestAuth'

type CallNotice = {
  notification_key: string
  client_id: string
  call_record_id: string
  retell_call_id: string
  plan_name: 'Recepta Standard' | 'Recepta Pro'
  lease_token: string
  mail_payload: CallEmailPayload | null
}

const buildQueuedEmail = async (db: SupabaseClient, notice: CallNotice) => {
  const [callResult, businessResult] = await Promise.all([
    db.from('calls').select('caller_name, caller_number, started_at, duration_seconds, outcome, summary, retell_agent_id')
      .eq('id', notice.call_record_id).eq('client_id', notice.client_id).maybeSingle(),
    db.from('clients').select('company_name, contact_email').eq('id', notice.client_id).maybeSingle(),
  ])
  if (callResult.error || !callResult.data) throw new Error('Call details could not be loaded.')
  if (businessResult.error) throw new Error('Business contact details could not be loaded.')
  const call = callResult.data
  const agentResult = await db.from('agents').select('business_hours')
    .eq('client_id', notice.client_id).eq('retell_agent_id', call.retell_agent_id).maybeSingle()
  if (agentResult.error) throw new Error('Business timezone could not be loaded.')
  let ownerEmail = businessResult.data?.contact_email?.trim()
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    const { data, error } = await db.auth.admin.getUserById(notice.client_id)
    if (error) throw new Error('Owner account email could not be loaded.')
    ownerEmail = data.user?.email
  }
  const schedule = getStoredBusinessSchedule(agentResult.data?.business_hours)
  let appointment = null
  if (notice.plan_name === 'Recepta Pro') {
    const { data, error } = await db.from('appointments')
      .select('customer_name, customer_email, customer_phone, company_name, service, notes, appointment_time, appointment_end_time, duration_minutes, employee_id, status, requested_date, requested_time, requested_timezone')
      .eq('client_id', notice.client_id).eq('retell_call_id', notice.retell_call_id).limit(1).maybeSingle()
    if (error) throw new Error('Appointment request details could not be loaded.')
    let employeeName = null
    if (data?.employee_id) {
      const employee = await db.from('employees').select('name')
        .eq('client_id', notice.client_id).eq('id', data.employee_id).maybeSingle()
      if (employee.error) throw new Error('Appointment employee could not be loaded.')
      employeeName = employee.data?.name ?? null
    }
    if (data) appointment = {
      status: data.status, requestedDate: data.requested_date, requestedTime: data.requested_time,
      requestedTimezone: data.requested_timezone, customerName: data.customer_name,
      customerEmail: data.customer_email, customerPhone: data.customer_phone, customerCompany: data.company_name,
      employeeName, service: data.service, notes: data.notes, start: data.appointment_time,
      end: data.appointment_end_time, durationMinutes: data.duration_minutes, timeZone: schedule.timeZone,
    }
  }
  return buildCallNotification({
    planName: notice.plan_name, businessName: businessResult.data?.company_name || 'your business', ownerEmail,
    callerName: call.caller_name, callerNumber: call.caller_number, startedAt: call.started_at,
    durationSeconds: call.duration_seconds, timeZone: schedule.timeZone,
    outcome: call.outcome, summary: call.summary, appointment,
  })
}

// A lease prevents overlapping workers. Freeze the complete request before HTTP:
// an accepted send followed by a timeout/database failure reuses identical body/key.
export const deliverCallNotices = async (db: SupabaseClient, limit = 5, key?: string) => {
  const deadline = Date.now() + 24_000
  const { data, error } = await db.rpc('claim_recepta_call_notifications', { p_limit: limit, p_key: key ?? null })
  if (error) throw error
  for (const notice of (data ?? []) as CallNotice[]) {
    if (Date.now() >= deadline) break // unused leases expire and become retryable
    try {
      if (await isDeletingClient(db,notice.client_id)) continue
      const apiKey = process.env.RESEND_API_KEY
      if (!apiKey) throw new Error('Call email configuration is missing.')
      const payload = notice.mail_payload ?? await buildQueuedEmail(db, notice)
      const prepared = await db.rpc('prepare_recepta_call_notification', {
        p_key: notice.notification_key, p_lease: notice.lease_token, p_payload: payload,
      })
      if (prepared.error) throw new Error('Could not save the email before sending.')
      const frozen = (prepared.data as CallNotice[] | null)?.[0]
      if (!frozen?.mail_payload) continue // lease no longer belongs to this worker
      await new Promise((resolve) => setTimeout(resolve, 550))
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': notice.notification_key },
        signal: AbortSignal.timeout(3000), body: JSON.stringify(frozen.mail_payload),
      })
      if (!response.ok) throw new Error(`Email provider rejected the request (${response.status}).`)
      const receipt = await response.json() as { id?: unknown }
      if (typeof receipt.id !== 'string' || !receipt.id.trim()) throw new Error('Email provider acceptance could not be confirmed.')
      const saved = await db.rpc('finish_recepta_call_notification', {
        p_key: notice.notification_key, p_lease: notice.lease_token, p_provider_id: receipt.id, p_error: null,
      })
      if (saved.error || !saved.data) throw new Error('Email acceptance could not be saved; retry uses the same delivery key.')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Owner email delivery failed.'
      const result = await db.rpc('finish_recepta_call_notification', {
        p_key: notice.notification_key, p_lease: notice.lease_token, p_provider_id: null, p_error: message,
      })
      console.error('Owner email remains queued:', message)
      if (result.error) console.error('Could not record email retry; the lease will expire.')
    }
  }
}
