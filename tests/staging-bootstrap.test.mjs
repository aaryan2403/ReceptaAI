import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const one = '00000000-0000-0000-0000-000000000101'
const two = '00000000-0000-0000-0000-000000000102'
const administrator = '00000000-0000-0000-0000-000000000103'
const bootstrap = await readFile('supabase/staging/bootstrap.sql', 'utf8')
const phone = await readFile('supabase/migrations/20261102183345_phone_setup_verified_transfers.sql', 'utf8')
const singleAgent = await readFile('supabase/migrations/20261105023555_require_single_customer_agent.sql', 'utf8')
const catalog = await readFile('supabase/staging/seed_catalog.sql', 'utf8')
let db

test.before(async () => {
  db = new PGlite()
  // Hosted Supabase owns Auth and the extensions. These minimal built-ins let
  // the real application SQL run locally without copying any Auth users.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb; $$;
    grant usage on schema auth to anon,authenticated,service_role;`)
  await db.exec(bootstrap.replace(/^create extension[^\n]+;$/gm, ''))
  await db.exec(phone)
  await db.exec(singleAgent)
  await db.exec(await readFile('supabase/migrations/20261105025833_phone_transfer_schedules_and_call_tests.sql', 'utf8'))
  await db.exec(catalog)
  await db.exec(await readFile('supabase/migrations/20261105030353_paid_reception_provisioning.sql', 'utf8'))
 await db.exec(await readFile('supabase/migrations/20261107051800_selected_twilio_numbers.sql', 'utf8'))
  await db.exec(await readFile('supabase/migrations/20261107004145_self_service_phone_onboarding.sql', 'utf8'))
  await db.query('insert into auth.users values ($1),($2),($3)', [one, two, administrator])
  await db.query(`insert into clients(id,company_name,contact_email,role) values
    ($1,'North fixture','north@example.test','client'),
    ($2,'South fixture','south@example.test','client'),
    ($3,'Admin fixture','admin@example.test','admin')`, [one, two, administrator])
  await db.query("insert into agents(client_id,retell_agent_id) values ($1,'agent_fixture_north'),($2,'agent_fixture_south')", [one, two])
})
test.after(async () => { await db?.close() })

const asCustomer = async (id, run) => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id])
  await db.exec('set role authenticated')
  try { return await run() } finally { await db.exec('reset role') }
}

test('fresh staging bootstrap supports the phone migration and enables RLS on all application tables', async () => {
  const tables = (await db.query(`select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relkind='r'`)).rows
  assert.equal(tables.length, 38)
  assert.ok(tables.every(t => t.relrowsecurity))
  assert.ok(tables.some(t => t.relname === 'phone_setups'))
  assert.ok(tables.some(t => t.relname === 'call_notifications'))
})

test('bootstrap refuses an existing application database without changing its rows', async () => {
  await assert.rejects(db.exec('begin;\n' + bootstrap + '\ncommit;'), /requires an empty application schema/)
  await db.exec('rollback')
  assert.equal((await db.query('select count(*)::int n from clients')).rows[0].n, 3)
})

test('real dashboard policies isolate customers, preserve admin access and prevent role escalation', async () => {
  await asCustomer(one, async () => {
    assert.deepEqual((await db.query('select client_id from agents')).rows, [{ client_id: one }])
    assert.deepEqual((await db.query('select id from clients')).rows, [{ id: one }])
    await assert.rejects(db.query("update clients set role='admin' where id=$1 returning id", [one]), /permission denied/)
  })
  await asCustomer(two, async () => {
    assert.deepEqual((await db.query('select client_id from agents')).rows, [{ client_id: two }])
  })
  await asCustomer(administrator, async () => {
    assert.equal((await db.query('select id from clients')).rows.length, 3)
  })
  assert.equal((await db.query('select role from clients where id=$1', [one])).rows[0].role, 'client')
})

test('phone verification and mutation RPCs remain server-only on the complete staging schema', async () => {
  await asCustomer(one, async () => {
    await assert.rejects(db.query('select * from phone_verified_numbers'), /permission denied/)
    await assert.rejects(db.query('select disable_recepta_phone_transfer($1)', [two]), /permission denied/)
  })
  await db.exec('set role anon')
  try { await assert.rejects(db.query('select * from clients'), /permission denied/) }
  finally { await db.exec('reset role') }
  await db.exec('set role service_role')
  try {
    await db.query("insert into phone_verified_numbers(client_id,purpose,phone_number,verified_at) values ($1,'worker','+14165550123',now())", [one])
    const saved = await db.query('select save_recepta_phone_setup($1,0,$2::jsonb) revision', [one, JSON.stringify({
      mode: 'new', enabled: true, worker_number: '+14165550123', carrier: 'other', line_type: 'mobile', agent_id: 'agent_fixture_north',
    })])
    assert.equal(saved.rows[0].revision, 1)
    assert.deepEqual((await db.query('select client_id,enabled from phone_transfer_destinations')).rows, [{ client_id: one, enabled: true }])
  } finally { await db.exec('reset role') }
})


test('existing phone pair links atomically on the real schema and cannot duplicate customer agents', async () => {
  await db.exec('set role service_role')
  try {
    await db.query("select link_recepta_phone_pair($1,'agent_fixture_south','+16475550102')", [two])
    await db.query("select link_recepta_phone_pair($1,'agent_fixture_south','+16475550102')", [two])
    assert.deepEqual((await db.query('select phone_number from agents where client_id=$1', [two])).rows,
      [{ phone_number: '+16475550102' }])
    assert.equal((await db.query('select count(*)::int n from agent_phone_numbers where client_id=$1', [two])).rows[0].n, 1)
    await assert.rejects(db.query("insert into agents(client_id,retell_agent_id) values ($1,'agent_duplicate_fixture')", [two]), /recepta_single_agent_per_client/)
    await assert.rejects(db.query("select link_recepta_phone_pair($1,'agent_fixture_south','+16475550102')", [one]), /already assigned/)
  } finally { await db.exec('reset role') }
})


test('public product catalog is available to customers and seeding never overwrites prices', async () => {
  await asCustomer(one, async () => {
    assert.equal((await db.query('select id from ai_models where is_active')).rows.length, 4)
  })
  const before = (await db.query('select id,customer_price_per_minute_cad from ai_models order by id')).rows
  await assert.rejects(db.exec('begin;\n' + catalog + '\ncommit;'), /requires an empty model catalog/)
  await db.exec('rollback')
  assert.deepEqual((await db.query('select id,customer_price_per_minute_cad from ai_models order by id')).rows, before)
})

test('verified customer initialization is atomic, pending, and idempotent, with server-only phone audit', async () => {
  const id = '00000000-0000-0000-0000-000000000104'
  const query = "select initialize_recepta_customer($1,'new@example.test','New business','Recepta Standard') as created"
  await db.query('insert into auth.users values ($1)', [id])
  await asCustomer(one, async () => {
    await assert.rejects(db.query(query, [id]), /permission denied/)
    await assert.rejects(db.query('select * from phone_operation_audit'), /permission denied/)
  })
  await db.exec('set role service_role')
  try {
    assert.equal((await db.query(query, [id])).rows[0].created, true)
    assert.equal((await db.query(query, [id])).rows[0].created, false)
    const result = await db.query('select status, monthly_price, stripe_subscription_id from subscriptions where client_id=$1', [id])
    assert.deepEqual(result.rows, [{ status: 'pending', monthly_price: '249.10', stripe_subscription_id: null }])
    assert.equal((await db.query('select retell_agent_id from agents where client_id=$1', [id])).rows[0].retell_agent_id, null)
    await db.query("insert into agent_phone_numbers(client_id,phone_number,source,is_primary) values($1,'+14165550114','manual',true)", [id])
    await db.query('delete from clients where id=$1', [id])
    const audit = await db.query('select action from phone_operation_audit where client_id=$1 order by id', [id])
    assert.deepEqual(audit.rows, [{ action: 'insert' }, { action: 'delete' }])
  } finally {
    await db.exec('reset role')
    await db.query('delete from auth.users where id=$1', [id])
  }
})
