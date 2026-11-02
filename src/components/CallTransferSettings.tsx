import { useCallback, useEffect, useState } from 'react'
import { Phone, ArrowRight, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { phoneSetupRequest, type PhoneAccount } from '../lib/phoneSetup'
import { forwardingGuide } from '../lib/forwardingGuides'
import './PhoneSetup.css'

const canonical = (v: string) => { const d = v.replace(/\D/g, ''); return '+' + (d.length === 10 ? '1' : '') + d }
function VerifyNumber({ purpose, number, verified, disabled, available, run }: {
  purpose: 'business' | 'worker'; number: string; verified: boolean; disabled: boolean; available: boolean
  run: (body: Record<string, unknown>) => Promise<void>
}) {
  const [channel, setChannel] = useState('sms')
  const [code, setCode] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [sentTo, setSentTo] = useState('')
  if (verified) return <p className="phoneVerified"><ShieldCheck size={16} aria-hidden="true" /> Number verified</p>
  return <div className="phoneVerification">
    <label className="phoneCheck"><input type="checkbox" checked={authorized} disabled={disabled} onChange={e => setAuthorized(e.target.checked)} />
      I am authorized to use this number and receive a verification text or call.</label>
    {!available && <p className="phoneWarning">Phone verification is awaiting setup by Recepta. Transfers stay disabled until verification is connected.</p>}
    <div className="phoneInline">
      <select aria-label={`${purpose} verification method`} value={channel} onChange={e => setChannel(e.target.value)} disabled={disabled || !available}>
        <option value="sms">Text message</option><option value="call">Voice call (landlines too)</option>
      </select>
      <button type="button" className="btn btnOutline" disabled={disabled || !number || !authorized || !available}
        onClick={async () => { try { await run({ action: 'send-code', purpose, phoneNumber: number, channel, authorized }); setSentTo(number) } catch { /* parent displays the error */ } }}>Send code</button>
    </div>
    {sentTo && sentTo === number && <div className="phoneInline">
      <input aria-label={`${purpose} verification code`} inputMode="numeric" autoComplete="one-time-code" maxLength={10} placeholder="Verification code" value={code} onChange={e => setCode(e.target.value)} disabled={disabled} />
      <button type="button" className="btn btnOutline" disabled={disabled || !code} onClick={() => { void run({ action: 'verify-code', purpose, phoneNumber: number, code }).catch(() => {}) }}>Verify number</button>
    </div>}
  </div>
}
export default function CallTransferSettings() {
  const [account, setAccount] = useState<PhoneAccount | null>(null)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [business, setBusiness] = useState('')
  const [worker, setWorker] = useState('')
  const [carrier, setCarrier] = useState('rogers')
  const [lineType, setLineType] = useState<'mobile' | 'landline' | 'voip'>('mobile')
  const [enabled, setEnabled] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  const load = useCallback(async (reset = true) => {
    const data = await phoneSetupRequest<PhoneAccount>()
    setAccount(data)
    if (reset) {
      setMode(data.settings?.mode ?? 'new'); setBusiness(data.settings?.business_number ?? '')
      setWorker(data.destination?.phone_number ?? ''); setEnabled(data.destination?.enabled ?? false)
      setCarrier(data.settings?.carrier ?? 'rogers'); setLineType(data.settings?.line_type ?? 'mobile')
      setAuthorized(false); setDirty(false)
    }
  }, [])
  useEffect(() => { let mounted = true
    load().catch(e => { if (mounted) setError(e instanceof Error ? e.message : 'Could not load phone setup.') }).finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [load])
  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await phoneSetupRequest<{ message: string }>(body)
      await load(body.action === 'save' || body.action === 'disable')
      setMessage(result.message)
    } catch (e) {
      await load(false).catch(() => {})
      setError(e instanceof Error ? e.message : 'Could not update phone setup.'); throw e
    }
    finally { setBusy(false) }
  }
  // Event handlers consume failures; messages above keep the result visible.
  const perform = async (body: Record<string, unknown>) => { try { await run(body) } catch { /* visible error */ } }
  const assigned = account?.numbers[0] ?? ''
  const guide = forwardingGuide(carrier, lineType, assigned)
  const verified = (purpose: string, value: string) => Boolean(account?.verifiedNumbers.some(row => row.purpose === purpose && row.phone_number === canonical(value)))
  const editable = Boolean(account?.paid && !busy)
  const tested = !dirty && Boolean(account?.settings?.reception_tested_at)
  return <section className="agentPanel phoneSetup" aria-labelledby="phoneSetupTitle" aria-busy={loading || busy}>
    <div className="phoneHeading"><div><span className="agentSectionLabel">PHONE SETUP / MANAGE NUMBERS</span><h2 id="phoneSetupTitle">Your business, connected.</h2>
      <p>Keep the number your customers know, or use your Recepta number. Hand off to a person when it matters.</p></div><span className="phoneHeadingIcon"><Phone aria-hidden="true" size={24} /></span></div>
    {error && <div role="alert" className="phoneAlert phoneError"><AlertTriangle size={18} aria-hidden="true" /><span>{error}</span></div>}
    {message && <div role="status" className="phoneAlert phoneSuccess"><CheckCircle2 size={18} aria-hidden="true" /><span>{message}</span></div>}
    {loading ? <p role="status">Loading your phone setup…</p> : !account ? <button type="button" className="btn btnOutline" onClick={() => { setLoading(true); setError(''); void load().catch(e => setError(e.message)).finally(() => setLoading(false)) }}>Retry loading</button> : <>
      {!account.paid && <div className="phoneWarning">Phone service is paused until payment is complete. Your saved settings remain available. <a href="/dashboard/billing">Open Billing</a>.</div>}
      <div className="phoneNumberCard"><div><span>YOUR RECEPTA AI NUMBER</span><strong>{assigned || 'Awaiting number assignment'}</strong>
        {account.numbers.slice(1).map(number => <p key={number}>{number}</p>)}</div>
        <span className={`phoneStatus ${tested && account.paid ? 'phoneStatusGood' : ''}`}>{!account.paid ? 'Billing required' : !assigned ? 'Setup pending' : tested ? 'Call tested by you' : 'Assigned · call test needed'}</span>
      </div>
      <fieldset disabled={!editable}><legend><span className="phoneStep">01</span> Choose how customers reach you</legend>
        <div className="phoneOptions">
          <label className={mode === 'existing' ? 'phoneOption selected' : 'phoneOption'}><input type="radio" name="phoneMode" checked={mode === 'existing'} onChange={() => { setMode('existing'); setDirty(true) }} />
            <strong>Use existing business number</strong><span>Keep your number. Activate forwarding with your carrier.</span></label>
          <label className={mode === 'new' ? 'phoneOption selected' : 'phoneOption'}><input type="radio" name="phoneMode" checked={mode === 'new'} onChange={() => { setMode('new'); setDirty(true) }} />
            <strong>Use a Recepta number</strong><span>Share the assigned AI number as your public business line.</span></label>
        </div>
        {mode === 'existing' ? <>
          <label className="phoneLabel">Existing business phone number<input type="tel" autoComplete="tel" placeholder="+1 416 555 0123" value={business} onChange={e => { setBusiness(e.target.value); setDirty(true) }} /></label>
          <p className="phoneMuted">Verify this line before activating forwarding. For a landline or VoIP phone, choose a voice verification call.</p>
          <VerifyNumber purpose="business" number={business} verified={verified('business', business)} disabled={!editable} available={account.verificationAvailable} run={run} />
          <div className="phoneGrid"><label className="phoneLabel">Carrier<select value={carrier} onChange={e => { setCarrier(e.target.value); setDirty(true) }}><option value="rogers">Rogers</option><option value="bell">Bell</option><option value="telus">TELUS</option><option value="other">Other / hosted provider</option></select></label>
            <label className="phoneLabel">Line type<select value={lineType} onChange={e => { setLineType(e.target.value as typeof lineType); setDirty(true) }}><option value="mobile">Cellphone</option><option value="landline">Landline</option><option value="voip">VoIP / PBX</option></select></label></div>
          <div className="phoneGuide"><strong>{guide.title}</strong><p>Entering your number here does not redirect calls. You must activate forwarding with your carrier. Your original number stays with that carrier.</p>
            {assigned ? <ol>{guide.steps.map(step => <li key={step}>{step}</li>)}</ol> : <p>Wait for your Recepta number before activating forwarding.</p>}
            <p>{guide.note}</p><a href={guide.url} target="_blank" rel="noopener noreferrer">Official carrier instructions ↗</a>
            <p className="phoneMuted">Carrier forwarding and long-distance charges may apply. SMS to the original business number is not forwarded. For missed-call forwarding, use the carrier’s conditional options and check voicemail compatibility.</p>
          </div>
        </> : <div className="phoneGuide"><strong>{assigned ? 'Your number is ready to publish after a call test.' : 'Your number will appear here after assignment.'}</strong><p>Use your assigned Recepta number on your website, Google Business Profile, and business cards. New number purchases follow the existing paid Checkout and provisioning process.</p><a href="/dashboard/billing">Review your plan and number configuration in Billing <ArrowRight size={14} aria-hidden="true" /></a></div>}
      </fieldset>
      <fieldset disabled={!editable}><legend><span className="phoneStep">02</span> A human when needed</legend>
        <label className="phoneCheck phoneToggle"><input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); setDirty(true) }} /><strong>Enable live transfer to a worker</strong></label>
        <p>The AI answers first. When a caller wants a person, has an urgent concern, or needs more help, it offers a warm handoff and privately briefs the receiving worker. An unanswered or failed handoff returns to callback collection when the provider allows.</p>
        <label className="phoneLabel">Worker or front-desk direct number<input type="tel" autoComplete="off" placeholder="+1 647 555 0189" value={worker} onChange={e => { setWorker(e.target.value); setAuthorized(false); setDirty(true) }} /></label>
        <VerifyNumber purpose="worker" number={worker} verified={verified('worker', worker)} disabled={!editable} available={account.verificationAvailable} run={run} />
        <div className="phoneWarning"><AlertTriangle size={17} aria-hidden="true" /><span>Use a separate direct line. A business number that forwards to Recepta can create a call loop. Verify that the worker’s own carrier forwarding is off.</span></div>
        <label className="phoneCheck"><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} />The worker authorizes these calls, and this line does not forward to Recepta.</label>
      </fieldset>
      <div className="phoneActions"><button type="button" className="btn btnPrimary" disabled={!editable || !account.agent?.retell_agent_id || (enabled && (!verified('worker', worker) || !authorized)) || (mode === 'existing' && !verified('business', business))}
        onClick={() => { void perform({ action: 'save', mode, businessNumber: business, carrier, lineType, workerNumber: worker, transferEnabled: enabled, directLineAuthorized: authorized, expectedRevision: account.settings?.revision ?? 0 }) }}>{busy ? 'Working…' : 'Save & Sync with Agent'}</button>
        {account.destination?.enabled && <button type="button" className="btn btnOutline" disabled={busy} onClick={() => { void perform({ action: 'disable' }) }}>Disable transfers now</button>}
        <button type="button" className="btn btnOutline" disabled={busy || !assigned} onClick={() => { void perform({ action: 'check-connection' }) }}>Check number connection</button>
      </div>
      <p className="phoneMuted">{dirty ? 'You have unsaved changes. Save and sync before testing.' : account.settings?.sync_state === 'synced' ? 'Agent sync complete. A real phone call is still needed to verify behavior.' : account.settings?.sync_state === 'error' ? 'Agent sync needs attention. Save and sync again; transfers remain unavailable until it succeeds.' : 'Save and sync to finish setup.'} Store hours continue to be managed by Recepta.</p>
      <div className="phoneTest"><h3><span className="phoneStep">03</span> Test before your first customer call</h3>
        <ol><li>From a different phone, call {mode === 'existing' ? 'your original business number after activating forwarding' : 'your Recepta number'}. Confirm the right AI answers.</li>
          <li>Ask a business question, then ask for a human. The worker should hear the private brief and speak with the caller. Caller and worker need separate phones for this test.</li>
          <li>Repeat while the worker leaves the call unanswered, rejects it, and has voicemail enabled. Confirm callback details are collected. Check the call and handoff outcome in Calls.</li></ol>
        <p>Test confirmations below are reported by you. They do not prove carrier activation or replace real-call checks.</p>
        <div className="phoneActions"><button type="button" className="btn btnOutline" disabled={busy || dirty || !account.paid || account.settings?.sync_state !== 'synced' || !assigned}
          onClick={() => { void perform({ action: 'confirm-test', kind: 'reception', confirmed: true, expectedRevision: account.settings?.revision }) }}>{tested ? 'Reception test confirmed by you' : 'I tested reception successfully'}</button>
          {account.destination?.enabled && <button type="button" className="btn btnOutline" disabled={busy || dirty || !account.paid || account.settings?.sync_state !== 'synced'} onClick={() => { void perform({ action: 'confirm-test', kind: 'transfer', confirmed: true, expectedRevision: account.settings?.revision }) }}>{!dirty && account.settings?.transfer_tested_at ? 'Transfer test confirmed by you' : 'I tested the human handoff'}</button>}</div>
      </div>
      <details className="phoneDisconnect"><summary>Disconnecting, changing providers, or cancelling?</summary><p>Before your service ends, deactivate forwarding with your original carrier so calls ring your business normally. Recepta cannot switch off a carrier’s forwarding remotely.</p>
        <p>{guide.cancel}</p><p>Test your original number after deactivation and restore voicemail if needed. Cancel billing separately in Billing. A cancelled or expired service cannot answer new AI calls; saved dashboard pages remain available. Existing-number service stays with your carrier. A Recepta-provided number is subject to its billing and release terms.</p></details>
    </>}
  </section>
}
