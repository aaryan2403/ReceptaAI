import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

const compile = async (path) => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('retired calendar APIs cannot connect, reserve, or contact providers, even from stale tabs', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Retired booking must not call a provider.') }
  try {
    for (const name of ['bookings', 'google-calendar', 'retell-booking']) {
      const handler = (await compile(`netlify/functions/${name}.ts`)).default
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        const response = await handler(new Request('https://example.test', { method }))
        assert.equal(response.status, 410)
        const body = await response.json()
        assert.equal(body.success, false)
        assert.equal(body.enabled, false)
        assert.match(body.instruction, /recepta_save_appointment_details/)
        assert.match(body.instruction, /Do not claim a time was reserved/)
      }
    }
    const callback = (await compile('netlify/functions/google-calendar-callback.ts')).default
    const response = await callback(new Request('https://example.test/?code=stale&state=stale'))
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('Location'), '/dashboard/calls')
    assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/)
  } finally { globalThis.fetch = originalFetch }
})

test('agent resync removes live booking instructions and tools while preserving business instructions', async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.URL
  process.env.URL = 'https://example.test'
  let written
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path.startsWith('/list-agent-versions')) return Response.json({ items: [{ version: 1, is_published: true }] })
    if (path.startsWith('/create-agent-version')) return Response.json({ version: 2, response_engine: { type: 'retell-llm', llm_id: 'synthetic_llm', version: 2 } })
    if (path.startsWith('/get-retell-llm')) return Response.json({
      general_prompt: 'Keep existing business instructions.\n\n[RECEPTA MANAGED APPOINTMENT BOOKING]\nUse recepta_check_availability to check live capacity. Only booked confirms a reservation.\n\n[RECEPTA MANAGED EMPLOYEE AVAILABILITY]\nRetain staff instructions.',
      general_tools: ['recepta_check_availability', 'recepta_book_appointment', 'recepta_list_employees', 'recepta_save_appointment_details', 'custom_business_tool'].map(name => ({ type: 'custom', name })),
    })
    if (path.startsWith('/update-retell-llm')) written = JSON.parse(init.body)
    return Response.json({})
  }
  try {
    const { syncRetellSchedule } = await compile('netlify/lib/retell.ts')
    await syncRetellSchedule({ apiKey: 'synthetic', agentId: 'synthetic_agent', schedule: { mode: '24/7', timeZone: 'America/Toronto', hours: [] } })
    assert.deepEqual(written.general_tools.map(tool => tool.name), ['custom_business_tool', 'recepta_save_appointment_details'])
    assert.match(written.general_prompt, /Keep existing business instructions/)
    assert.match(written.general_prompt, /Retain staff instructions/)
    assert.match(written.general_prompt, /Never claim a date or time is booked or guaranteed/)
    assert.doesNotMatch(written.general_prompt, /check live capacity|Only booked confirms/)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.URL
    else process.env.URL = originalUrl
  }
})

test('database retirement blocks old booking access and preserves request intake and historical records', async () => {
  const db = new PGlite()
  const client = '00000000-0000-0000-0000-000000000001'
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to service_role;
      create table clients(id uuid primary key);
      create table subscriptions(client_id uuid,plan_name text,status text,stripe_subscription_id text,current_period_start timestamptz,current_period_end timestamptz);
      create table appointments(id uuid primary key default gen_random_uuid(),client_id uuid not null,retell_call_id text,
        customer_name text,customer_email text,customer_phone text,company_name text,service text,notes text,
        status text not null default 'booked',source text not null,appointment_time timestamptz,appointment_end_time timestamptz,
        duration_minutes integer,employee_id uuid,created_at timestamptz default now(),updated_at timestamptz default now());
      create unique index appointments_retell_call_id_key on appointments(retell_call_id) where retell_call_id is not null;
      grant select, insert, update on appointments to service_role;`)
    await db.exec(await readFile('supabase/migrations/20261014055537_appointment_request_intake.sql', 'utf8'))
    await db.query('insert into clients values($1)', [client])
    await db.query("insert into appointments(client_id,customer_name,status,source,appointment_time) values($1,'Historical booking','booked','dashboard',now())", [client])
    await db.query("select capture_recepta_appointment_request($1,'original-request','{\"customer_name\":\"Existing caller\"}')", [client])
    const before = (await db.query('select * from appointments order by id')).rows
    await db.exec(await readFile('supabase/migrations/20261028191236_shared_booking_capacity.sql', 'utf8'))
    await db.query('insert into booking_settings(client_id,enabled) values($1,true)', [client])
    const migration = (await readdir('supabase/migrations')).find(name => name.endsWith('_disable_calendar_booking.sql'))
    await db.exec(await readFile(`supabase/migrations/${migration}`, 'utf8'))
    assert.deepEqual((await db.query('select * from appointments order by id')).rows.map(({ booking_key, booking_version, booking_buffer_minutes, google_calendar_id, ...row }) => row), before)
    assert.equal((await db.query('select enabled from booking_settings')).rows[0].enabled, false)
    assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname in ('recepta_booking_capacity','recepta_booking_calendar_queue')")).rows[0].n, 0)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const checks = (await db.query(`select has_function_privilege($1,'public.reserve_recepta_booking(uuid,text,jsonb,uuid,integer)','execute') as reserve,
        has_function_privilege($1,'public.sync_recepta_calendar_snapshot(uuid,jsonb,timestamptz,timestamptz)','execute') as sync,
        has_table_privilege($1,'public.google_calendar_connections','select,insert,update,delete') as calendar`, [role])).rows[0]
      assert.deepEqual(checks, { reserve: false, sync: false, calendar: false })
    }
    await db.exec('set role service_role')
    const captured = (await db.query("select capture_recepta_appointment_request($1,'new-request','{\"customer_name\":\"New caller\"}') as result", [client])).rows[0].result
    assert.equal(captured.status, 'pending')
    const saved = (await db.query('select appointment_time,appointment_end_time,duration_minutes,employee_id from appointments where id=$1', [captured.id])).rows[0]
    assert.deepEqual(saved, { appointment_time: null, appointment_end_time: null, duration_minutes: null, employee_id: null })
    await assert.rejects(db.query("select reserve_recepta_booking($1,'stale','{}')", [client]), /permission denied/)
  } finally { await db.close() }
})
