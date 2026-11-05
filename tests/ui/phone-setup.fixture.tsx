import { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CallTransferSettings from '../../src/components/CallTransferSettings'
import type { TransferSchedule } from '../../src/lib/transferSchedule'
import type { PhoneAccount, phoneSetupRequest } from '../../src/lib/phoneSetup'
import '../../src/index.css'
import '../../src/App.css'

// Development-only UI fixture. No Auth session, Retell/Twilio request, payment,
// or customer data is used. Vite's production input does not include this page.
if (!import.meta.env.DEV) throw new Error('This fixture is development-only.')
const phone = (value: unknown) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (!digits) return ''
  return '+' + (digits.length === 10 ? '1' : '') + digits
}
const account = (agent: string, number?: string): PhoneAccount => ({
  paid: true, agent: { retell_agent_id: agent, status: 'live' }, numbers: number ? [number] : [],
  settings: null, destination: null, verifiedNumbers: [], verificationAvailable: true,
})
export function Fixture() {
  const accounts = useRef<Record<string, PhoneAccount>>({
    north: account('agent_north', '+14165550100'),
    south: account('agent_south', '+16475550101'),
    new: { ...account('agent_new'), paid: false },
  })
  const [customer, setCustomer] = useState('north')
  const [failSync, setFailSync] = useState(false)
  const fail = useRef(false)
  const [log, setLog] = useState<string[]>([])
  const request: typeof phoneSetupRequest = useCallback(async <T,>(body?: Record<string, unknown>): Promise<T> => {
    const own = accounts.current[customer]
    if (!body) return structuredClone(own) as T
    setLog(previous => [...previous, `${customer}: ${String(body.action)}`])
    const action = body.action
    let message = ''
    if (action === 'disable') {
      if (own.destination) own.destination.enabled = false
      if (own.settings) own.settings.revision++
      message = 'Human transfers disabled for new calls.'
    } else {
      if (!own.paid) throw new Error('Complete payment in Billing before configuring phone service.')
      if (action === 'send-code') {
        if (!body.authorized) throw new Error('Confirm that you are authorized to verify this number.')
        message = 'Synthetic code requested. Enter 123456 to verify.'
      } else if (action === 'verify-code') {
        if (body.code !== '123456') throw new Error('Incorrect verification code.')
        own.verifiedNumbers.push({ purpose: String(body.purpose), phone_number: phone(body.phoneNumber), verified_at: new Date().toISOString() })
        message = 'Number verified. You can now save your setup.'
      } else if (action === 'save') {
        if (body.expectedRevision !== (own.settings?.revision ?? 0)) throw new Error('Settings changed. Reload before saving.')
        const worker = phone(body.workerNumber)
        const business = body.mode === 'existing' ? phone(body.businessNumber) : null
        if (body.transferEnabled && (worker === business || own.numbers.includes(worker))) throw new Error('Use a direct worker number. Forwarded numbers create a call loop.')
        own.settings = { mode: body.mode as 'new' | 'existing', business_number: business, carrier: String(body.carrier),
          line_type: body.lineType as 'mobile' | 'landline' | 'voip', revision: (own.settings?.revision ?? 0) + 1,
          transfer_schedule: body.transferSchedule as TransferSchedule, sync_state: fail.current ? 'error' : 'synced', reception_tested_at: null, transfer_tested_at: null }
        own.destination = { phone_number: worker, enabled: body.transferEnabled === true }
        if (fail.current) throw new Error('Settings saved, but agent sync failed. Transfers are unavailable for new calls until you save and sync successfully.')
        message = body.transferEnabled ? 'Warm transfer synced. Complete the real call tests below before relying on it.' : 'Phone setup synced. Human transfers are disabled.'
      } else if (action === 'check-connection') {
        message = 'Synthetic routing check complete. Real reception still requires a phone call.'
      } else if (action === 'start-reception-test') {
        message = 'Synthetic reception test code: 654321. Real incoming tests require a deployed isolated test site; this fixture makes no calls.'
      } else if (action === 'confirm-test' && own.settings) {
        if (body.kind === 'reception') own.settings.reception_tested_at = new Date().toISOString()
        else own.settings.transfer_tested_at = new Date().toISOString()
        message = 'Your test confirmation was saved.'
      } else throw new Error('Unsupported fixture action.')
    }
    return { message } as T
  }, [customer])
  return <main style={{ maxWidth: 1080, padding: '24px', margin: '0 auto', color: '#ecf5ef' }}>
    <div style={{ padding: 20, marginBottom: 24, border: '1px solid #365342', borderRadius: 14, background: '#102018' }}>
      <strong>Development review · synthetic customers only</strong>
      <p>No calls, messages, payments, or live data. Verification code: 123456.</p>
      <label>Review customer <select aria-label="Review customer" value={customer} onChange={e => setCustomer(e.target.value)}>
        <option value="north">North Plumbing</option><option value="south">South Heating</option><option value="new">New customer · payment pending</option>
      </select></label>
      <label style={{ display: 'block', marginTop: 12 }}><input type="checkbox" checked={failSync} onChange={e => { setFailSync(e.target.checked); fail.current = e.target.checked }} /> Simulate agent sync failure</label>
    </div>
    <CallTransferSettings key={customer} request={request} />
    <details style={{ marginTop: 24 }}><summary>Fixture action log</summary><pre>{log.join('\n') || 'No changes yet.'}</pre></details>
  </main>
}
document.body.style.background = '#050c08'
createRoot(document.getElementById('root')!).render(<Fixture />)
