import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const one='00000000-0000-0000-0000-000000000001',two='00000000-0000-0000-0000-000000000002'
let users,requests,syncs,failSync,missingSchema
const reset=()=>{process.env.RECEPTA_CALL_EMAIL_ENABLED='true';users=new Map([one,two].map(id=>[id,{id,app_metadata:{keep:'preserved'},user_metadata:{appointment_custom_fields:['Legacy question']}}]));requests=[];syncs=[];failSync=false;missingSchema=false}
reset()
globalThis.__emailAdminDb={auth:{getUser:async token=>({data:{user:token?{id:token,email:token==='admin'?'admin@example.test':'client@example.test'}:null},error:null}),admin:{
  getUserById:async id=>({data:{user:users.get(id)},error:null}),updateUserById:async(id,data)=>{Object.assign(users.get(id),data);return{error:null}},
}},from:table=>{let id;const api={select:()=>api,limit:()=>api,then:(resolve,reject)=>Promise.resolve({data:[],error:missingSchema?{message:'column missing'}:null}).then(resolve,reject),eq:(key,value)=>{if(key==='id'||key==='client_id')id=value;return api},maybeSingle:async()=>({data:table==='clients'?{company_name:id===one?'First business':'Second business',contact_email:'owner@example.test'}:table==='subscriptions'?{plan_name:'Recepta Pro',status:'active'}:{retell_agent_id:'agent_'+id},error:null})};return api}}
globalThis.__emailAdminSync=async input=>{syncs.push(input);if(failSync)throw new Error('Synthetic publish failure');return{agentUpdated:true}}
const bundled=await build({entryPoints:['netlify/functions/admin-call-email.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'services',setup(b){
  b.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'db',namespace:'mock'}))
  b.onResolve({filter:/^\.\.\/lib\/retell$/},()=>({path:'retell',namespace:'mock'}))
  b.onResolve({filter:/^\.\.\/lib\/employeeSchedule$/},()=>({path:'schedule',namespace:'mock'}))
  b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:path==='db'?'export const createClient=()=>globalThis.__emailAdminDb':path==='retell'?'export const syncRetellSchedule=input=>globalThis.__emailAdminSync(input);export const normalizeAppointmentFields=input=>input??[]':'export const loadClientScheduleContext=async()=>({schedule:{mode:"24/7",timeZone:"America/Toronto",hours:[]}})'}))
}}]})
const handler=(await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default
process.env.RECEPTA_CALL_EMAIL_ENABLED='true';process.env.SUPABASE_URL='https://synthetic.test';process.env.SUPABASE_SECRET_KEY='synthetic';process.env.ADMIN_EMAIL='admin@example.test';process.env.RETELL_API_KEY='synthetic';process.env.RESEND_API_KEY='synthetic'
const request=(method,body,token='admin',id=one)=>new Request('https://synthetic.test?clientId='+id,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify({clientId:id,...body})}:{})})
const oldFetch=globalThis.fetch
test.after(()=>{globalThis.fetch=oldFetch})
test('only admins can read or change email settings and saving one tenant preserves the other',async()=>{
 reset();assert.equal((await handler(request('GET',null,'customer'))).status,403)
 const response=await handler(request('PUT',{settings:{callerEnabled:true,ownerFields:['custom'],customFields:['Number of windows']}}))
 assert.equal(response.status,200);assert.equal(users.get(one).app_metadata.keep,'preserved');assert.equal(users.get(one).app_metadata.recepta_call_email.callerEnabled,true)
 assert.equal(users.get(two).app_metadata.recepta_call_email,undefined);assert.deepEqual(syncs[0].callEmailSettings.customFields,['Number of windows'])
 assert.equal((await(await handler(request('GET'))).json()).settings.callerEnabled,true)
})
test('AI publication failure reports that settings were saved without claiming synchronization',async()=>{
 reset();failSync=true;const response=await handler(request('PUT',{settings:{callerEnabled:true}})),body=await response.json()
 assert.equal(response.status,502);assert.equal(body.saved,true);assert.match(body.error,/sync failed/);assert.equal(users.get(one).app_metadata.recepta_call_email.callerEnabled,true)
})
test('preview sends nothing, test samples go only to authenticated admin, and provider failure is not success',async()=>{
 reset();globalThis.fetch=async(url,options)=>{requests.push({url,mail:JSON.parse(options.body)});return Response.json({id:'synthetic_test'})}
 const preview=await handler(request('POST',{action:'preview',settings:{callerEnabled:true,customFields:['Number of windows']}}))
 const samples=await preview.json();assert.equal(requests.length,0);assert.match(samples.caller.text,/Sample answer/)
 const response=await handler(request('POST',{action:'send_test',role:'caller',to:'arbitrary@example.test'})),result=await response.json()
 assert.equal(response.status,200);assert.deepEqual(requests[0].mail.to,['admin@example.test']);assert.equal(result.accepted,true);assert.match(result.message,/does not confirm delivery/)
 globalThis.fetch=async()=>new Response('{}',{status:401})
 const failure=await handler(request('POST',{action:'send_test'}));assert.equal(failure.status,500);assert.match((await failure.json()).error,/authentication failed/)
})
test('Resend connection check requires a verified sender domain and never sends an email',async()=>{
 reset();process.env.CALL_NOTIFICATION_FROM_EMAIL='Recepta <notifications@mail.recepta.ca>'
 globalThis.fetch=async url=>{assert.equal(url,'https://api.resend.com/domains');return Response.json({data:[{name:'mail.recepta.ca',status:'pending'}]})}
 let result=await(await handler(request('POST',{action:'check_provider'}))).json();assert.equal(result.ready,false)
 globalThis.fetch=async()=>Response.json({data:[{name:'mail.recepta.ca',status:'verified'}]})
 result=await(await handler(request('POST',{action:'check_provider'}))).json();assert.equal(result.ready,true)
 delete process.env.CALL_NOTIFICATION_FROM_EMAIL
})


test('pre-migration rollout permits diagnostics and previews while blocking preference activation',async()=>{
 reset();process.env.RECEPTA_CALL_EMAIL_ENABLED='false'
 const result=await(await handler(request('GET'))).json();assert.equal(result.enabled,false)
 assert.equal((await handler(request('POST',{action:'preview'}))).status,200)
 assert.equal((await handler(request('PUT',{settings:{callerEnabled:true}}))).status,503)
 assert.equal(users.get(one).app_metadata.recepta_call_email,undefined)
})

test('normal admin saves preferences without publishing an agent when the schema is pending',async()=>{
 reset();missingSchema=true
 const before=await(await handler(request('GET'))).json();assert.equal(before.enabled,false)
 const response=await handler(request('PUT',{settings:{callerEnabled:true,customFields:['Service needed']}}))
 const result=await response.json()
 assert.equal(response.status,200);assert.equal(result.activationPending,true);assert.equal(result.synced,false)
 assert.equal(users.get(one).app_metadata.recepta_call_email.callerEnabled,true);assert.equal(syncs.length,0)
 assert.equal((await handler(request('POST',{action:'preview'}))).status,200)
 missingSchema=false
 const retry=await(await handler(request('PUT',{settings:result.settings}))).json()
 assert.equal(retry.synced,true);assert.equal(syncs.length,1)
})
