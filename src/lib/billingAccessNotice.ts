import type { CustomerService } from './serviceAccess'
import { calculateMinuteBalance } from './minuteBalance'

export type NoticeSubscription = {
  status: string | null
  current_period_start?: string | null
  current_period_end?: string | null
  cancel_at_period_end?: boolean
}

export const billingAccessNotice = (subscription: NoticeSubscription | null, now = Date.now(), service?: CustomerService | null) => {
  if (service?.service_status === 'ongoing') return null
  if (service?.service_status === 'paused') {
    const message = service.reason === 'payment_failed'
      ? 'Your latest subscription payment failed. Complete payment in Billing to resume calls and appointments. Your AI agent is retained until the scheduled deadline.'
      : service.retention_operation === 'deleted'
      ? 'Your previous AI agent was removed. Reactivate your subscription to set up a replacement with your saved settings.'
      : service.retention_deadline
        ? service.retention_reason === 'cancellation'
          ? 'Your AI receptionist is currently paused. Reactivate your subscription within 30 days to keep your existing AI agent. See the scheduled date below.'
          : 'Your AI receptionist is currently paused. Reactivate your subscription before deletion to keep your existing AI agent.'
        : service.reason === 'provisioning' || service.retention_operation === 'restoring'
          ? 'Your workspace is available while Recepta sets up your AI receptionist.'
          : 'Your AI receptionist is currently paused. Open Billing to review reactivation options.'
    return { title:'AI Receptionist Paused',message,
      action: service.reason === 'provisioning' || service.retention_operation === 'restoring' ? null : 'Reactivate subscription' }
  }
  if (service?.reason === 'subscription_cancelled' || subscription?.status === 'cancelled') {
    return {
      title: 'AI receptionist paused',
      message: 'Your AI receptionist is paused because your subscription was cancelled. Reactivate your subscription to resume service.',
      action: 'Reactivate subscription',
    }
  }
  if (service?.reason === 'provisioning') {
    return service.provisioning_status === 'needs_attention'
      ? { title: 'Setup needs attention', message: 'Recepta is reviewing your AI receptionist setup.', action: null }
      : { title: 'Configuring your AI receptionist', message: 'Your workspace is available while Recepta verifies your agent and phone routing.', action: null }
  }
  if (service && ['paused', 'suspended', 'unavailable', 'expired'].includes(service.status)) {
    return { title: 'AI receptionist unavailable', message: 'Your dashboard and history are available. Contact Recepta about your service status.', action: null }
  }
  if (service?.source === 'automatic_pro' && service.status === 'active') {
    return service.reason === 'allowance_unavailable'
      ? { title: 'Minute limit reached', message: 'New calls resume when your allowance resets or you add minutes through Billing.', action: 'Open Billing' }
      : null
  }
  if (service?.status === 'active' && service.source !== 'stripe') return null
  const paid=calculateMinuteBalance({ ...subscription,monthly_minutes:0,status:subscription?.status ?? null },0,now).paid
  if (paid) {
    if (!subscription?.cancel_at_period_end) return null
    return { title:'Cancellation scheduled',message:'Your receptionist remains available until the end of your paid billing period. Review Billing to manage your subscription.',action:'Review Billing' }
  }
  return {
    title:'Payment required',
    message:'Your dashboard and pages remain available. Complete payment in Billing to use your AI receptionist.',
    action:'Review Billing & Pay',
  }
}
