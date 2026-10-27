import { calculateMinuteBalance } from './minuteBalance'

export type NoticeSubscription = {
  status: string | null
  current_period_start?: string | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
}

export const billingAccessNotice = (subscription:NoticeSubscription|null,now=Date.now()) => {
  const paid=calculateMinuteBalance({ ...subscription,monthly_minutes:0,status:subscription?.status ?? null },0,now).paid
  if (paid) {
    if (!subscription?.cancel_at_period_end) return null
    return { title:'Cancellation scheduled',message:'Your receptionist remains available until the end of your paid billing period. Review Billing to manage your subscription.',action:'Review Billing' }
  }
  return {
    title:subscription?.status==='cancelled' ? 'Billing cancelled' : 'Payment required',
    message:'Your dashboard and pages remain available. Complete payment in Billing to use your AI receptionist.',
    action:'Review Billing & Pay',
  }
}
