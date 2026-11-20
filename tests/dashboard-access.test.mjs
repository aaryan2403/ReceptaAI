import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result=await build({entryPoints:['src/lib/billingAccessNotice.ts'],bundle:true,platform:'node',format:'esm',write:false})
const {billingAccessNotice}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
const now=Date.now()
const period={current_period_start:new Date(now-86400000).toISOString(),current_period_end:new Date(now+86400000).toISOString()}

test('cancelled and unpaid customers retain their workspace with a payment notice',()=>{
 for(const subscription of [null,{status:'pending'},{status:'cancelled',...period},{status:'past_due',...period}]){
  const notice=billingAccessNotice(subscription,now)
  assert.ok(notice)
  assert.match(notice.message,subscription?.status==='cancelled' ? /reactivate your subscription/i : /dashboard and pages remain available/)
  if (subscription?.status !== 'cancelled') assert.match(notice.message,/Complete payment in Billing to use/)
  assert.equal(notice.action,subscription?.status==='cancelled' ? 'Reactivate subscription' : 'Review Billing & Pay')
 }
 assert.equal(billingAccessNotice({status:'cancelled',...period},now).title,'AI receptionist paused')
})

test('paid service is not blocked, including a cancellation scheduled for period end',()=>{
 assert.equal(billingAccessNotice({status:'active',...period},now),null)
 const scheduled=billingAccessNotice({status:'active',...period,cancel_at_period_end:true},now)
 assert.equal(scheduled.title,'Cancellation scheduled')
 assert.match(scheduled.message,/remains available until the end/)
 assert.equal(scheduled.action,'Review Billing')
})

test('an expired or unverified paid period requires payment even if status still says active',()=>{
 for(const period of [{},{current_period_end:new Date(now-1).toISOString()},
  {current_period_start:new Date(now+1000).toISOString(),current_period_end:new Date(now+86400000).toISOString()}]){
  assert.equal(billingAccessNotice({status:'active',...period},now).action,'Review Billing & Pay')
 }
})

test('automatically authorized pending Pro customers see their service status instead of a payment warning', () => {
  const pending = { status: 'pending' }
  const active = { status: 'active', reason: 'ready', source: 'automatic_pro' }
  assert.equal(billingAccessNotice(pending, now, active), null)
  assert.equal(billingAccessNotice(pending, now, { ...active, reason: 'allowance_unavailable' }).title, 'Minute limit reached')
  assert.equal(billingAccessNotice(pending, now, { status: 'pending', reason: 'provisioning', provisioning_status: 'queued' }).title, 'Configuring your AI receptionist')
})
