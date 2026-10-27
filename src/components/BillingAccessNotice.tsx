import { useEffect, useState } from 'react'
import { fetchBillingStatus } from '../lib/billing'
import { billingAccessNotice, type NoticeSubscription } from '../lib/billingAccessNotice'

export default function BillingAccessNotice({ subscription }: { subscription?:NoticeSubscription|null }) {
  const [loaded,setLoaded]=useState<NoticeSubscription|null|undefined>(undefined)
  const [error,setError]=useState('')
  useEffect(()=>{
    if (subscription!==undefined) return
    let active=true
    const load=async()=>{
      try {
        const result=await fetchBillingStatus()
        if (active) { setLoaded(result.subscription);setError('') }
      } catch { if (active) setError('Billing status could not be checked. Open Billing to review your account.') }
    }
    void load()
    const timer=window.setInterval(()=>void load(),30000)
    return ()=>{active=false;window.clearInterval(timer)}
  },[subscription])
  const current=subscription===undefined ? loaded : subscription
  if (error) return <p className="calendarAlert" role="status">{error} <a href="/dashboard/billing">Open Billing</a></p>
  if (current===undefined) return null
  const notice=billingAccessNotice(current)
  if (!notice) return null
  return <section className="calendarAlert" role="status" aria-label="Billing status" style={{ marginBottom:24 }}>
    <strong>{notice.title}</strong>
    <p>{notice.message}</p>
    <a className="btn btnOutline" href="/dashboard/billing" style={{ marginTop:12 }}>{notice.action}</a>
  </section>
}
