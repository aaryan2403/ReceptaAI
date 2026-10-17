import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'

const client='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',admin='00000000-0000-0000-0000-000000000003'
let db,state
const quote=value=>'"'+value.replaceAll('"','""')+'"'
const table=name=>{
 let action='read',values,single=false,conflict,ignore=false
 const filters=[]
 const execute=async()=>{
  try{
   let rows=[]
   if(action==='insert'){
    for(const row of Array.isArray(values)?values:[values]){
     const keys=Object.keys(row)
     const onConflict=conflict?`on conflict(${quote(conflict)}) ${ignore?'do nothing':'do update set '+keys.map(k=>`${quote(k)}=excluded.${quote(k)}`).join(',')}`:''
     rows.push(...(await db.query(`insert into ${quote(name)} (${keys.map(quote).join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) ${onConflict} returning *`,keys.map(k=>row[k]))).rows)
    }
   }else{
    const params=action==='update'?Object.values(values):[]
    const clauses=filters.map(([column,op,value])=>{if(op==='in')return `${quote(column)} in (${value.map(v=>{params.push(v);return '$'+params.length}).join(',')})`;params.push(value);return `${quote(column)} ${op} $${params.length}`})
    const base=action==='update'?`update ${quote(name)} set ${Object.keys(values).map((k,i)=>`${quote(k)}=$${i+1}`).join(',')}`:action==='delete'?`delete from ${quote(name)}`:`select * from ${quote(name)}`
    rows=(await db.query(base+(clauses.length?' where '+clauses.join(' and '):'')+(action!=='read'?' returning *':''),params)).rows
   }
   return{data:single?rows[0]??null:rows,error:null}
  }catch(error){return{data:null,error:{message:error.message}}}
 }
 const api={select:()=>api,order:()=>api,limit:()=>api,or:()=>api,
  in:(c,v)=>{filters.push([c,'in',v]);return api},eq:(c,v)=>{filters.push([c,'=',v]);return api},neq:(c,v)=>{filters.push([c,'<>',v]);return api},gt:(c,v)=>{filters.push([c,'>',v]);return api},
  insert:v=>{action='insert';values=v;return api},upsert:(v,o)=>{action='insert';values=v;conflict=o?.onConflict??'notification_key';ignore=o?.ignoreDuplicates;return api},
  update:v=>{action='update';values=v;return api},delete:()=>{action='delete';return api},
  maybeSingle:()=>{single=true;return execute()},single:()=>{single=true;return execute()},then:(a,b)=>execute().then(a,b),
 }
 return api
}
globalThis.__operationsDb={from:table,auth:{getUser:async token=>({data:{user:{id:token==='admin'?admin:client,email:token==='admin'?'admin@example.test':'owner@example.test'}},error:null}),admin:{
 getUserById:async()=>({data:{user:state.authPresent?{id:client,email:'owner@example.test'}:null},error:null}),
 updateUserById:async()=>{state.authOps.push('ban');return{error:null}},
 deleteUser:async()=>{state.authOps.push('delete');state.authPresent=false;return{error:null}},
}},rpc:async(name,args={})=>{
 try{
  const keys=Object.keys(args)
  return{data:(await db.query(`select * from ${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})`,Object.values(args))).rows.map(row=>Object.keys(row).length===1&&name.startsWith('finish_')?Object.values(row)[0]:row),error:null}
 }catch(error){return{data:null,error:{message:error.message}}}
}}
// RPC boolean return shape matches supabase-js.
const rpc=globalThis.__operationsDb.rpc
globalThis.__operationsDb.rpc=async(name,args)=>{const result=await rpc(name,args);return name.startsWith('finish_')?{...result,data:result.data?.[0]??null}:result}
globalThis.__operationsStripe=class{
 subscriptions={retrieve:async()=>({status:state.cancelled?'canceled':'active'}),cancel:async()=>{state.stripeOps.push('cancel');if(state.stripeFailure)throw new Error('Synthetic cancellation unavailable');state.cancelled=true}}
 customers={del:async()=>{state.stripeOps.push('customer-delete');return{id:'cus_test',deleted:true}}}
}
const originalFetch=globalThis.fetch
const compile=async(file,name='default')=>{
 const result=await build({entryPoints:[file],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'synthetic-services',setup(b){
  if(file.endsWith('update-call-preferences.ts'))b.onResolve({filter:/^\.\.\/lib\/retell$/},()=>({path:'retell',namespace:'mock'}))
  b.onResolve({filter:/^(stripe|@supabase\/supabase-js)$/},a=>({path:a.path,namespace:'mock'}))
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({loader:'js',contents:a.path==='stripe'?'export default globalThis.__operationsStripe':a.path==='retell'?`export const normalizeEmailNotificationsEnabled=v=>v!==false;export const normalizeSmsNotificationsEnabled=v=>v===true;export const normalizeAppointmentFields=v=>Array.isArray(v)?v:[];export const syncRetellSchedule=async options=>{globalThis.__operationsPrefSync.push(options);if(globalThis.__operationsPrefFail)throw new Error('Synthetic publish failure');return{agentUpdated:true}};`:'export const createClient=()=>globalThis.__operationsDb'}))
 }}]})
 return(await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')))[name]
}
process.env.SUPABASE_URL='https://synthetic.test';process.env.SUPABASE_SECRET_KEY='synthetic';process.env.ADMIN_EMAIL='admin@example.test'
process.env.STRIPE_SECRET_KEY='sk_test_synthetic';process.env.RETELL_API_KEY='synthetic';process.env.RESEND_API_KEY='synthetic';process.env.RECEPTA_APP_URL='https://recepta.test'
const run=await compile('netlify/lib/serviceJobs.ts','processServiceJobs')
const callbacks=await compile('netlify/functions/callback-requests.ts')
const deletion=await compile('netlify/functions/delete-client.ts')
const delivery=await compile('netlify/functions/resend-webhook.ts')
const operations=await compile('netlify/functions/admin-operations.ts')
const callHistory=await compile('netlify/functions/client-calls.ts')
const verifyEmail=await compile('netlify/lib/emailDelivery.ts','verifyEmailWebhook')
const configureEmail=await compile('netlify/lib/emailDelivery.ts','configureEmailDelivery')
const billingMail=await compile('netlify/lib/billingNotifications.ts','deliverBillingNotices')
const preferences=await compile('netlify/functions/update-call-preferences.ts')
const secret='whsec_'+Buffer.from('synthetic_webhook_secret_for_tests').toString('base64')
const request=(body,token='customer',method='POST')=>new Request('https://recepta.test',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method!=='GET'?{body:JSON.stringify(body)}:{})})
const fixture=async()=>{
 await db.exec('truncate service_jobs,callback_requests,email_delivery_receipts,integration_settings,call_notifications,billing_notifications,call_minute_reservations,appointments,calls,agent_phone_numbers,agents,subscriptions,clients cascade')
 state={authPresent:true,authOps:[],stripeOps:[],retellOps:[],mail:[],providerCalls:[],cancelled:false}
 await db.query("insert into clients(id,status,role,company_name,contact_email) values($1,'live','client','Synthetic business','owner@example.test'),($2,'live','client','Other business','other@example.test')",[client,other])
 await db.query("insert into subscriptions(client_id,plan_name,status,monthly_minutes,monthly_price,ai_model_id,stripe_subscription_id,stripe_customer_id,current_period_start,current_period_end,pii_redaction_enabled,safety_guardrails_enabled,extra_phone_numbers) values($1,'Recepta Standard','active',60,207.02,'essential','sub_test','cus_test',now()-interval '1 day',now()+interval '29 days',false,false,0)",[client])
 await db.query("insert into agents(client_id,retell_agent_id,status,phone_number) values($1,'agent_test','live','+14165550100')",[client])
 await db.query("insert into agent_phone_numbers values($1,'+14165550100','retell',true)",[client])
 await db.query("insert into integration_settings values('resend_webhook',$1,now())",[{secret}])
 globalThis.fetch=async(url,options={})=>{
  if(String(url).startsWith('https://api.resend.com/webhooks')){state.webhookOps??=[];state.webhookOps.push({url,method:options.method??'GET'});return new Response(JSON.stringify(options.method==='POST'?{id:'hook_test',signing_secret:secret}:{data:[]}),{status:state.webhookFailure?403:200})}
  if(String(url).startsWith('https://api.resend.com/emails')){
   state.mail.push({body:JSON.parse(options.body),key:options.headers['Idempotency-Key']})
   return new Response(JSON.stringify(state.mailFailure?{error:'synthetic'}:{id:'email_test'}),{status:state.mailFailure?503:200})
  }
  if(String(url).startsWith('https://api.retellai.com')){
   const path=new URL(url).pathname
   state.retellOps.push({path,method:options.method,body:options.body?JSON.parse(options.body):null})
   if(state.retellFailure)return new Response('{}',{status:503})
   if(path==='/v3/list-calls')return new Response(JSON.stringify({items:state.staleCall?[state.staleCall]:state.providerCalls}),{status:200})
   if(path.startsWith('/v2/get-call/'))return new Response(JSON.stringify(state.staleCall),{status:200})
   if(path==='/v2/list-calls')return new Response(JSON.stringify(state.providerCalls),{status:200})
   if(path.startsWith('/v2/delete-call/'))state.providerCalls=state.providerCalls.filter(c=>c.call_id!==decodeURIComponent(path.split('/').at(-1)))
   return new Response(null,{status:204})
  }
  throw new Error('Unexpected external request '+url)
 }
}
const callback=async(callId='missed_test',owner=client)=>db.query('select record_recepta_callback($1,$2,$3,$4,$5)',[owner,callId,'+14165550200','+14165550100','allowance_unavailable'])
const job=async(key)=>(await db.query('select * from service_jobs where job_key=$1',[key])).rows[0]
const due=async()=>db.exec("update service_jobs set next_attempt_at=now()-interval '1 second',lease_expires_at=null")
test.before(async()=>{
 db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
 create schema auth;create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;
 create table clients(id uuid primary key,status text,role text,company_name text,contact_email text);
 create table subscriptions(client_id uuid primary key references clients on delete cascade,plan_name text,status text,monthly_minutes integer,monthly_price numeric,ai_model_id text,stripe_subscription_id text,stripe_customer_id text,current_period_start timestamptz,current_period_end timestamptz,next_billing_date timestamptz,pii_redaction_enabled boolean default false,safety_guardrails_enabled boolean default false,extra_phone_numbers integer default 0);
 create table agents(client_id uuid primary key references clients on delete cascade,agent_name text,retell_agent_id text,status text,phone_number text,business_hours text);
 create table agent_phone_numbers(client_id uuid references clients on delete cascade,phone_number text,source text,is_primary boolean);
 create table calls(id uuid primary key default gen_random_uuid(),client_id uuid references clients on delete cascade,retell_call_id text unique,call_status text,started_at timestamptz default now(),ended_at timestamptz,duration_seconds integer default 0,caller_name text,caller_number text,transcript text,recording_url text,summary text,outcome text,user_sentiment text,call_successful boolean,appointment_booked boolean default false,retell_agent_id text,disconnection_reason text,updated_at timestamptz default now());
 create table employees(id uuid,client_id uuid,name text,role text,is_active boolean);create table employee_schedules(employee_id uuid,day_of_week integer,is_working boolean,start_time text,end_time text);
 create table appointments(id uuid primary key default gen_random_uuid(),client_id uuid references clients on delete cascade,retell_call_id text,status text default 'pending',appointment_time timestamptz,customer_name text,customer_email text,customer_phone text,company_name text,service text,notes text);`)
 for(const path of ['supabase_add_minute_enforcement.sql','supabase_add_billing_notifications.sql','supabase/migrations/20261014064906_call_notification_outbox.sql','supabase/migrations/20261014174126_protect_call_lifecycle.sql','supabase/migrations/20261014192813_align_minute_enforcement.sql','supabase/migrations/20261014201359_demo_only_call_limit.sql','supabase/migrations/20261016145008_payment_controlled_activation.sql','supabase/migrations/20261017054318_launch_operations.sql','supabase/migrations/20261017054326_restrict_database_access.sql'])await db.exec(await readFile(path,'utf8'))
})
test('database grants deny anonymous access, preserve tenant reads, and hide deleting accounts even from an old JWT',async()=>{
 await fixture()
 await db.exec(`create policy test_own_client on clients for select to authenticated using(id=auth.uid());create policy test_own_agent on agents for select to authenticated using(client_id=auth.uid());`)
 await db.exec(`select set_config('request.jwt.claim.sub','${client}',false);set role authenticated;`)
 assert.equal((await db.query('select count(*) n from clients')).rows[0].n,1)
 await assert.rejects(db.query("update subscriptions set monthly_minutes=999"),/permission denied/)
 await assert.rejects(db.query("update clients set role='admin'"),/permission denied/)
 await db.exec('reset role');await db.query('update clients set deletion_pending=true where id=$1',[client]);await db.exec('set role authenticated')
 assert.equal((await db.query('select count(*) n from clients')).rows[0].n,0)
 assert.equal((await db.query('select count(*) n from agents')).rows[0].n,0)
 await db.exec('reset role;set role anon')
 await assert.rejects(db.query('select * from clients'),/permission denied/)
 await assert.rejects(db.query('select public.is_admin()'),/permission denied/)
 await db.exec('reset role;drop policy test_own_client on clients;drop policy test_own_agent on agents;')
})
test.after(async()=>{await db.close();globalThis.fetch=originalFetch})

test('declined-call capture atomically creates exactly one callback and one durable owner notice',async()=>{
 await fixture();await callback();await callback()
 assert.equal((await db.query('select count(*) n from callback_requests')).rows[0].n,1)
 assert.equal((await db.query('select count(*) n from service_jobs')).rows[0].n,1)
 assert.equal((await db.query('select count(*) n from calls')).rows[0].n,0)
 for(const role of ['anon','authenticated']){
  assert.equal((await db.query("select has_table_privilege($1,'callback_requests','select') ok",[role])).rows[0].ok,false)
  assert.equal((await db.query("select has_function_privilege($1,'record_recepta_callback(uuid,text,text,text,text)','execute') ok",[role])).rows[0].ok,false)
 }
})
test('callbacks are tenant-scoped and another client callback cannot be edited',async()=>{
 await fixture();await callback('own');await callback('other',other)
 const response=await callbacks(request(undefined,'customer','GET'))
 const rows=(await response.json()).callbacks
 assert.equal(rows.length,1)
 const foreign=(await db.query('select id from callback_requests where client_id=$1',[other])).rows[0].id
 assert.equal((await callbacks(request({id:foreign,status:'resolved'},'customer','PATCH'))).status,404)
 assert.equal((await db.query('select status from callback_requests where id=$1',[foreign])).rows[0].status,'pending')
})
test('callback email retries reuse the frozen body and key and record acceptance separately from delivery',async()=>{
 await fixture();await callback();state.mailFailure=true;await run(globalThis.__operationsDb)
 const key='callback:'+client+':missed_test'
 assert.equal((await job(key)).status,'queued');assert.ok((await job(key)).mail_payload)
 await db.query("update clients set contact_email='changed@example.test' where id=$1",[client]);await due();state.mailFailure=false;await run(globalThis.__operationsDb)
 assert.deepEqual(state.mail[0],state.mail[1]);assert.equal((await job(key)).status,'complete');assert.equal((await job(key)).delivery_status,'accepted')
 await run(globalThis.__operationsDb);assert.equal(state.mail.length,2)
})
test('an ambiguous callback retry stops before provider idempotency expires',async()=>{
 await fixture();await callback();await db.exec("update service_jobs set first_send_at=now()-interval '24 hours'")
 await run(globalThis.__operationsDb);assert.equal(state.mail.length,0);assert.equal((await job('callback:'+client+':missed_test')).status,'needs_attention')
})
test('failed Stripe cancellation preserves the paused account; retry completes cleanup before deleting Auth',async()=>{
 await fixture();state.stripeFailure=true
 assert.equal((await deletion(request({clientId:client},'admin'))).status,202)
 assert.equal((await db.query('select deletion_pending from clients where id=$1',[client])).rows[0].deletion_pending,true)
 await run(globalThis.__operationsDb);assert.equal(state.authOps.length,0);assert.equal(state.retellOps.length,0)
 assert.equal((await db.query('select status from agents where client_id=$1',[client])).rows[0].status,'paused')
 assert.match((await job('delete-client:'+client)).last_error,/cancellation/)
 state.stripeFailure=false;state.providerCalls=[{call_id:'provider_only_call',call_status:'ended'}];await due();await run(globalThis.__operationsDb)
 assert.deepEqual(state.authOps,['ban','delete']);assert.equal((await db.query('select count(*) n from clients where id=$1',[client])).rows[0].n,0)
 assert.equal((await job('delete-client:'+client)).status,'complete');assert.deepEqual((await job('delete-client:'+client)).payload,{})
 assert.ok(state.retellOps.some(x=>x.path==='/v2/delete-call/provider_only_call'));assert.ok(state.retellOps.some(x=>x.path==='/delete-agent/agent_test'))
})
test('Retell cleanup failure retains provider IDs and retries without repeating confirmed Stripe cleanup',async()=>{
 await fixture();state.retellFailure=true;await deletion(request({clientId:client},'admin'));await run(globalThis.__operationsDb)
 assert.equal(state.authOps.length,0);assert.equal((await job('delete-client:'+client)).payload.billing_done,true)
 state.retellFailure=false;await due();await run(globalThis.__operationsDb)
 assert.equal(state.stripeOps.filter(x=>x==='cancel').length,1);assert.equal(state.authOps.at(-1),'delete')
})
test('manual numbers are detached; a shared Retell agent blocks destructive provider cleanup',async()=>{
 await fixture();await db.query("update agent_phone_numbers set source='manual'");await deletion(request({clientId:client},'admin'));await run(globalThis.__operationsDb)
 assert.ok(state.retellOps.some(x=>x.path.startsWith('/update-phone-number/')));assert.ok(!state.retellOps.some(x=>x.path.startsWith('/delete-phone-number/')))
 await fixture();await db.query("insert into agents(client_id,retell_agent_id,status) values($1,'agent_test','live')",[other]);await deletion(request({clientId:client},'admin'));await run(globalThis.__operationsDb)
 assert.equal(state.retellOps.length,0);assert.equal(state.authOps.length,0);assert.match((await job('delete-client:'+client)).last_error,/shared/)
})
test('late paid Checkout and renewal cannot restore an account awaiting deletion',async()=>{
 await fixture();await deletion(request({clientId:client},'admin'))
 const cfg={plan_name:'Recepta Pro',monthly_price:400,monthly_minutes:1200,ai_model_id:'essential',extra_phone_numbers:0,pii_redaction_enabled:false,safety_guardrails_enabled:false}
 assert.equal((await db.query("select * from activate_recepta_checkout($1,'sub_new','cus_test',now(),now()+interval '30 days',$2,'sub_test')",[client,cfg])).rows.length,0)
 assert.equal((await db.query("select * from renew_recepta_subscription('sub_test',now(),now()+interval '30 days')")).rows.length,0)
 await assert.rejects(db.query('select * from configure_recepta_subscription($1,$2)',[client,cfg]),/awaiting deletion/)
 await db.query("update agents set status='live' where client_id=$1",[client]);assert.equal((await db.query('select status from agents where client_id=$1',[client])).rows[0].status,'paused')
})
test('retention waits for provider deletion, preserves paid usage, and late refresh cannot resurrect erased content',async()=>{
 await fixture()
 const call=(await db.query("insert into calls(client_id,retell_call_id,call_status,started_at,duration_seconds,caller_name,caller_number,transcript,recording_url,summary) values($1,'old_call','ended',now()-interval '100 days',120,'Private caller','+14165550200','Private transcript','https://recording.test/private','Private summary') returning *",[client])).rows[0]
 await db.query("insert into appointments(client_id,retell_call_id,customer_name,notes) values($1,'old_call','Private caller','Private notes')",[client])
 await db.exec('select queue_recepta_retention()');state.retellFailure=true;await run(globalThis.__operationsDb)
 assert.equal((await db.query('select transcript from calls where id=$1',[call.id])).rows[0].transcript,'Private transcript')
 state.retellFailure=false;await due();await run(globalThis.__operationsDb)
 await db.query("update calls set transcript='Late provider replay',caller_number='+14165550200' where id=$1",[call.id])
 const erased=(await db.query('select * from calls where id=$1',[call.id])).rows[0]
 assert.equal(erased.transcript,null);assert.equal(erased.caller_number,null);assert.equal(erased.duration_seconds,120);assert.ok(erased.provider_erased_at)
 assert.equal((await db.query('select notes from appointments')).rows[0].notes,null)
 await db.query("update appointments set notes='Late personal notes' where retell_call_id='old_call'")
 assert.equal((await db.query('select notes from appointments')).rows[0].notes,null)
 state.staleCall={call_id:'old_call',agent_id:'agent_test',call_status:'ended',from_number:'+14165550200',start_timestamp:Date.parse(call.started_at),duration_ms:120000,transcript:'Cached private transcript',recording_url:'https://recording.test/private',call_analysis:{call_summary:'Cached private summary'}}
 const history=await callHistory(request(undefined,'customer','GET'))
 assert.equal(history.status,200)
 const served=(await history.json()).calls[0]
 assert.equal(served.caller_number,null);assert.equal(served.summary,null);assert.equal(served.transcript,null)
})
const signedDelivery=(type,createdAt=new Date().toISOString(),id='evt_test')=>{
 const body=JSON.stringify({type,created_at:createdAt,data:{email_id:'email_test'}}),timestamp=String(Math.floor(Date.now()/1000))
 const signature=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')
 return new Request('https://recepta.test',{method:'POST',headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+signature},body})
}
test('verified delivery receipts survive arriving before acceptance and delayed older events never regress delivery',async()=>{
 await fixture();await callback()
 assert.equal((await delivery(signedDelivery('email.delivered'))).status,200)
 await run(globalThis.__operationsDb)
 assert.equal((await job('callback:'+client+':missed_test')).delivery_status,'delivered')
 assert.equal((await delivery(signedDelivery('email.delivery_delayed',new Date(Date.now()-60000).toISOString(),'evt_old'))).status,200)
 assert.equal((await job('callback:'+client+':missed_test')).delivery_status,'delivered')
 const unsigned=new Request('https://recepta.test',{method:'POST',body:'{}'})
 assert.equal((await delivery(unsigned)).status,401)
 assert.equal((await delivery(signedDelivery('email.delivered'))).status,200)
})
test('operations and deletion require admin authorization',async()=>{
 await fixture()
 assert.equal((await operations(request(undefined,'customer','GET'))).status,403)
 assert.equal((await deletion(request({clientId:other},'customer'))).status,403)
})

test('email signatures reject tampering, stale timestamps and wrong secrets',async()=>{
 await fixture()
 const request=signedDelivery('email.delivered'),body=await request.text()
 assert.equal(verifyEmail(body,request.headers,secret),true)
 assert.equal(verifyEmail(body+' ',request.headers,secret),false)
 assert.equal(verifyEmail(body,request.headers,'whsec_'+Buffer.from('wrong_secret_long_enough').toString('base64')),false)
 const old=new Headers(request.headers);old.set('svix-timestamp',String(Math.floor(Date.now()/1000)-601))
 assert.equal(verifyEmail(body,old,secret),false)
 const future=new Headers(request.headers);future.set('svix-timestamp',String(Math.floor(Date.now()/1000)+601))
 assert.equal(verifyEmail(body,future,secret),false)
})
test('email delivery setup saves its signing secret only in the private settings and is idempotent',async()=>{
 await fixture();await db.exec('delete from integration_settings')
 await configureEmail(globalThis.__operationsDb)
 assert.equal(state.webhookOps.filter(x=>x.method==='POST').length,1)
 assert.equal((await db.query("select value from integration_settings where key='resend_webhook'")).rows[0].value.secret,secret)
 await configureEmail(globalThis.__operationsDb);assert.equal(state.webhookOps.length,2)
 assert.equal((await db.query("select has_table_privilege('authenticated','integration_settings','select') ok")).rows[0].ok,false)
 await db.exec('delete from integration_settings');state.webhookFailure=true
 await assert.rejects(configureEmail(globalThis.__operationsDb),/webhook access/)
})

test('billing email records provider acceptance and never changes its frozen retry recipient or body',async()=>{
 await fixture();await db.query("insert into billing_notifications(notification_key,client_id,kind,payload) values('billing:synthetic',$1,'usage_80',$2)",[client,{subject:'Synthetic billing notice',text:'Synthetic minutes'}])
 state.mailFailure=true;await billingMail(globalThis.__operationsDb)
 await db.query("update clients set contact_email='changed@example.test' where id=$1",[client]);await db.exec("update billing_notifications set last_attempt_at=now()-interval '11 minutes'")
 state.mailFailure=false;await billingMail(globalThis.__operationsDb)
 assert.deepEqual(state.mail[0],state.mail[1]);const row=(await db.query('select * from billing_notifications')).rows[0]
 assert.equal(row.provider_message_id,'email_test');assert.ok(row.sent_at)
 await db.exec("update billing_notifications set sent_at=null,last_attempt_at=now()-interval '11 minutes',first_send_at=now()-interval '24 hours'")
 await billingMail(globalThis.__operationsDb);assert.equal(state.mail.length,2)
 assert.match((await db.query('select last_error from billing_notifications')).rows[0].last_error,/reviewed/)
})
test('saving custom store hours preserves independent AI answering and failed provider sync rolls back the setting',async()=>{
 await fixture();globalThis.__operationsPrefSync=[];globalThis.__operationsPrefFail=false
 const hours=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(day=>({day,open:day==='Monday',start:'09:00',end:'17:00'}))
 const body={scheduleMode:'custom',answeringMode:'24/7',operatingHours:hours,timeZone:'America/Toronto'}
 assert.equal((await preferences(request(body))).status,200)
 let stored=JSON.parse((await db.query('select business_hours from agents')).rows[0].business_hours)
 assert.equal(stored.mode,'custom');assert.equal(stored.answeringMode,'24/7');assert.deepEqual(stored.hours,hours)
 assert.equal((await preferences(request({...body,answeringMode:'business_hours'}))).status,200)
 stored=(await db.query('select business_hours from agents')).rows[0].business_hours
 globalThis.__operationsPrefFail=true
 assert.equal((await preferences(request({...body,scheduleMode:'24/7'}))).status,502)
 assert.equal((await db.query('select business_hours from agents')).rows[0].business_hours,stored)
 globalThis.__operationsPrefFail=false
 assert.equal((await preferences(request({...body,answeringMode:'free-unlimited-calls'}))).status,400)
})

test('deletion waits for an in-progress call without exhausting retries and blocks new number assignments',async()=>{
 await fixture();state.providerCalls=[{call_id:'ongoing_call',call_status:'ongoing'}]
 await deletion(request({clientId:client},'admin'))
 await assert.rejects(db.query("insert into agent_phone_numbers values($1,'+14165550999','retell',false)",[client]),/awaiting deletion/)
 await run(globalThis.__operationsDb)
 const pending=await job('delete-client:'+client)
 assert.equal(pending.status,'queued');assert.equal(pending.attempts,0);assert.equal(state.authOps.length,0)
 assert.match(pending.last_error,/current call/)
 state.providerCalls=[];await due();await run(globalThis.__operationsDb)
 assert.equal((await job('delete-client:'+client)).status,'complete')
})
