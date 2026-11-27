import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

test('actual usage only: unfinished calls never reserve customer allowance', async () => {
  const db = new PGlite()
  const client = '00000000-0000-0000-0000-000000000001'
  const other = '00000000-0000-0000-0000-000000000002'
  const grant = '00000000-0000-0000-0000-000000000003'
  const period = '2026-11-01T00:00:00Z'
  const end = '2026-12-01T00:00:00Z'
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.call_minute_reservations (
        client_id uuid, retell_call_id text, period_start timestamptz,
        reserved_seconds integer, used_seconds integer, status text, service_grant_id uuid
      );
      create table public.calls (
        client_id uuid, retell_call_id text, duration_seconds integer, started_at timestamptz
      );
    `)
    await db.exec(await readFile('supabase/migrations/20261127035712_meter_reported_call_usage_without_minute_holds.sql', 'utf8'))
    const usage = async () => {
      const { rows } = await db.query(`select
        public.recepta_committed_usage($1,$2,$3) as paid_usage,
        public.recepta_service_grant_usage($4,$2) as grant_period_usage,
        public.recepta_service_grant_usage($4) as grant_usage`, [client,period,end,grant])
      return Object.values(rows[0]).map(Number)
    }
    await db.query(`insert into public.call_minute_reservations values
      ($1,'call-one',$2,7200,null,'active',$3),
      ($1,'call-two',$2,7200,null,'active',$3)`, [client,period,grant])
    assert.deepEqual(await usage(), [0,0,0])
    await db.query("update public.call_minute_reservations set used_seconds=30,status='completed' where retell_call_id='call-one'")
    assert.deepEqual(await usage(), [30,30,30])
    await db.query("insert into public.calls values ($1,'call-one',30,$2),($1,'call-two',45,$2),($3,'call-one',999,$2)", [client,period,other])
    assert.deepEqual(await usage(), [75,75,75])
    await db.query("update public.call_minute_reservations set used_seconds=45,status='completed' where retell_call_id='call-two'")
    assert.deepEqual(await usage(), [75,75,75])
    await db.query("insert into public.calls values ($1,'unreserved-call',60,$2)", [client,period])
    assert.deepEqual(await usage(), [135,75,75])
  } finally {
    await db.close()
  }
})
