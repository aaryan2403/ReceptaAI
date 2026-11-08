import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

// Real signed handler, worker and PostgreSQL queue; all external boundaries are
// synthetic. No production records, paid calls or actual emails are created.
const client='00000000-0000-0000-0000-000000000001'
let db, mode, requests, accepted, failReceipt, emailSettings = null
const identifiers = (name) => '"'+name.replaceAll('"','""')+'"'
const query = (table) => {
  assert.ok(['calls','clients','subscriptions','agents','appointments','employees','call_notifications'].includes(table))
  let values, single=false
  const filters=[]
  const execute=async () => {
    try {
      if(values) {
        const keys=Object.keys(values)
        const columns=keys.map(identifiers).join(',')
        const params=keys.map((_,i)=>'$'+(i+1)).join(',')
        const updates=keys.map((key)=>`${identifiers(key)}=excluded.${identifiers(key)}`).join(',')
        const result=await db.query(`insert into ${identifiers(table)} (${columns}) values (${params}) on conflict(retell_call_id) do update set ${updates} returning *`,keys.map((k)=>values[k]))
        return {data:single?result.rows[0]??null:result.rows,error:null}
      }
      let rows=(await db.query(`select * from ${identifiers(table)}`)).rows
      for(const [op,col,value] of filters) rows=rows.filter((row)=>op==='in'?value.includes(row[col]):row[col]===value)
      return {data:single?rows[0]??null:rows,error:null}
    } catch(error) { return {data:null,error:{message:error.message}} }
  }
  const api={select:()=>api,order:()=>api,limit:()=>api,
    eq:(col,value)=>{filters.push(['eq',col,value]);return api},
    in:(col,value)=>{filters.push(['in',col,value]);return api},
    upsert:(value)=>{values=value;return api},
    maybeSingle:()=>{single=true;return execute()},then:(resolve,reject)=>execute().then(resolve,reject)}
  return api
}
globalThis.__callNoticeDb={
  from:query,
  auth:{admin:{getUserById:async()=>({data:{user:{email:'owner@example.test',app_metadata:{recepta_call_email:emailSettings}}},error:null})}},
  rpc:async(name,args)=>{
    if(name==='finish_recepta_call_notification' && args.p_provider_id && failReceipt) {
      failReceipt=false
      return {data:null,error:{message:'synthetic database outage'}}
    }
    const argsByName={
      claim_recepta_call_notifications:['p_limit','p_key'],
      prepare_recepta_call_notification:['p_key','p_lease','p_payload'],
      finish_recepta_call_notification:['p_key','p_lease','p_provider_id','p_error'],
    }
    assert.ok(argsByName[name])
    const names=argsByName[name]
    try {
      const result=await db.query(`select * from public.${name}(${names.map((_,i)=>'$'+(i+1)).join(',')})`,names.map((k)=>k==='p_payload'?JSON.stringify(args[k]):args[k]))
      return {data:name==='finish_recepta_call_notification'?result.rows[0][name]:result.rows,error:null}
    } catch(error) {return {data:null,error:{message:error.message}}}
  },
}
const compile=async(path,exportName='default')=>{
  const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,
    plugins:[{name:'synthetic-db',setup(builder){
      builder.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'db',namespace:'test'}))
      builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const createClient = () => globalThis.__callNoticeDb',loader:'js'}))
    }}]})
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`))[exportName]
}
const webhook=await compile('netlify/functions/retell-webhook.ts')
const worker=await compile('netlify/lib/callNotifications.ts','deliverCallNotices')
const schedule=await compile('netlify/functions/call-notification-retries.ts')
const scheduleConfig=await compile('netlify/functions/call-notification-retries.ts','config')
process.env.SUPABASE_URL='https://synthetic.test'
process.env.SUPABASE_SECRET_KEY='synthetic-only'
process.env.RETELL_API_KEY='synthetic-only'
const originalFetch=globalThis.fetch
const originalEmailKey=process.env.RESEND_API_KEY
const provider=async(url,options)=>{
  assert.equal(url,'https://api.resend.com/emails')
  const key=options.headers['Idempotency-Key']
  assert.ok(key)
  assert.ok(options.signal)
  requests.push({key,body:options.body})
  if(mode==='reject') return new Response('{}',{status:503})
  if(mode==='timeout-before') throw new TypeError('synthetic network timeout')
  const previous=accepted.get(key)
  if(previous) {assert.equal(previous.body,options.body);return new Response(JSON.stringify({id:previous.id}),{status:200})}
  const id='synthetic-message-'+(accepted.size+1)
  accepted.set(key,{id,body:options.body})
  if(mode==='accepted-timeout') throw new TypeError('synthetic lost response')
  return new Response(JSON.stringify({id}),{status:200})
}
const setup=async(plan='Recepta Pro',legacy=false,legacySchema=false)=>{
  process.env.RECEPTA_CALL_EMAIL_ENABLED='true'
  emailSettings=null
  db=new PGlite();mode='success';requests=[];accepted=new Map();failReceipt=false
  process.env.RESEND_API_KEY='synthetic-only';globalThis.fetch=provider
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table clients(id uuid primary key,company_name text,contact_email text);
    create table subscriptions(client_id uuid primary key,plan_name text,status text,current_period_start timestamptz,current_period_end timestamptz,
      monthly_minutes integer default 300,rollover_seconds bigint default 0,pii_redaction_enabled boolean default false);
    create table agents(client_id uuid,retell_agent_id text,business_hours text);
    create table appointments(client_id uuid,retell_call_id text,status text,appointment_time timestamptz,
      customer_name text,customer_email text,customer_phone text,company_name text,service text,notes text,
      appointment_end_time timestamptz,duration_minutes integer,employee_id uuid,
      requested_date text,requested_time text,requested_timezone text);
    create table employees(id uuid,client_id uuid,name text);
    create table calls(id uuid primary key default gen_random_uuid(),client_id uuid references clients(id),retell_call_id text unique,
      caller_name text,caller_number text,started_at timestamptz not null default now(),duration_seconds integer default 0,
      call_status text,outcome text,disconnection_reason text,transcript text,recording_url text,summary text,
      user_sentiment text,call_successful boolean,appointment_booked boolean default false,retell_agent_id text,ended_at timestamptz,updated_at timestamptz,content_erased_at timestamptz);
    insert into clients values('${client}','Synthetic business','owner@example.test');
    insert into subscriptions(client_id,plan_name,status) values('${client}','${plan}','active');
    insert into agents values('${client}','agent_test',null);`)
  if(legacy) await db.exec(`insert into calls(client_id,retell_call_id,call_status) values('${client}','legacy','ended')`)
  await db.exec(await readFile('supabase/migrations/20261014064906_call_notification_outbox.sql','utf8'))
  await db.exec(await readFile('supabase/migrations/20261014174126_protect_call_lifecycle.sql','utf8'))
  if(!legacySchema)await db.exec(await readFile('supabase/migrations/20261108033150_client_call_email_preferences.sql','utf8'))
}
const signed=(event='call_analyzed',callId='call_test',extra={})=>{
  const body=JSON.stringify({event,call:{call_id:callId,agent_id:'agent_test',call_status:'ended',start_timestamp:Date.now(),duration_ms:60000,
    call_analysis:{call_summary:'Synthetic summary',call_successful:true},...extra}})
  const t=Date.now();const digest=createHmac('sha256',process.env.RETELL_API_KEY).update(`${body}${t}`).digest('hex')
  return new Request('https://synthetic.test',{method:'POST',headers:{'x-retell-signature':`v=${t},d=${digest}`},body})
}
const notice=async()=> (await db.query('select * from call_notifications order by created_at')).rows[0]
const due=()=>db.exec("update call_notifications set next_attempt_at=now()-interval '1 second',lease_expires_at=null where status in ('queued','retrying')")
const close=async()=>{await db.close();globalThis.fetch=originalFetch;if(originalEmailKey===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=originalEmailKey}

test('rejected owner email survives saved analysis and webhook replay, then scheduled retry accepts once',async()=>{
  await setup('Recepta Standard')
  try {
    mode='reject';assert.equal((await webhook(signed('call_ended'))).status,204)
    assert.equal((await notice()).status,'queued');assert.equal((await notice()).attempts,1)
    assert.equal((await webhook(signed('call_analyzed'))).status,204)
    assert.equal((await db.query('select count(*)::int as n from call_notifications')).rows[0].n,1)
    assert.equal(requests.length,1)
    await due();mode='success';await schedule()
    assert.equal((await notice()).status,'accepted');assert.ok((await notice()).provider_message_id)
    await webhook(signed());await schedule();assert.equal(accepted.size,1);assert.equal(requests.length,2)
    assert.equal(scheduleConfig.schedule,'*/5 * * * *')
  }finally{await close()}
})

test('Pro waits for analysis; missing email configuration stays queued and recovers',async()=>{
  await setup()
  try {
    delete process.env.RESEND_API_KEY
    await webhook(signed('call_ended'));assert.equal((await db.query('select count(*)::int as n from call_notifications')).rows[0].n,0)
    await webhook(signed());assert.equal((await notice()).status,'queued');assert.equal((await notice()).first_send_at,null)
    assert.equal(requests.length,0)
    await db.exec(`insert into appointments(client_id,retell_call_id,status,requested_date,requested_time)
      values('${client}','call_test','pending','Next Tuesday','Afternoon')`)
    process.env.RESEND_API_KEY='synthetic-only';await due();await schedule()
    assert.equal((await notice()).status,'accepted')
    assert.match(JSON.parse(requests[0].body).text,/Pending — follow-up required/)
    assert.match(JSON.parse(requests[0].body).text,/Next Tuesday · Afternoon/)
    assert.doesNotMatch(JSON.parse(requests[0].body).text,/Starts:/)
  }finally{await close()}
})

test('accepted email with a lost response or failed database receipt uses immutable content and the same provider key',async()=>{
  for(const failure of ['accepted-timeout','receipt-save']){
    await setup('Recepta Standard')
    try {
      mode=failure==='accepted-timeout'?failure:'success';failReceipt=failure==='receipt-save'
      await webhook(signed('call_ended'));assert.equal((await notice()).status,'queued');assert.equal(accepted.size,1)
      const first=requests[0]
      await db.exec("update calls set caller_name='Changed after send',outcome='Changed after send'")
      process.env.APPOINTMENT_FROM_EMAIL='changed@example.test'
      await due();mode='success';await Promise.all([worker(globalThis.__callNoticeDb),worker(globalThis.__callNoticeDb)])
      assert.equal((await notice()).status,'accepted');assert.equal(accepted.size,1)
      assert.equal(requests.length,2);assert.equal(requests[1].body,first.body);assert.equal(requests[1].key,first.key)
    }finally{delete process.env.APPOINTMENT_FROM_EMAIL;await close()}
  }
})

test('queue insertion is atomic with call storage, and stale worker leases cannot overwrite a receipt',async()=>{
  await setup('Recepta Standard')
  try {
    await db.exec("alter table call_notifications add constraint synthetic_block check(false)")
    assert.equal((await webhook(signed('call_ended'))).status,500)
    assert.equal((await db.query('select count(*)::int as n from calls')).rows[0].n,0)
    await db.exec('alter table call_notifications drop constraint synthetic_block')
    delete process.env.RESEND_API_KEY;await webhook(signed('call_ended'));await due()
    const first=(await db.query('select * from claim_recepta_call_notifications(1,null)')).rows[0]
    await db.exec("update call_notifications set lease_expires_at=now()-interval '1 second'")
    const second=(await db.query('select * from claim_recepta_call_notifications(1,null)')).rows[0]
    assert.notEqual(first.lease_token,second.lease_token)
    assert.equal((await db.query('select finish_recepta_call_notification($1,$2,$3,null) as ok',[first.notification_key,first.lease_token,'stale'])).rows[0].ok,false)
    assert.equal((await db.query('select finish_recepta_call_notification($1,$2,$3,null) as ok',[second.notification_key,second.lease_token,'current'])).rows[0].ok,true)
    assert.equal((await notice()).provider_message_id,'current')
  }finally{await close()}
})

test('expired ambiguous sends need attention, legacy sends are not resent, and customers cannot read/execute the private queue',async()=>{
  await setup('Recepta Standard',true)
  try {
    await db.exec(`update calls set owner_notification_requested=true where retell_call_id='legacy'`)
    await schedule();assert.equal(requests.length,0);assert.equal((await notice()).status,'legacy_untracked')
    delete process.env.RESEND_API_KEY;await webhook(signed('call_ended'))
    await db.exec("update call_notifications set first_send_at=now()-interval '24 hours',next_attempt_at=now()-interval '1 second' where status='queued'")
    await schedule()
    assert.equal((await db.query("select status from call_notifications where retell_call_id='call_test'")).rows[0].status,'needs_attention')
    assert.equal((await db.query("select has_table_privilege('authenticated','call_notifications','select') as ok")).rows[0].ok,false)
    assert.equal((await db.query("select has_function_privilege('anon','claim_recepta_call_notifications(integer,text)','execute') as ok")).rows[0].ok,false)
  }finally{await close()}
})

const captureModule=await compile('netlify/lib/callEmailCapture.ts','captureCallEmailDetails')
const detailKey=await compile('netlify/lib/callEmailCapture.ts','emailFieldKey')
const emailBuilder=await compile('netlify/lib/callNotificationEmail.ts','buildCallNotification')

test('owner and caller deliveries have independent keys and custom fields survive failed sends and replay',async()=>{
  await setup()
  try {
    emailSettings={callerEnabled:true,ownerFields:['summary','custom'],callerFields:['summary','custom'],customFields:['Number of windows','Preferred callback']}
    const analysis={call_summary:'Internal staff assessment',call_successful:true,custom_analysis_data:{
      recepta_caller_name:'Jane',recepta_caller_email:'jane@example.test',recepta_caller_email_confirmed:true,
      recepta_caller_summary:'You requested a quote for six windows.',[detailKey('Number of windows')]:'6',
    }}
    mode='reject';assert.equal((await webhook(signed('call_analyzed','two_recipients',{call_analysis:analysis}))).status,204)
    const queued=(await db.query('select * from call_notifications order by notification_key')).rows
    assert.equal(queued.length,2);assert.ok(queued.every(row=>row.status==='queued'))
    emailSettings={callerEnabled:false,customFields:[]}
    await webhook(signed('call_analyzed','two_recipients',{call_analysis:{call_summary:'Changed'}}))
    await due();mode='success';await schedule()
    assert.equal(accepted.size,2)
    const mails=[...accepted.entries()].map(([key,value])=>({key,mail:JSON.parse(value.body)}))
    const caller=mails.find(item=>item.key.startsWith('caller-call:')).mail
    const owner=mails.find(item=>item.key.startsWith('owner-call:')).mail
    assert.deepEqual(owner.to,['owner@example.test']);assert.deepEqual(caller.to,['jane@example.test'])
    assert.match(owner.text,/Internal staff assessment/);assert.doesNotMatch(caller.text,/Internal staff assessment/)
    assert.match(caller.text,/six windows/);assert.match(caller.text,/Number of windows: 6/)
    assert.match(caller.text,/Preferred callback: Not provided/)
    await webhook(signed('call_analyzed','two_recipients',{call_analysis:analysis}));await schedule()
    assert.equal(accepted.size,2)
  }finally{await close()}
})

test('unconfirmed email is explicitly skipped, caller receipts default off, and historical calls are not backfilled',async()=>{
  await setup()
  try {
    await webhook(signed('call_analyzed','default_off'))
    assert.equal((await db.query('select count(*)::int as n from call_notifications')).rows[0].n,1)
    emailSettings={callerEnabled:true}
    await webhook(signed('call_analyzed','default_off'))
    assert.equal((await db.query('select count(*)::int as n from call_notifications')).rows[0].n,1)
    await webhook(signed('call_analyzed','unconfirmed',{call_analysis:{custom_analysis_data:{recepta_caller_email:'wrong@example.test',recepta_caller_email_confirmed:false}}}))
    const skipped=(await db.query("select * from call_notifications where notification_key like 'caller-call:%'")).rows[0]
    assert.equal(skipped.status,'needs_attention');assert.match(skipped.last_error,/confirmed/)
    assert.ok(requests.every(request=>!JSON.parse(request.body).to.includes('wrong@example.test')))
  }finally{await close()}
})

test('PII redaction drops captured identifiers and prevents caller delivery',()=>{
  const details=captureModule({callerEnabled:true,customFields:['Address']},{recepta_caller_email:'private@example.test',recepta_caller_email_confirmed:true,recepta_caller_name:'Private',recepta_caller_summary:'Private summary',[detailKey('Address')]:'Private address'},true)
  assert.equal(details.callerEmail,null);assert.equal(details.callerName,'');assert.equal(details.callerSummary,'');assert.deepEqual(details.customDetails,[])
  assert.match(details.callerSkipReason,/redaction/)
})

test('selected email fields control the body, Standard remains basic, and caller copy cannot expose internal notes',()=>{
  const input={planName:'Recepta Pro',businessName:'Business',ownerEmail:'owner@example.test',callerEmail:'caller@example.test',callerName:'Hidden name',callerNumber:'Hidden phone',startedAt:new Date().toISOString(),durationSeconds:80,timeZone:'America/Toronto',summary:'Internal assessment',callerSummary:'Customer-facing recap',settings:{callerEnabled:true,ownerFields:['summary'],callerFields:['summary','appointment'],customFields:[]},appointment:{status:'pending',timeZone:'America/Toronto',notes:'Private staff notes',employeeName:'Private employee',customerPhone:'Private phone'}}
  const owner=emailBuilder(input),caller=emailBuilder({...input,recipient:'caller'}),standard=emailBuilder({...input,planName:'Recepta Standard'})
  assert.match(owner.text,/Internal assessment/);assert.doesNotMatch(owner.text,/Hidden name|Hidden phone|Call duration/)
  assert.match(caller.text,/Customer-facing recap/);assert.doesNotMatch(caller.text,/Internal assessment|Private staff|Private employee|Private phone/)
  assert.match(caller.text,/Pending — follow-up required/);assert.doesNotMatch(caller.text,/Your appointment is confirmed/)
  assert.doesNotMatch(standard.text,/Internal assessment/)
})

test('preview email requires its staging key and approved destinations even when production credentials exist',async()=>{
  await setup('Recepta Standard')
  try {
    process.env.CONTEXT='deploy-preview';process.env.RETELL_STAGING_API_KEY=process.env.RETELL_API_KEY
    await webhook(signed('call_ended'))
    assert.equal(requests.length,0);assert.match((await notice()).last_error,/RESEND_STAGING_API_KEY/)
    process.env.RESEND_STAGING_API_KEY='synthetic-staging';await due();await schedule()
    assert.equal(requests.length,0);assert.match((await notice()).last_error,/RECEPTA_STAGING_EMAIL_TARGETS/)
    process.env.RECEPTA_STAGING_EMAIL_TARGETS='owner@example.test';await due();await schedule()
    assert.equal(requests.length,1);assert.equal((await notice()).status,'accepted')
  }finally{delete process.env.CONTEXT;delete process.env.RETELL_STAGING_API_KEY;delete process.env.RESEND_STAGING_API_KEY;delete process.env.RECEPTA_STAGING_EMAIL_TARGETS;await close()}
})

test('erasing a call also erases email captures and late replays cannot restore them',async()=>{
  await setup()
  try {
    emailSettings={callerEnabled:true,customFields:['Address']}
    await webhook(signed())
    await db.exec("update calls set content_erased_at=now();update calls set notification_details='{\"callerEmail\":\"private@example.test\"}'")
    assert.equal((await db.query('select notification_details from calls')).rows[0].notification_details,null)
  }finally{await close()}
})


test('disabled rollout continues owner email on the original database schema',async()=>{
 await setup('Recepta Standard',false,true)
 try {
  process.env.RECEPTA_CALL_EMAIL_ENABLED='false'
  assert.equal((await webhook(signed('call_ended'))).status,204)
  assert.equal((await notice()).status,'accepted');assert.equal(requests.length,1)
 }finally{await close()}
})


test('caller receipt can recover independently while the owner address lookup is failing',async()=>{
 await setup()
 const originalLookup=globalThis.__callNoticeDb.auth.admin.getUserById
 try {
  emailSettings={callerEnabled:true,ownerFields:['summary'],callerFields:['summary']}
  delete process.env.RESEND_API_KEY
  await webhook(signed('call_analyzed','independent',{call_analysis:{call_summary:'Staff summary',custom_analysis_data:{recepta_caller_email:'caller@example.test',recepta_caller_email_confirmed:true,recepta_caller_summary:'Your request was recorded.'}}}))
  await db.exec("update clients set contact_email='invalid'")
  globalThis.__callNoticeDb.auth.admin.getUserById=async()=>({data:{user:null},error:{message:'Synthetic Auth outage'}})
  process.env.RESEND_API_KEY='synthetic';await due();await schedule()
  const rows=(await db.query('select notification_key,status from call_notifications')).rows
  assert.equal(rows.find(row=>row.notification_key.startsWith('owner-call:')).status,'queued')
  assert.equal(rows.find(row=>row.notification_key.startsWith('caller-call:')).status,'accepted')
  assert.equal(accepted.size,1);assert.deepEqual(JSON.parse([...accepted.values()][0].body).to,['caller@example.test'])
 }finally{globalThis.__callNoticeDb.auth.admin.getUserById=originalLookup;await close()}
})
