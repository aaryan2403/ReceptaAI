import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
const one='00000000-0000-0000-0000-000000000001',two='00000000-0000-0000-0000-000000000002'
const admin='00000000-0000-0000-0000-000000000003',worker='+14165550123',business='+16475550189',ai='+14165550100'
let db, state
const quote = v => '"'+v.replaceAll('"','""')+'"'
const table = name => {
 let action='read',values,single=false,conflict,ignore=false,max=Infinity
 const filters=[]
 const execute=async()=>{
  try {
   if (state.failFinish && name==='phone_setups' && action==='update' && values.sync_state==='synced') throw new Error('Synthetic final storage failure')
   let rows=[]
   if(action==='insert'){
    for (const row of Array.isArray(values)?values:[values]) {
     const keys=Object.keys(row),parts=(conflict??'').split(',')
     const on=conflict?` on conflict(${parts.map(quote).join(',')}) ${ignore?'do nothing':'do update set '+keys.map(k=>quote(k)+'=excluded.'+quote(k)).join(',')}`:''
     rows.push(...(await db.query(`insert into ${quote(name)} (${keys.map(quote).join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')})${on} returning *`,Object.values(row))).rows)
    }
   }else{
    const params=action==='update'?Object.values(values):[]
    const where=filters.map(([c,op,v])=>{params.push(v);return quote(c)+op+'$'+params.length}).join(' and ')
    const sql=action==='update'?`update ${quote(name)} set ${Object.keys(values).map((k,i)=>quote(k)+'=$'+(i+1)).join(',')}`:action==='delete'?`delete from ${quote(name)}`:`select * from ${quote(name)}`
    rows=(await db.query(sql+(where?' where '+where:'')+(action==='read'?'':' returning *'),params)).rows.slice(0,max)
   }
   return{data:single?rows[0]??null:rows,error:null}
  }catch(error){return{data:null,error:{message:error.message}}}
 }
 const api={select:()=>api,order:()=>api,limit:v=>{max=v;return api},eq:(c,v)=>{filters.push([c,'=',v]);return api},
 insert:v=>{action='insert';values=v;return api},upsert:(v,o)=>{action='insert';values=v;conflict=o?.onConflict;ignore=o?.ignoreDuplicates;return api},
 update:v=>{action='update';values=v;return api},delete:()=>{action='delete';return api},
 maybeSingle:()=>{single=true;return execute()},single:()=>{single=true;return execute()},then:(a,b)=>execute().then(a,b)}
 return api
}
globalThis.__phoneDb={from:table,auth:{getUser:async token=>({data:{user:token==='invalid'?null:{id:token==='admin'?admin:token==='other'?two:one,email:token==='admin'?'admin@example.test':'owner@example.test',user_metadata:{recepta_transfer_enabled:true}}},error:null}),
 admin:{getUserById:async id=>({data:{user:{id,email:'owner@example.test',email_confirmed_at:new Date().toISOString()}},error:null})}},
 rpc:async(name,args={})=>{try{
 const rows=(await db.query(`select ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as result`,Object.values(args))).rows
 return{data:rows[0]?.result,error:null}
 }catch(error){return{data:null,error:{message:error.message}}}}}
const compile=async(path)=>{
 const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'db',setup(b){
 b.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'db',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const createClient=()=>globalThis.__phoneDb',loader:'js'}))
 }}]})
 return await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const phoneTool=(await compile('netlify/functions/retell-phone-tools.ts')).default
const provisioning=await compile('netlify/lib/phoneProvisioning.ts')
const handler=(await compile('netlify/functions/phone-setup.ts')).default
const legacy=(await compile('netlify/functions/configure-call-transfer.ts')).default
const link=(await compile('netlify/functions/admin-link-phone.ts')).default
const webhook=(await compile('netlify/functions/retell-webhook.ts')).default
const runtime=await compile('netlify/lib/phoneSetup.ts')
const transfer=await compile('netlify/lib/callTransfer.ts')
const ownership=await compile('netlify/lib/agentOwnership.ts')
const retell=await compile('netlify/lib/retell.ts')
const guide=await compile('src/lib/forwardingGuides.ts')
const rawRequest=(body,token='customer',method='POST')=>new Request('https://test.example/phone-setup',{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})})
const call=async(body,token,method)=>{const res=await handler(rawRequest(body,token,method));return {status:res.status,body:await res.json()}}
const originalFetch=globalThis.fetch
process.env.SUPABASE_URL='https://synthetic.test';process.env.SUPABASE_SECRET_KEY='synthetic';process.env.RETELL_API_KEY='synthetic';process.env.ADMIN_EMAIL='admin@example.test'
process.env.RECEPTA_PHONE_SETUP_ENABLED='true';process.env.RECEPTA_APP_URL='https://recepta.test';process.env.URL='https://recepta.test'
process.env.TWILIO_ACCOUNT_SID='AC'+'a'.repeat(32);process.env.TWILIO_AUTH_TOKEN='synthetic';process.env.TWILIO_VERIFY_SERVICE_SID='VA'+'b'.repeat(32)
const setup=async()=>{
 if(db) await db.close()
 db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table clients(id uuid primary key,contact_email text,company_name text,deletion_pending boolean default false);
 create table agents(client_id uuid primary key references clients(id),retell_agent_id text,phone_number text,status text,business_hours text,demo_mode boolean default false);
 create table subscriptions(client_id uuid,status text,stripe_subscription_id text,current_period_start timestamptz,current_period_end timestamptz);
 create table agent_phone_numbers(id uuid default gen_random_uuid(),client_id uuid references clients(id),phone_number text unique,source text default 'manual',is_primary boolean default false);
 create table callback_requests(id uuid primary key default gen_random_uuid(),client_id uuid,retell_call_id text unique,caller_number text,called_number text,reason text constraint callback_requests_reason_check check(reason is not null),status text default 'pending',created_at timestamptz default now());
 create table service_jobs(job_key text unique,client_id uuid,kind text,payload jsonb);
 create table calls(retell_call_id text unique,client_id uuid,call_status text,lifecycle_rank integer);
 `)
 await db.exec(await readFile('supabase/migrations/20261102183345_phone_setup_verified_transfers.sql','utf8'))
 await db.exec(await readFile('supabase/migrations/20261105025833_phone_transfer_schedules_and_call_tests.sql','utf8'))
 await db.exec(await readFile('supabase/migrations/20261105030353_paid_reception_provisioning.sql','utf8'))
 await db.exec(await readFile('supabase/migrations/20261107051800_selected_twilio_numbers.sql', 'utf8'))
 await db.query(`insert into clients(id,contact_email) values($1,'owner@example.test'),($2,'other@example.test'),($3,'admin@example.test')`,[one,two,admin])
 await db.query("insert into agents(client_id,retell_agent_id,phone_number,status) values($1,'agent_test',$2,'live')",[one,ai])
 await db.query("insert into agent_phone_numbers(client_id,phone_number,is_primary) values($1,$2,true)",[one,ai])
 await db.query("insert into subscriptions values($1,'active','sub_synthetic',now()-interval '1 day',now()+interval '1 day')",[one])
 state={provider:[],validCode:true,failRetell:false,llm:{general_prompt:'Business policy\n\n[RECEPTA MANAGED APPOINTMENT BOOKING]\nOld instructions.',general_tools:[{type:'end_call',name:'end_call'},{type:'custom',name:'keep_custom_tool'}],default_dynamic_variables:{custom:'keep'}}}
 state.llms={llm_test:state.llm,llm_other:{general_prompt:'Other customer business policy.',general_tools:[{type:'end_call',name:'end_call'}],default_dynamic_variables:{other_customer:'keep'}}}
 globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname;const body=options.body?String(options.body):null
  state.provider.push({path,method:options.method??'GET',body})
  if(String(url).includes('verify.twilio.com')) return new Response(JSON.stringify(path.endsWith('/VerificationCheck')?{status:state.validCode?'approved':'pending',valid:state.validCode}:{sid:'VE'+'c'.repeat(32),status:'pending'}))
  if(state.failRetell)return new Response('{}',{status:503})
  let result={}
  if(path.startsWith('/publish-agent-version/'))return new Response(null,{status:204})
  if(path.startsWith('/update-agent/'))result={agent_id:decodeURIComponent(path.split('/').at(-1)),version:5}
  if(path.startsWith('/get-agent/')) result={agent_id:decodeURIComponent(path.split('/').at(-1)),voice_id:'voice_fixture',response_engine:{type:'retell-llm',llm_id:path.endsWith('/agent_other')&&!state.sharedLlm?'llm_other':'llm_test',version:4}}
  if(path==='/create-retell-llm')result={llm_id:'llm_provisioned'}
  if(path==='/create-agent'){if(state.unknownCreation)throw new Error('Synthetic lost response');result={agent_id:'agent_provisioned'}}
  if(path.startsWith('/get-phone-number/'))result={phone_number:decodeURIComponent(path.split('/').at(-1)),inbound_agents:state.conflictBinding?[{agent_id:'agent_other'}]:null,inbound_webhook_url:'https://recepta.test/.netlify/functions/retell-inbound'}
  if(path.startsWith('/list-agent-versions/'))result={items:[{version:4,is_published:true}]}
  if(path.startsWith('/create-agent-version/'))result={post_call_analysis_data:[{type:'string',name:'keep_existing_analysis',description:'Custom business analysis'},{type:'string',name:'recepta_detail_obsolete',description:'Old managed field'}],version:5,response_engine:{type:'retell-llm',llm_id:path.endsWith('/agent_other')?'llm_other':'llm_test',version:5},webhook_events:['call_started','call_ended','call_analyzed','transcript_updated']}
  if(path.startsWith('/get-retell-llm/'))result=state.llms[path.split('/').at(-1)]
  if(path.startsWith('/update-retell-llm/')){const id=path.split('/').at(-1);state.llms[id]={...state.llms[id],...JSON.parse(body)};if(id==='llm_test')state.llm=state.llms[id];result={llm_id:id}}
  if(path.startsWith('/v2/get-call/'))result=state.canonicalCall??{call_id:path.split('/').at(-1),agent_id:'agent_test'}
  return new Response(JSON.stringify(result),{status:200})
 }
}
const verify=async(purpose,phone,owner=one)=>{await db.query('insert into phone_verified_numbers(client_id,purpose,phone_number,verified_at) values($1,$2,$3,now()) on conflict(client_id,purpose,phone_number) do update set verified_at=now()',[owner,purpose,phone])}
const save=(overrides={})=>({action:'save',mode:'new',businessNumber:null,carrier:'rogers',lineType:'mobile',workerNumber:worker,transferEnabled:true,directLineAuthorized:true,expectedRevision:0,...overrides})

test('auth, feature flag, account-scoped GET and legacy route cannot bypass verification',async()=>{
 await setup()
 assert.equal((await call(null,null,'GET')).status,401)
 assert.equal((await call(null,'invalid','GET')).status,401)
 process.env.RECEPTA_PHONE_SETUP_ENABLED='false';assert.equal((await call(null,'customer','GET')).status,503);process.env.RECEPTA_PHONE_SETUP_ENABLED='true'
 const own=await call(null,'customer','GET'),other=await call(null,'other','GET')
 assert.deepEqual(own.body.numbers,[ai]);assert.deepEqual(other.body.numbers,[])
 assert.equal((await call({...save(),clientId:two})).status,400)
 assert.equal((await legacy(rawRequest(save()))).status,400)
 assert.equal(state.provider.length,0)
})
test('expired/unpaid subscriptions cannot enable service or send verification',async()=>{
 await setup();await verify('worker',worker)
 await db.exec("update subscriptions set current_period_end=now()-interval '1 minute'")
 assert.equal((await call(save())).status,403)
 assert.equal((await call({action:'send-code',purpose:'worker',phoneNumber:worker,channel:'sms',authorized:true})).status,403)
 assert.equal(state.provider.length,0)
})
test('verification requires consent, a valid code and the current user/target challenge',async()=>{
 await setup()
 assert.equal((await call({action:'send-code',purpose:'worker',phoneNumber:worker,channel:'sms'})).status,400)
 assert.equal((await call({action:'send-code',purpose:'worker',phoneNumber:worker,channel:'sms',authorized:true})).status,200)
 state.validCode=false
 assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:worker,code:'123456'})).status,400)
 assert.equal((await db.query('select verified_at from phone_verified_numbers')).rows[0].verified_at,null)
 assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:business,code:'123456'})).status,400)
 state.validCode=true
 assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:worker,code:'123456'})).status,200)
 assert.ok((await db.query('select verified_at from phone_verified_numbers')).rows[0].verified_at)
 assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:worker,code:'123456'})).status,400)
})
test('send and code-check limits persist across requests',async()=>{
 await setup()
 const start={action:'send-code',purpose:'worker',phoneNumber:worker,channel:'call',authorized:true}
 assert.equal((await call(start)).status,200);assert.equal((await call(start)).status,429)
 state.validCode=false
 for(let i=0;i<5;i++)assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:worker,code:'111111'})).status,400)
 assert.equal((await call({action:'verify-code',purpose:'worker',phoneNumber:worker,code:'111111'})).status,429)
 assert.equal(state.provider.filter(r=>r.path.endsWith('/VerificationCheck')).length,5)
})
test('verified settings persist, sync the dedicated agent and inject only the authorized destination',async()=>{
 await setup();await verify('worker',worker)
 const result=await call(save());assert.equal(result.status,200,JSON.stringify(result.body))
 const stored=(await db.query('select * from phone_setups')).rows[0]
 assert.equal(stored.sync_state,'synced');assert.equal(stored.revision,1)
 const allowed=await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')
 assert.equal(allowed.recepta_transfer_destination,worker)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,two,'agent_test')).recepta_transfer_allowed,'disabled')
 const tool=state.llm.general_tools.find(t=>t.name==='recepta_transfer_to_human')
 assert.equal(tool.transfer_destination.number,'{{recepta_transfer_destination}}')
 assert.equal(state.llm.default_dynamic_variables.recepta_transfer_allowed,'disabled')
 assert.equal(state.llm.default_dynamic_variables.custom,'keep')
 const updated=state.provider.find(r=>r.path.startsWith('/update-agent/'))
 assert.ok(JSON.parse(updated.body).webhook_events.includes('transfer_bridged'))
 assert.ok(JSON.parse(updated.body).webhook_events.includes('transcript_updated'))
 assert.equal((await call(save())).status,409)
 assert.equal((await call(null,'customer','GET')).body.destination.phone_number,worker)
 assert.equal(state.provider.some(r=>/create-phone-number|create-agent$/.test(r.path)),false)
})
test('business number verification and known forwarding-loop checks cover normalized and historical numbers',async()=>{
 await setup();await verify('worker',worker)
 assert.equal((await call(save({mode:'existing',businessNumber:business}))).status,400)
 await verify('business',business)
 assert.equal((await call(save({mode:'existing',businessNumber:business}))).status,200)
 await verify('worker',business)
 assert.equal((await call(save({workerNumber:'(647) 555-0189',expectedRevision:1}))).status,400)
 await verify('worker',ai)
 assert.equal((await call(save({workerNumber:ai,expectedRevision:1}))).status,400)
 assert.equal(await runtime.isReceptaLoopCaller(globalThis.__phoneDb,ai),true)
 assert.equal(await runtime.isReceptaLoopCaller(globalThis.__phoneDb,worker),false)
})
test('shared agent, premium and non-US/Canada destinations are rejected before mutation',async()=>{
 await setup();await verify('worker',worker)
 await assert.rejects(db.query("insert into agents(client_id,retell_agent_id) values($1,'agent_test')",[two]),/unique/)
 // A legacy database with a conflicting assignment must also fail closed.
 await db.exec('drop index recepta_dedicated_retell_agent')
 await db.query("insert into agents(client_id,retell_agent_id) values($1,'agent_test')",[two])
 assert.equal((await call(save())).status,409);assert.equal(state.provider.length,0)
 for(const number of ['+19005551234','+18765551234','+18005551234','+442071234567','4165550123 ext 3','sip:foo@bar'])assert.throws(()=>transfer.normalizeTransferNumber(number))
})
test('provider publication failure and final storage failure leave new transfers disabled',async()=>{
 await setup();await verify('worker',worker);state.failRetell=true
 assert.equal((await call(save())).status,502)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')).recepta_transfer_allowed,'disabled')
 state.failRetell=false;state.failFinish=true
 assert.equal((await call(save({expectedRevision:1}))).status,502)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')).recepta_transfer_allowed,'disabled')
})
test('disable succeeds after billing expires, verification expires and agent is removed',async()=>{
 await setup();await verify('worker',worker);assert.equal((await call(save())).status,200)
 await db.exec("update subscriptions set status='cancelled';update phone_verified_numbers set verified_at=now()-interval '100 days';update agents set retell_agent_id=null")
 assert.equal((await call({action:'disable'})).status,200)
 assert.equal((await db.query('select enabled from phone_transfer_destinations')).rows[0].enabled,false)
})
test('concurrent settings updates are serialized and stale revisions are rejected',async()=>{
 await setup();await verify('worker',worker)
 const results=await Promise.all([call(save()),call(save())])
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
})
test('reception cannot be marked connected by customer assertion',async()=>{
 await setup();assert.equal((await call({action:'confirm-test',kind:'reception',confirmed:true,expectedRevision:0})).status,409)
 await verify('worker',worker);await call(save())
 assert.equal((await call({action:'confirm-test',kind:'reception',confirmed:true,expectedRevision:1})).status,400)
 assert.equal((await db.query('select reception_observed_at from phone_setups')).rows[0].reception_observed_at,null)
 assert.equal((await call({action:'confirm-test',kind:'transfer',confirmed:true,expectedRevision:0})).status,409)
})
test('subsequent schedule sync preserves managed transfer, custom tools and business instructions',async()=>{
 await setup();await transfer.syncHumanCallTransfer({apiKey:'synthetic',agentId:'agent_test',destination:worker})
 await retell.syncRetellSchedule({apiKey:'synthetic',agentId:'agent_test',schedule:{mode:'24/7',timeZone:'America/Toronto',hours:[]}})
 await retell.syncRetellEmployeeSchedule({apiKey:'synthetic',agentId:'agent_test',employeeSchedule:'Keep staff hours',timeZone:'America/Toronto'})
 await retell.syncRetellSubscription({apiKey:'synthetic',agentId:'agent_test',active:true,phoneNumbers:[ai],demoMode:false})
 assert.ok(state.llm.general_tools.some(t=>t.name==='recepta_transfer_to_human'))
 assert.ok(state.llm.general_tools.some(t=>t.name==='keep_custom_tool'))
 assert.match(state.llm.general_prompt,/Business policy/)
 assert.match(state.llm.general_prompt,/RECEPTA MANAGED HUMAN TRANSFER/)
 assert.match(state.llm.general_prompt,/does not provide a live calendar/)
})
test('agent publication lock blocks overlapping hours and transfer updates before draft creation',async()=>{
 await setup()
 const lock=await globalThis.__phoneDb.rpc('acquire_retell_agent_sync',{p_agent_id:'agent_test',p_token:'00000000-0000-0000-0000-000000000099'})
 assert.equal(lock.data,true)
 await assert.rejects(transfer.syncHumanCallTransfer({apiKey:'synthetic',agentId:'agent_test',destination:worker}),/being updated/)
 await assert.rejects(retell.syncRetellSchedule({apiKey:'synthetic',agentId:'agent_test',schedule:{mode:'24/7',timeZone:'America/Toronto',hours:[]}}),/being updated/)
 assert.equal(state.provider.length,0)
})
test('managed transfer updates preserve custom content appended after their block',()=>{
 const added=transfer.updateHumanTransferPrompt('Keep original policy.',true)+'\n\nCustom policy after transfer.'
 assert.match(transfer.updateHumanTransferPrompt(added,true),/Custom policy after transfer/)
 assert.match(transfer.updateHumanTransferPrompt(added,false),/Custom policy after transfer/)
})
test('signed sparse transfer events persist idempotently without changing call completion or usage',async()=>{
 await setup();await db.query("insert into calls values('call_test',$1,'ended',3)",[one])
 const send=async(event,signature=true)=>{
  const body=JSON.stringify({event,call:{call_id:'call_test'},start_timestamp:123})
  const timestamp=Date.now();const digest=createHmac('sha256','synthetic').update(body+timestamp).digest('hex')
  return webhook(new Request('https://recepta.test/webhook',{method:'POST',headers:{'x-retell-signature':signature?`v=${timestamp},d=${digest}`:'invalid'},body}))
 }
 assert.equal((await send('transfer_started',false)).status,401)
 for(const e of ['transfer_bridged','transfer_started','transfer_bridged','transfer_cancelled','transfer_ended'])assert.equal((await send(e)).status,204)
 assert.equal((await db.query('select * from call_transfer_events')).rows.length,4)
 assert.deepEqual((await db.query('select call_status,lifecycle_rank from calls')).rows[0],{call_status:'ended',lifecycle_rank:3})
})
test('phone records and privileged operations are inaccessible to browser roles',async()=>{
 await setup()
 for (const role of ['anon','authenticated']) {
  await db.exec('set role '+role)
  await assert.rejects(db.query('select * from phone_verified_numbers'),/permission denied/)
  await assert.rejects(db.query("select consume_phone_limit('forged',10,60)"),/permission denied/)
  await assert.rejects(db.query('select disable_recepta_phone_transfer($1)',[two]),/permission denied/)
  await db.exec('reset role')
 }
 assert.equal((await db.query("select count(*)::int n from pg_class where relname in ('phone_setups','phone_verified_numbers','phone_transfer_destinations','phone_forwarding_sources','call_transfer_events') and relrowsecurity")).rows[0].n,5)
})
test('admin linking verifies account email, provider ownership and conflicting assignments before writes',async()=>{
 await setup();await db.exec('delete from agent_phone_numbers;delete from agents')
 const body={clientId:one,ownerEmail:'wrong@example.test',agentId:'agent_test',phoneNumber:ai,ownershipConfirmed:true}
 assert.equal((await link(rawRequest(body,'customer'))).status,403)
 assert.equal((await link(rawRequest(body,'admin'))).status,409)
 assert.equal(state.provider.length,0)
 body.ownerEmail='owner@example.test';state.conflictBinding=true
 assert.equal((await link(rawRequest(body,'admin'))).status,502)
 assert.equal((await db.query('select * from agents')).rows.length,0)
 state.conflictBinding=false
 assert.equal((await link(rawRequest(body,'admin'))).status,200)
 assert.equal((await db.query('select * from agents')).rows[0].client_id,one)
 assert.equal((await db.query('select * from agents')).rows[0].status,'setup')
 assert.equal((await link(rawRequest({...body,clientId:two},'admin'))).status,409)
})
test('carrier guides distinguish mobile, landline and VoIP and always include deactivation',()=>{
 assert.match(guide.forwardingGuide('rogers','mobile',ai).steps[0],/\*21\*4165550100#/)
 assert.match(guide.forwardingGuide('rogers','landline',ai).cancel,/\*73/)
 assert.match(guide.forwardingGuide('bell','mobile',ai).cancel,/Deactivate All/)
 assert.doesNotMatch(guide.forwardingGuide('other','voip',ai).steps.join(' '),/\*21\*/)
})
test('current and newly onboarded customers retain independent settings, agents and runtime destinations',async()=>{
 await setup()
 const otherAi='+16475550101',otherWorker='+16475550102'
 await db.query("insert into agents(client_id,retell_agent_id,phone_number,status) values($1,'agent_other',$2,'live')",[two,otherAi])
 await db.query("insert into agent_phone_numbers(client_id,phone_number,is_primary) values($1,$2,true)",[two,otherAi])
 await db.query("insert into subscriptions values($1,'active','sub_other',now()-interval '1 day',now()+interval '1 day')",[two])
 assert.equal((await call(null,'other','GET')).body.settings,null)
 await verify('worker',worker);await verify('worker',otherWorker,two)
 assert.equal((await call(save())).status,200)
 assert.equal((await call(save({workerNumber:otherWorker}),'other')).status,200)
 assert.deepEqual((await db.query('select client_id,revision,sync_state from phone_setups order by client_id')).rows,[
  {client_id:one,revision:1,sync_state:'synced'},{client_id:two,revision:1,sync_state:'synced'},
 ])
 assert.equal((await call(null,'customer','GET')).body.destination.phone_number,worker)
 assert.equal((await call(null,'other','GET')).body.destination.phone_number,otherWorker)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')).recepta_transfer_destination,worker)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,two,'agent_other')).recepta_transfer_destination,otherWorker)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_other')).recepta_transfer_allowed,'disabled')
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,two,'agent_test')).recepta_transfer_allowed,'disabled')
 assert.match(state.llms.llm_test.general_prompt,/Business policy/)
 assert.match(state.llms.llm_other.general_prompt,/Other customer business policy/)
 assert.doesNotMatch(state.llms.llm_other.general_prompt,/Old instructions/)
 assert.equal(state.llms.llm_other.default_dynamic_variables.other_customer,'keep')
 assert.equal((await call({action:'disable'})).status,200)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')).recepta_transfer_allowed,'disabled')
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,two,'agent_other')).recepta_transfer_destination,otherWorker)
 assert.equal(state.provider.filter(p=>p.path.startsWith('/publish-agent-version/agent_other')).length,1)
 assert.equal(state.provider.some(p=>/create-phone-number|create-agent$/.test(p.path)),false)
})

test('a customer can renew their own business verification while forwarding sources stay forbidden as worker lines',async()=>{
 await setup();await verify('business',business)
 assert.equal((await call(save({mode:'existing',businessNumber:business,transferEnabled:false,workerNumber:null}))).status,200)
 await db.exec("update phone_verified_numbers set verified_at=now()-interval '91 days'")
 assert.equal((await call({action:'send-code',purpose:'business',phoneNumber:business,channel:'call',authorized:true})).status,200)
 assert.equal((await call({action:'verify-code',purpose:'business',phoneNumber:business,code:'123456'})).status,200)
 assert.equal((await call({action:'send-code',purpose:'worker',phoneNumber:business,channel:'call',authorized:true})).status,400)
 await db.query("insert into subscriptions values($1,'active','sub_other',now()-interval '1 day',now()+interval '1 day')",[two])
 const count=state.provider.length
 assert.equal((await call({action:'send-code',purpose:'business',phoneNumber:business,channel:'call',authorized:true},'other')).status,400)
 assert.equal(state.provider.length,count)
 assert.equal((await db.query('select client_id from phone_forwarding_sources where phone_number=$1',[business])).rows[0].client_id,one)
})

test('invalid phone input is an actionable client error and never contacts a provider',async()=>{
 await setup()
 for(const number of ['sip:worker@example.test','+19005551234','4165550123 ext 8']) {
  const result=await call({action:'send-code',purpose:'worker',phoneNumber:number,channel:'sms',authorized:true})
  assert.equal(result.status,400);assert.match(result.body.error,/number|destination/)
 }
 assert.equal(state.provider.length,0)
})

test('agent assignment guards allow the owner and reject a second customer before provider work',async()=>{
 await setup()
 await ownership.assertAgentAssignable(globalThis.__phoneDb,'agent_test',one)
 await ownership.assertAgentAssignable(globalThis.__phoneDb,'agent_future')
 await assert.rejects(ownership.assertAgentAssignable(globalThis.__phoneDb,'agent_test',two),/already assigned.*another Recepta customer/)
 await assert.rejects(ownership.assertAgentAssignable(globalThis.__phoneDb,'agent_test'),/already assigned/)
 await assert.rejects(db.query('insert into agents(client_id,phone_number) values($1,$2)',[two,ai]),/unique/)
 assert.equal(state.provider.length,0)
})

test.after(async()=>{globalThis.fetch=originalFetch;await db?.close()})

const sendTool=async(name,args,signature=true)=>{
 const body=JSON.stringify({name,args,call:{call_id:'call_reception',agent_id:'agent_forged',metadata:{recepta_client_id:two}}})
 const timestamp=Date.now(),digest=createHmac('sha256','synthetic').update(body+timestamp).digest('hex')
 return phoneTool(new Request('https://recepta.test/tools',{method:'POST',headers:{'x-retell-signature':signature?`v=${timestamp},d=${digest}`:'invalid'},body}))
}
const canonicalCall=()=>({call_id:'call_reception',agent_id:'agent_test',call_type:'phone_call',direction:'inbound',call_status:'ongoing',to_number:ai,from_number:business,start_timestamp:Date.now()+100,metadata:{recepta_reservation_id:'fixture_reservation'}})
test('only a signed real inbound AI call with the current test code confirms reception',async()=>{
 await setup();await verify('worker',worker);await call(save())
 const started=await call({action:'start-reception-test',expectedRevision:1})
 assert.equal(started.status,200)
 const code=started.body.message.match(/code (\d{6})/)[1]
 state.canonicalCall=canonicalCall()
 assert.equal((await sendTool('recepta_confirm_reception',{code},false)).status,401)
 assert.equal((await sendTool('recepta_confirm_reception',{code:'000000'})).status,409)
 state.canonicalCall.direction='outbound'
 assert.equal((await sendTool('recepta_confirm_reception',{code})).status,409)
 state.canonicalCall=canonicalCall()
 assert.equal((await sendTool('recepta_confirm_reception',{code})).status,200)
 assert.ok((await db.query('select reception_observed_at from phone_setups')).rows[0].reception_observed_at)
 assert.equal((await db.query('select count(*)::int n from phone_reception_tests where client_id=$1',[two])).rows[0].n,0)
 await call(save({expectedRevision:1}))
 assert.equal((await sendTool('recepta_confirm_reception',{code})).status,409)
 assert.equal((await db.query('select reception_observed_at from phone_setups')).rows[0].reception_observed_at,null)
})
test('after-hours callbacks store all details and enqueue one existing notification job',async()=>{
 await setup();state.canonicalCall=canonicalCall()
 const args={caller_name:'Fixture caller',callback_number:business,reason:'Needs a worker',preferred_callback_time:'Tomorrow after 10am Toronto'}
 assert.equal((await sendTool('recepta_save_callback',args)).status,200)
 assert.equal((await sendTool('recepta_save_callback',args)).status,200)
 const rows=(await db.query('select client_id,caller_name,request_details,preferred_callback_time,answered_call from callback_requests')).rows
 assert.deepEqual(rows,[{client_id:one,caller_name:args.caller_name,request_details:args.reason,preferred_callback_time:args.preferred_callback_time,answered_call:true}])
 assert.equal((await db.query('select count(*)::int n from service_jobs')).rows[0].n,1)
 state.canonicalCall.agent_id='agent_unassigned'
 assert.equal((await sendTool('recepta_save_callback',args)).status,409)
})
test('schedule persistence and normalized legacy destinations cannot bypass new-call admission',async()=>{
 await setup();await verify('worker',worker)
 const transferSchedule={mode:'custom',timeZone:'America/Toronto',hours:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(day=>({day,open:true,start:'09:00',end:'21:00'}))}
 assert.equal((await call(save({transferSchedule}))).status,200)
 assert.deepEqual((await db.query('select transfer_schedule from phone_setups')).rows[0].transfer_schedule,transferSchedule)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test',60,new Date('2026-11-05T02:30:00Z'))).recepta_transfer_allowed,'disabled')
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test',60,new Date('2026-11-04T16:00:00Z'))).recepta_transfer_allowed,'enabled')
 await db.query("insert into phone_forwarding_sources values('(416) 555-0123',$1)",[two])
 assert.equal((await call(save({expectedRevision:1,transferEnabled:false}))).status,400)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test',60,new Date('2026-11-04T16:00:00Z'))).recepta_transfer_allowed,'disabled')
})
test('paid automatic setup reuses owned agents and journals separate new resources without duplicate creation',async()=>{
 await setup();process.env.RECEPTA_AUTO_PROVISION_ENABLED='true';process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID='agent_template'
 try{
  assert.equal(await provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,one),'agent_test')
  assert.equal(state.provider.length,0)
  await db.query("insert into subscriptions values($1,'active','sub_other',now()-interval '1 day',now()+interval '1 day')",[two])
  assert.equal(await provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,two),'agent_provisioned')
  assert.equal(await provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,two),'agent_provisioned')
  assert.equal(state.provider.filter(row=>row.path==='/create-agent').length,1)
  assert.equal(state.provider.filter(row=>row.path==='/create-retell-llm').length,1)
  assert.deepEqual((await db.query('select client_id from agents where retell_agent_id=\'agent_provisioned\'')).rows,[{client_id:two}])
 }finally{delete process.env.RECEPTA_AUTO_PROVISION_ENABLED;delete process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID}
})
test('unpaid and uncertain provider creation never create duplicate agents on retry',async()=>{
 await setup();process.env.RECEPTA_AUTO_PROVISION_ENABLED='true';process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID='agent_template'
 try{
  await assert.rejects(provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,two),/payment/)
  assert.equal(state.provider.length,0)
  await db.query("insert into subscriptions values($1,'active','sub_other',now()-interval '1 day',now()+interval '1 day')",[two])
  state.unknownCreation=true
  await assert.rejects(provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,two),/lost response/)
  await assert.rejects(provisioning.ensurePaidReceptionAgent(globalThis.__phoneDb,two),/uncertain outcome/)
  assert.equal(state.provider.filter(row=>row.path==='/create-agent').length,1)
  assert.equal((await db.query('select count(*)::int n from agents where client_id=$1',[two])).rows[0].n,0)
 }finally{delete process.env.RECEPTA_AUTO_PROVISION_ENABLED;delete process.env.RETELL_ONBOARDING_TEMPLATE_AGENT_ID}
})

test('different customer agents cannot share a provider LLM when syncing transfer settings',async()=>{
 await setup();await verify('worker',worker)
 await db.query("insert into agents(client_id,retell_agent_id,status) values($1,'agent_other','setup')",[two])
 state.sharedLlm=true
 const result=await call(save())
 assert.equal(result.status,502)
 assert.equal(state.provider.some(row=>row.path.startsWith('/update-retell-llm/')||row.path.startsWith('/update-agent/')||row.path.startsWith('/publish-agent-version/')),false)
 assert.equal((await runtime.resolveInboundTransfer(globalThis.__phoneDb,one,'agent_test')).recepta_transfer_allowed,'disabled')
})


test('email settings sync preserves unrelated analysis, requires analyzed events, and survives later schedule sync',async()=>{
 await setup();process.env.RECEPTA_CALL_EMAIL_ENABLED='true'
 const settings={callerEnabled:true,ownerFields:['custom'],callerFields:['summary','custom'],customFields:['Number of windows']}
 await retell.syncRetellSchedule({apiKey:'synthetic',agentId:'agent_test',schedule:{mode:'24/7',timeZone:'America/Toronto',hours:[]},callEmailSettings:settings})
 let writes=state.provider.filter(row=>row.path.startsWith('/update-agent/')&&JSON.parse(row.body).post_call_analysis_data)
 let payload=JSON.parse(writes.at(-1).body)
 assert.ok(payload.post_call_analysis_data.some(item=>item.name==='keep_existing_analysis'))
 assert.ok(!payload.post_call_analysis_data.some(item=>item.name==='recepta_detail_obsolete'))
 assert.ok(payload.post_call_analysis_data.some(item=>item.name==='recepta_caller_email_confirmed'&&item.type==='boolean'))
 assert.ok(payload.webhook_events.includes('call_analyzed'));assert.ok(payload.webhook_events.includes('transcript_updated'))
 assert.match(state.llm.general_prompt,/read it back carefully/);assert.match(state.llm.general_prompt,/one at a time/)
 await retell.syncRetellSchedule({apiKey:'synthetic',agentId:'agent_test',schedule:{mode:'24/7',timeZone:'America/Toronto',hours:[]}})
 assert.equal(JSON.parse(state.llm.default_dynamic_variables.recepta_call_email_settings).callerEnabled,true)
 assert.match(state.llm.general_prompt,/Number of windows/)
 assert.equal((state.llm.general_prompt.match(/\[RECEPTA MANAGED CALL EMAIL\]/g)??[]).length,1)
 delete process.env.RECEPTA_CALL_EMAIL_ENABLED
})
