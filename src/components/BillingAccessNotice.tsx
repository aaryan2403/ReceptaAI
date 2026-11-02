import { useEffect, useState } from 'react'
import { fetchBillingStatus } from '../lib/billing'
import { billingAccessNotice, type NoticeSubscription } from '../lib/billingAccessNotice'
import './BillingAccessNotice.css'

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
  const notice=error
    ? { title:'Billing status unavailable',message:error,action:'Open Billing' }
    : current===undefined ? null : billingAccessNotice(current)
  if (!notice) return null
  return <section className={`billingAccessNotice${error ? ' billingAccessNotice--error' : ''}`} role="status" aria-label="Billing status">
    <span className="billingAccessNoticeIcon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 3.9 2.5 17.5a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    </span>
    <div className="billingAccessNoticeContent">
      <strong>{notice.title}</strong>
      <p>{notice.message}</p>
    </div>
    <a className="btn billingAccessNoticeAction" href="/dashboard/billing">{notice.action}<span aria-hidden="true">→</span></a>
  </section>
}
