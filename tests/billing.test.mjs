import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { calculateMinuteBalance } from '../src/lib/minuteBalance.ts'
import { getInvoicePeriod, getInvoiceSubscriptionId } from '../netlify/lib/billingPeriods.ts'

const subscription = {
  monthly_minutes: 1000, rollover_seconds: 400 * 60, status: 'active',
  current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-11-01T00:00:00Z',
}
const now = Date.parse('2026-10-11T00:00:00Z')

test('rollover is consumed before the new monthly allowance', () => {
  const balance = calculateMinuteBalance(subscription, 600 * 60, now)
  assert.equal(balance.rolloverRemainingSeconds, 0)
  assert.equal(balance.monthlyRemainingSeconds, 800 * 60)
  assert.equal(balance.remainingSeconds, 800 * 60)
})

test('unused old rollover expires; it never adds to next month rollover', () => {
  const balance = calculateMinuteBalance(subscription, 200 * 60, now)
  assert.equal(balance.rolloverRemainingSeconds, 200 * 60)
  assert.equal(balance.nextRolloverSeconds, 1000 * 60)
})

test('failed, cancelled, expired, and unconfigured subscriptions have no spendable minutes', () => {
  for (const status of ['past_due', 'cancelled', 'pending']) {
    assert.equal(calculateMinuteBalance({ ...subscription, status }, 0, now).remainingSeconds, 0)
  }
  assert.equal(calculateMinuteBalance(subscription, 0, Date.parse(subscription.current_period_end)).remainingSeconds, 0)
  assert.equal(calculateMinuteBalance({ ...subscription, current_period_start: null }, 0, now).paid, false)
})

test('balances are capped and retain partial minutes without granting extra time', () => {
  const balance = calculateMinuteBalance({ ...subscription, rollover_seconds: 120000 }, 120001, now)
  assert.equal(balance.totalSeconds, 120000)
  assert.equal(balance.remainingSeconds, 0)
  assert.equal(calculateMinuteBalance(subscription, 1, now).remainingSeconds, 83999)
})

test('Stripe subscription references support old and current invoice formats', () => {
  assert.equal(getInvoiceSubscriptionId({ subscription: 'sub_test' }), 'sub_test')
  assert.equal(getInvoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: 'sub_test' } } } }), 'sub_test')
  assert.equal(getInvoiceSubscriptionId({}), null)
})

test('a paid invoice uses its own recurring period and ignores prorations and unrelated lines', () => {
  const period = { start: 1790812800, end: 1793491200 }
  const lines = [
    { type: 'invoiceitem', period },
    { type: 'subscription', subscription: 'sub_test', proration: true, period },
    { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_other', proration: false } }, period },
    { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_test', proration: false } }, period },
  ]
  assert.deepEqual(getInvoicePeriod(lines, 'sub_test'), {
    start: new Date(period.start * 1000).toISOString(), end: new Date(period.end * 1000).toISOString(),
  })
  assert.throws(() => getInvoicePeriod(lines.slice(0, 3), 'sub_test'))
})

test('PostgreSQL migration: paid cycles, replay protection, >1000 calls, Checkout, and notification leases', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      set timezone = 'UTC';
      create role service_role bypassrls;
      create role anon;
      create role authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.clients (id uuid primary key);
      create table public.subscriptions (
        id uuid primary key default gen_random_uuid(),
        client_id uuid not null references public.clients,
        stripe_subscription_id text, stripe_customer_id text,
        plan_name text, monthly_price numeric, monthly_minutes integer,
        ai_model_id text, pii_redaction_enabled boolean, safety_guardrails_enabled boolean,
        extra_phone_numbers integer, status text,
        current_period_start timestamptz, current_period_end timestamptz,
        next_billing_date timestamptz
      );
      create table public.calls (client_id uuid, duration_seconds integer, started_at timestamptz,
        retell_call_id text, call_status text, ended_at timestamptz);
    `)
    await db.exec(await readFile(new URL('../supabase_add_minute_enforcement.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../supabase_add_billing_notifications.sql', import.meta.url), 'utf8')
    await db.exec(migration)
    await db.exec(migration) // repeat-safe deployment
    await db.exec(await readFile(new URL('../supabase/migrations/20261014192813_align_minute_enforcement.sql', import.meta.url), 'utf8'))
    const client = '00000000-0000-0000-0000-000000000001'
    await db.query('insert into clients values ($1)', [client])
    await db.query(`insert into subscriptions (client_id, stripe_subscription_id, monthly_minutes, status,
      current_period_start, current_period_end, rollover_seconds)
      values ($1, 'sub_test', 1000, 'active', '2026-10-01', '2026-11-01', 0)`, [client])
    await db.query(`insert into calls values ($1, 36000, '2026-10-12')`, [client])
    const renew = async (start, end) => (await db.query(
      `select * from renew_recepta_subscription('sub_test', $1::timestamptz, $2::timestamptz)`, [start, end])).rows
    let rows = await renew('2026-11-01', '2026-12-01')
    assert.equal(rows[0].rollover_seconds, 24000)
    rows = await renew('2026-11-01', '2026-12-01')
    assert.equal(rows[0].rollover_seconds, 24000, 'a duplicate grants no extra rollover')
    await db.query(`insert into calls values ($1, 12000, '2026-11-12')`, [client])
    rows = await renew('2026-12-01', '2027-01-01')
    assert.equal(rows[0].rollover_seconds, 60000, 'old unused 200 minutes expire')
    assert.equal((await renew('2026-11-01', '2026-12-01')).length, 0, 'old invoices cannot rewind the cycle')
    await db.exec(`update subscriptions set status = 'past_due'`)
    rows = await renew('2026-12-01', '2027-01-01')
    assert.equal(rows[0].status, 'active', 'successful retry restores paid access')
    assert.equal(rows[0].rollover_seconds, 60000)
    rows = await renew('2027-02-01', '2027-03-01')
    assert.equal(rows[0].rollover_seconds, 0, 'a skipped billing cycle forfeits the old minutes')

    await db.query(`insert into calls select $1::uuid, 60, '2027-02-12'::timestamptz from generate_series(1, 1500)`, [client])
    assert.equal((await db.query(`select recepta_period_usage($1, '2027-02-01', '2027-03-01') as used`, [client])).rows[0].used, 90000)
    rows = await renew('2027-03-01', '2027-04-01')
    assert.equal(rows[0].rollover_seconds, 0, 'usage aggregation is not truncated at an API row limit')

    const activate = async (id, replaces) => (await db.query(`select * from activate_recepta_checkout(
      $1, $2, 'cus_test', '2027-03-15', '2027-04-15', '{"monthly_minutes":500}', $3)`, [client, id, replaces])).rows
    rows = await activate('sub_new', 'sub_test')
    assert.equal(rows[0].rollover_seconds, 30000, 'a paid replacement carries only fresh unused allowance, capped to the new plan')
    await db.query(`insert into calls values ($1, 600, '2027-03-16')`, [client])
    rows = await activate('sub_new', 'sub_test')
    assert.equal(rows[0].current_period_start.toISOString(), '2027-03-15T00:00:00.000Z')
    assert.equal((await activate('sub_stale', 'sub_test')).length, 0, 'a stale Checkout cannot replace the new subscription')
    assert.equal((await db.query(`select recepta_period_usage($1, '2027-03-15', '2027-04-15') as used`, [client])).rows[0].used, 600)

    await db.query(`insert into billing_notifications(notification_key, client_id, kind, payload)
      values ('paid:invoice_test', $1, 'payment_success', '{}') on conflict do nothing`, [client])
    await db.query(`insert into billing_notifications(notification_key, client_id, kind, payload)
      values ('paid:invoice_test', $1, 'payment_success', '{}') on conflict do nothing`, [client])
    assert.equal((await db.query('select * from claim_recepta_billing_notifications(5)')).rows.length, 1)
    assert.equal((await db.query('select * from claim_recepta_billing_notifications(5)')).rows.length, 0, 'leased notices cannot be claimed concurrently')
    await db.exec(`update billing_notifications set last_attempt_at = now() - interval '11 minutes'`)
    assert.equal((await db.query('select * from claim_recepta_billing_notifications(5)')).rows.length, 1, 'failed delivery is retried')
    await db.exec(`update billing_notifications set sent_at = now()`)
    assert.equal((await db.query('select * from claim_recepta_billing_notifications(5)')).rows.length, 0)
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query(`select renew_recepta_subscription('sub_test', '2027-04-01', '2027-05-01')`), /permission denied/)
      await assert.rejects(db.query(`select * from activate_recepta_checkout($1, 'sub_denied', 'cus_test', '2027-04-01', '2027-05-01', '{}', null)`, [client]), /permission denied/)
      await assert.rejects(db.query(`select recepta_period_usage($1, '2027-04-01', '2027-05-01')`, [client]), /permission denied/)
      await assert.rejects(db.query('select * from claim_recepta_billing_notifications(5)'), /permission denied/)
      await assert.rejects(db.query(`select * from reserve_recepta_call($1, 60000, '2027-04-01')`, [client]), /permission denied/)
      await assert.rejects(db.query('select * from billing_notifications'), /permission denied/)
      await assert.rejects(db.query('select * from call_minute_reservations'), /permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    assert.equal((await db.query(`select recepta_period_usage($1, '2027-03-15', '2027-04-15') as used`, [client])).rows[0].used, 600)
  } finally { await db.close() }
})
