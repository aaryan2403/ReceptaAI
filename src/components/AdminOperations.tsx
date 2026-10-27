import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

type AlertRow={ notification_key?:string;job_key?:string;client_id:string;kind?:string;status?:string;delivery_status?:string;last_error:string|null;attempts:number }
type Client={ id:string;company_name:string|null;call_retention_days:number;deletion_pending:boolean }
type Operations={ jobs:AlertRow[];callAlerts:AlertRow[];billingAlerts:AlertRow[];clients:Client[];configuration:{ emailSending:boolean;deliveryTracking:boolean;retell:boolean;stripe:boolean } }

export default function AdminOperations() {
  const [data,setData]=useState<Operations|null>(null)
  const [error,setError]=useState('')
  const [actionError,setActionError]=useState('')
  const [message,setMessage]=useState('')
  const [connecting,setConnecting]=useState(false)
  const [busy,setBusy]=useState(false)
  const actionInFlight=useRef(false)
  const refreshVersion=useRef(0)
  const [selected,setSelected]=useState('')
  const [days,setDays]=useState('90')
  const request=useCallback(async (body?:Record<string,unknown>) => {
    const { data:{ session } }=await supabase.auth.getSession()
    if (!session) throw new Error('Please sign in again.')
    let response:Response
    try {
      response=await fetch('/.netlify/functions/admin-operations',{ method:body ? 'POST':'GET',signal:AbortSignal.timeout(20000),headers:{ Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json' },...(body ? { body:JSON.stringify(body) }: {}) })
    } catch {
      throw new Error('Could not reach Recepta. Check your connection and try again. If setup timed out, refresh to check whether it completed before retrying.')
    }
    const result=await response.json().catch(()=>{ throw new Error('Recepta returned an unexpected response. Refresh the page and try again.') })
    if (!response.ok) throw new Error(result.error || 'Could not load operations.')
    return result as Operations
  },[])
  useEffect(() => {
    const load=async () => {
      if (actionInFlight.current) return
      const version=refreshVersion.current
      try {
        const result=await request()
        if (version===refreshVersion.current) { setData(result);setError('') }
      } catch(failure) { if (version===refreshVersion.current) setError(failure instanceof Error ? failure.message : 'Could not load operations.') }
    }
    void load()
    const timer=window.setInterval(load,30000)
    return ()=>window.clearInterval(timer)
  },[request])
  const action=async (body:Record<string,unknown>) => {
    if (actionInFlight.current) return
    actionInFlight.current=true
    refreshVersion.current+=1
    const isConnecting=body.action==='connect_email_tracking'
    setBusy(true);setConnecting(isConnecting);setActionError('');setMessage(isConnecting ? 'Connecting email delivery tracking…' : 'Saving…')
    try {
      const result=await request(body)
      setData(result);setError('')
      if (isConnecting && !result.configuration.deliveryTracking) throw new Error('Setup finished without confirming a connection. Please try again.')
      setMessage(isConnecting ? 'Email delivery tracking connected. Future delivery updates will appear here.' : body.action==='retention' ? 'Call content retention saved.' : 'Cleanup queued to resume.')
    } catch(failure) { setMessage('');setActionError(failure instanceof Error ? failure.message : 'Operation failed.') }
    finally { actionInFlight.current=false;setBusy(false);setConnecting(false) }
  }
  const rows=[...(data?.jobs ?? []),...(data?.callAlerts ?? []).map(row=>({ ...row,kind:'Owner email' })),...(data?.billingAlerts ?? []).map(row=>({ ...row,kind:'Billing email' }))]
  return <section id="operations" className="agentPanel" style={{ margin:'24px 0',padding:24,border:'1px solid #333',borderRadius:16 }}>
    <span className="adminEyebrow">OPERATIONS &amp; DELIVERY</span><h2>Failures that need attention</h2>
    <p>Provider cleanup and failed or delayed emails appear here. Email acceptance is separate from confirmed delivery. Each category shows its latest 50 matching records.</p>
    {error && <p role="alert">{error}</p>}
    {data && <>
      <p>Email sending: {data.configuration.emailSending ? 'configured':'missing'} · Delivery tracking: {data.configuration.deliveryTracking ? 'connected':'setup required'} · Retell: {data.configuration.retell ? 'configured':'missing'} · Stripe: {data.configuration.stripe ? 'configured':'missing'}</p>
      {!data.configuration.deliveryTracking && <>
        <button type="button" className="btn btnOutline" disabled={busy} aria-busy={connecting} onClick={()=>void action({ action:'connect_email_tracking' })}>{connecting ? 'Connecting…' : 'Connect Email Delivery Tracking'}</button>
        <p>Connect Resend to confirm whether notification emails are delivered or bounced. Connection status appears below.</p>
      </>}
      {message && <p role="status">{message}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {!rows.length && <p>No queued cleanup jobs or recorded delivery failures.</p>}
      {rows.map(row=><article key={row.job_key ?? row.notification_key} style={{ padding:'16px 0',borderTop:'1px solid #333' }}>
        <strong>{data.clients.find(client=>client.id===row.client_id)?.company_name || 'Removed client'} · {row.kind?.replaceAll('_',' ')}</strong>
        <p>{row.delivery_status || row.status || 'Delivery pending'} · {row.attempts} attempts</p>
        {row.last_error && <p role="status">{row.last_error}</p>}
        {row.status==='needs_attention' && ['delete_client','retention_call'].includes(row.kind ?? '') && <button type="button" className="btn btnOutline" disabled={busy} onClick={()=>void action({ action:'retry_cleanup',jobKey:row.job_key })}>Resume Cleanup</button>}
      </article>)}
      <h3>Call content retention</h3><p>Default: 90 days. Choose 7–365 days per client. Expired audio and transcripts are deleted at Retell before local content is erased. Duration and billing records remain. Cleanup failures stay visible above.</p>
      <div style={{ display:'flex',flexWrap:'wrap',gap:12 }}>
        <label><span>Client </span><select value={selected} onChange={event=>{setSelected(event.target.value);setDays(String(data.clients.find(client=>client.id===event.target.value)?.call_retention_days ?? 90))}}><option value="">Select a client</option>{data.clients.filter(client=>!client.deletion_pending).map(client=><option key={client.id} value={client.id}>{client.company_name || client.id}</option>)}</select></label>
        <label><span>Retention days </span><input type="number" min={7} max={365} value={days} onChange={event=>setDays(event.target.value)} style={{ width:90 }} /></label>
        <button type="button" className="btn btnOutline" disabled={busy || !selected} onClick={()=>void action({ action:'retention',clientId:selected,days:Number(days) })}>Save Retention</button>
      </div>
    </>}
  </section>
}
