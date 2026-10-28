import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
export default function ProBookingsNavItem({active=false}:{active?:boolean}) {
  const [isPro,setIsPro]=useState(false)
  useEffect(()=>{
    let mounted=true
    void (async()=>{
      const {data:{user}}=await supabase.auth.getUser()
      if (!user) return
      const {data,error}=await supabase.from('subscriptions').select('plan_name').eq('client_id',user.id).maybeSingle()
      if (mounted&&!error) setIsPro(data?.plan_name==='Recepta Pro')
    })().catch(()=>{})
    return ()=>{mounted=false}
  },[])
  return isPro?<a href="/dashboard/bookings" className={`dashboardNavItem${active?' dashboardNavItemActive':''}`}>Bookings</a>:null
}
