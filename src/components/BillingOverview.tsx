import { ArrowUpRight, Clock3, RotateCcw } from 'lucide-react'
import { useRef } from 'react'
import type { BillingSubscription, MinuteBalance } from '../lib/billing'
import { formatMinuteSeconds } from '../lib/minuteBalance'
import type { CustomerService } from '../lib/serviceAccess'
import './BillingOverview.css'

type Timing = 'immediate' | 'period_end'
type Props = {
  subscription: BillingSubscription
  balance: MinuteBalance
  simulation: { asOf: string; balance: MinuteBalance } | null
  service: CustomerService | null
  managing: boolean
  onManage: () => void
  onCancel: (timing: Timing) => void
}

const dateLabel = (value: string, exact = false) => new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: exact ? 'long' : 'short', day: 'numeric',
  ...(exact ? { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } : {}),
}).format(new Date(value))

const statusLabels = {
  active: 'Active', past_due: 'Payment due', cancelled: 'Cancelled', pending: 'Setup pending',
}

export default function BillingOverview({ subscription, balance, simulation, service, managing, onManage, onCancel }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const status = subscription.status
  const metrics = simulation?.balance ?? balance
  const cancellationDate = subscription.provider_cancel_at ?? subscription.current_period_end
  const expiration = subscription.provider_cancel_at && subscription.current_period_end &&
    Date.parse(subscription.provider_cancel_at) < Date.parse(subscription.current_period_end)
    ? subscription.provider_cancel_at : subscription.current_period_end
  const scheduled = subscription.cancel_at_period_end && status !== 'cancelled'
  const nextPayment = scheduled ? cancellationDate : subscription.next_billing_date
  const monthlyPrice = subscription.monthly_price == null ? '—' : new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
  }).format(subscription.monthly_price)
  const buckets = [
    { key: 'consumed', label: 'Consumed', seconds: metrics.usedSeconds },
    { key: 'rollover', label: 'Rollover', seconds: metrics.rolloverRemainingSeconds },
    { key: 'monthly', label: 'Monthly', seconds: metrics.monthlyRemainingSeconds },
  ]
  const canCancel = subscription.stripe_subscription_id && ['active', 'past_due'].includes(status)

  return (
    <div className="billingOverview">
      {simulation && (
        <p className="billingClockNotice" role="status">
          <Clock3 size={16} aria-hidden="true" />
          <span><strong>Stripe Sandbox</strong> · Simulated balance as of {dateLabel(simulation.asOf, true)}.
            Real-time paid balance is {formatMinuteSeconds(balance.remainingSeconds)} min. Calls use real time.</span>
        </p>
      )}

      <div className="billingOverviewGrid">
        <section className="billingPanel billingBalancePanel" aria-labelledby="billing-balance-title">
          <h2 id="billing-balance-title">Available minutes</h2>
          <p className="billingMetric">
            <strong>{formatMinuteSeconds(metrics.remainingSeconds)}</strong><span>min</span>
          </p>
          {metrics.paid ? (
            <>
              <p className="billingPanelDetail">of {formatMinuteSeconds(metrics.totalSeconds)} min this billing cycle</p>
              <div className="billingSegmentTrack" aria-hidden="true">
                {buckets.filter(({ seconds }) => seconds > 0).map(({ key, seconds }) => (
                  <div key={key} className={`billingSegment billingSegment--${key}`}
                    style={{ flexGrow: Math.min(seconds, metrics.totalSeconds) }} />
                ))}
              </div>
              <dl className="billingSegmentLegend">
                {buckets.map(({ key, label, seconds }) => (
                  <div key={key}>
                    <dt><span className={`billingSegment billingSegment--${key}`} aria-hidden="true" />{label}</dt>
                    <dd>{formatMinuteSeconds(seconds)} min</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : <p className="billingPanelDetail">Minutes are available during a paid billing cycle.</p>}
        </section>

        <section className="billingPanel billingRolloverPanel" aria-labelledby="billing-rollover-title">
          <h2 id="billing-rollover-title"><RotateCcw size={18} aria-hidden="true" />Rollover minutes</h2>
          <p className="billingMetric">
            <strong>{formatMinuteSeconds(metrics.paid ? metrics.rolloverRemainingSeconds : 0)}</strong><span>min</span>
          </p>
          {metrics.paid && metrics.rolloverRemainingSeconds > 0 && expiration ? (
            <p className="billingRolloverExpiry">
              <Clock3 size={15} aria-hidden="true" />
              <span>Expires <time dateTime={expiration}>{dateLabel(expiration, true)}</time></span>
            </p>
          ) : <p className="billingPanelDetail">No rollover minutes available</p>}
          <p className="billingPanelDetail">Rollover minutes are used automatically before new monthly minutes. They carry forward for one paid cycle.</p>
        </section>
      </div>

      <section className="billingPanel billingSubscriptionPanel" aria-labelledby="billing-subscription-title">
        <div className="billingSubscriptionHeader">
          <div>
            <h2 id="billing-subscription-title">Current subscription</h2>
            <p className="billingPlanTitle">{subscription.plan_name || 'Recepta plan'}</p>
          </div>
          {subscription.stripe_subscription_id && (
            <button type="button" className="btn btnPrimary" onClick={onManage} disabled={managing}>
              Manage subscription <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          )}
        </div>

        <dl className="billingSubscriptionFacts">
          <div>
            <dt>Monthly price</dt>
            <dd>{monthlyPrice}{subscription.monthly_price != null && <span className="billingCurrency"> CAD</span>}</dd>
          </div>
          <div>
            <dt>Payment status</dt>
            <dd><span className={`billingPaymentStatus billingPaymentStatus--${status}`}>{statusLabels[status]}</span></dd>
          </div>
          <div>
            <dt>{scheduled ? 'Service ends' : status === 'past_due' ? 'Renewal due' : 'Next renewal'}</dt>
            <dd>{status === 'cancelled' || !nextPayment ? '—' : <time dateTime={nextPayment}>{dateLabel(nextPayment)}</time>}</dd>
          </div>
          {service?.service_status && <div>
            <dt>Receptionist</dt>
            <dd>{service.service_status === 'ongoing' ? 'Ongoing' : 'Paused'}</dd>
          </div>}
        </dl>

        <div className="billingSubscriptionFooter">
          <div className="billingPanelDetail">
            {scheduled && cancellationDate ? (
              <>Your plan ends on {dateLabel(cancellationDate)}. Any unused minutes expire on that date.</>
            ) : status === 'past_due' ? (
              <>Paid minutes are frozen until Stripe confirms payment.
                {service?.service_status === 'ongoing' && service.payment_grace_ends_at &&
                  <> Pro payment grace ends {dateLabel(service.payment_grace_ends_at, true)}.</>}
              </>
            ) : status === 'active' && <>Monthly payments are required even when you have rollover minutes.</>}
          </div>
          {canCancel && <button type="button" className="billingCancelLink" disabled={managing}
            onClick={() => dialog.current?.showModal()}>{scheduled ? 'Cancel immediately' : 'Cancel subscription'}</button>}
        </div>
      </section>

      <dialog className="billingCancelDialog" ref={dialog} aria-labelledby="billing-cancel-title" aria-describedby="billing-cancel-description">
        <form method="dialog" onSubmit={(event) => {
          const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')
          if (action === 'immediate' || action === 'period_end') onCancel(action)
        }}>
          <h2 id="billing-cancel-title">Cancel your subscription?</h2>
          <p id="billing-cancel-description">Your receptionist pauses when service ends. Unused monthly and rollover minutes are forfeited at that time. You can still view your call history.</p>
          <div className="billingDialogActions">
            <button type="submit" value="dismiss" className="btn btnOutline" autoFocus>Keep subscription</button>
            {!scheduled && <button type="submit" value="period_end" className="btn btnOutline">End at period close</button>}
            <button type="submit" value="immediate" className="btn billingCancelConfirm">Cancel immediately</button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
