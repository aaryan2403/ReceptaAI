import test, { before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { build } from 'esbuild'
import { localBookingTime, bookingFormTime } from '../src/lib/bookingTime.ts'

const client='00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002'
const db=new PGlite()
const start=new Date(Date.now()+7*86400000);start.setUTCHours(15,0,0,0)
const at=(minutes=0)=>new Date(start.getTime()+minutes*60000).toISOString()
const run=async(sql,values=[])=> (await db.query(sql,values)).rows
const reserve=async(key,minutes=0,duration=30,extra={},id=null,version=null)=> (await run('select public.reserve_recepta_booking($1,$2,$3,$4,$5) as result',[client,key,JSON.stringify({customer_name:'Synthetic caller',service:'Consultation',start:at(minutes),duration_minutes:duration,source:'dashboard',...extra}),id,version]))[0].result
let plan='Recepta Pro', authenticated=true, calledFetch=[]
const originalFetch=globalThis.fetch
const identifier=s=>{assert.match(s,/^[a-z_]+$/);return `"${s}"`}
const query=(table)=>{
  let operation='select',columns='*',payload,ordering='',max='',single=false
  const clauses=[],values=[]
  const filter=(column,op,value)=>{values.push(value);clauses.push(`${identifier(column)} ${op} $${values.length}`);return api}
  const execute=async()=>{
    try {
      if(table==='subscriptions') {
        const rows=await run('select * from subscriptions where client_id=$1',[client]);if(rows[0])rows[0].plan_name=plan
        return {data:single?rows[0]:rows,error:null}
      }
      let sql
      if(operation==='select')sql=`select ${columns} from public.${identifier(table)}${clauses.length?' where '+clauses.join(' and '):''}${ordering}${max}`
      else if(operation==='delete')sql=`delete from public.${identifier(table)}${clauses.length?' where '+clauses.join(' and '):''} returning ${columns}`
      else if(operation==='update') {
        const set=Object.entries(payload).map(([k,v])=>{values.push(typeof v==='object'&&v!==null?JSON.stringify(v):v);return `${identifier(k)}=$${values.length}`})
        sql=`update public.${identifier(table)} set ${set.join(',')}${clauses.length?' where '+clauses.join(' and '):''} returning ${columns}`
      } else throw new Error('Test fixture does not support this operation.')
      const rows=await run(sql,values)
      return {data:single?rows[0]??null:rows,error:null}
    }catch(e){return{data:null,error:{message:e.message}}}
  }
  const api={select:(s='*')=>{columns=s.split(',').map(x=>x==='*'?'*':identifier(x)).join(',');return api},eq:(k,v)=>filter(k,'=',v),gt:(k,v)=>filter(k,'>',v),lt:(k,v)=>filter(k,'<',v),gte:(k,v)=>filter(k,'>=',v),lte:(k,v)=>filter(k,'<=',v),
    order:(k,opts)=>{ordering=` order by ${identifier(k)} ${opts?.ascending===false?'desc':'asc'}`;return api},limit:n=>{max=` limit ${Number(n)}`;return api},delete:()=>{operation='delete';return api},update:p=>{operation='update';payload=p;return api},maybeSingle:()=>{single=true;return execute()},then:(a,b)=>execute().then(a,b)}
  return api
}
globalThis.__bookingDb={from:query,auth:{getUser:async()=>({data:{user:authenticated?{id:client,user_metadata:{}}:null},error:null})},rpc:async(name,args)=>{
  try{
    const keys=Object.keys(args),values=Object.values(args).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v)
    const call=`public.${identifier(name)}(${keys.map((k,i)=>`${identifier(k)}=>$${i+1}`).join(',')})`
    const rows=await run(name==='claim_recepta_calendar_jobs'?`select * from ${call}`:`select ${call} as result`,values)
    return{data:name==='claim_recepta_calendar_jobs'?rows:rows[0]?.result,error:null}
  }catch(e){return{data:null,error:{message:e.message}}}
}}
const compile=async(path)=>{
  const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'synthetic',setup(b){b.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'db',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const createClient=()=>globalThis.__bookingDb',loader:'js'}))}}]})
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
let api,retell,google,calendar,callback,syncRetell
before(async()=>{
  process.env.SUPABASE_URL='https://synthetic.test';process.env.SUPABASE_SECRET_KEY='synthetic';process.env.RETELL_API_KEY='synthetic'
  process.env.GOOGLE_CLIENT_ID='synthetic';process.env.GOOGLE_CLIENT_SECRET='synthetic';process.env.GOOGLE_CALENDAR_TOKEN_KEY=Buffer.alloc(32,1).toString('base64');process.env.URL='https://synthetic.test'
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table clients(id uuid primary key,deletion_pending boolean default false);
    create table subscriptions(client_id uuid,plan_name text,status text,stripe_subscription_id text,current_period_start timestamptz,current_period_end timestamptz);
    create table agents(client_id uuid,retell_agent_id text,business_hours text);
    create table employees(id uuid,client_id uuid,name text,role text,is_active boolean);
    create table employee_schedules(employee_id uuid,day_of_week integer,is_working boolean,start_time text,end_time text);
    create table employee_calendar_blocks(id uuid,client_id uuid,employee_id uuid,starts_at timestamptz,ends_at timestamptz);
    create table appointments(id uuid primary key default gen_random_uuid(),client_id uuid not null,retell_call_id text,
      customer_name text,customer_email text,customer_phone text,company_name text,service text,notes text,status text not null default 'booked',source text not null,
      appointment_time timestamptz,appointment_end_time timestamptz,duration_minutes integer,employee_id uuid,
      created_at timestamptz default now(),updated_at timestamptz default now());
    create unique index appointments_retell_call_id_key on appointments(retell_call_id) where retell_call_id is not null;`)
  await db.exec(await readFile('supabase/migrations/20261014055537_appointment_request_intake.sql','utf8'))
  await db.exec(await readFile('supabase/migrations/20261028191236_shared_booking_capacity.sql','utf8'))
  api=(await compile('netlify/functions/bookings.ts')).default
  retell=(await compile('netlify/functions/retell-booking.ts')).default
  google=await compile('netlify/lib/googleCalendar.ts')
  calendar=(await compile('netlify/functions/google-calendar.ts')).default
  callback=(await compile('netlify/functions/google-calendar-callback.ts')).default
  syncRetell=(await compile('netlify/lib/retell.ts')).syncRetellSchedule
})
beforeEach(async()=>{
  await db.exec('truncate clients,subscriptions,agents,employees,employee_schedules,employee_calendar_blocks,appointments cascade')
  await run('insert into clients(id) values($1),($2)',[client,other])
  await run("insert into subscriptions values($1,'Recepta Pro','active','synthetic_sub',now()-interval '1 day',now()+interval '90 days')",[client])
  await run("insert into agents values($1,'agent_synthetic','24/7')",[client])
  await run('insert into booking_settings(client_id,enabled,capacity) values($1,true,3)',[client])
  plan='Recepta Pro';authenticated=true;calledFetch=[]
  globalThis.fetch=async(url,init)=>{calledFetch.push([String(url),init]);throw new Error('Unexpected network request in synthetic test.')}
})
after(async()=>{globalThis.fetch=originalFetch;delete globalThis.__bookingDb;await db.close()})
const signed=(name,args={})=>{
  const body=JSON.stringify({name,args,call:{call_id:'call_synthetic',agent_id:'agent_synthetic',metadata:{recepta_client_id:client}}})
  const timestamp=Date.now(),sig=createHmac('sha256','synthetic').update(`${body}${timestamp}`).digest('hex')
  return new Request('https://synthetic.test',{method:'POST',headers:{'x-retell-signature':`v=${timestamp},d=${sig}`},body})
}
const request=(method='GET',body)=>new Request('https://synthetic.test',{method,headers:{authorization:'Bearer synthetic'},body:body?JSON.stringify(body):undefined})

test('offline and AI bookings share a three-person capacity; fourth overlapping booking is refused',async()=>{
  await reserve('offline-one');await reserve('offline-two',0,30,{source:'dashboard'})
  const booked=await retell(signed('recepta_book_appointment',{customer_name:'AI caller',start:at(),service:'Consultation'}))
  assert.equal(booked.status,200);assert.equal((await booked.json()).status,'booked')
  await assert.rejects(reserve('fourth'),/That time is full/)
  const options=await (await retell(signed('recepta_check_availability',{start:at()}))).json()
  assert.equal(options.options[0].start,at(30))
  assert.equal((await run('select count(*)::int as n from appointments'))[0].n,3)
})
test('peak occupancy handles partial overlap, back-to-back events and buffers',async()=>{
  await run('update booking_settings set capacity=2')
  await reserve('first',0,30);await reserve('second',30,30)
  await reserve('spanning',0,60)
  await assert.rejects(reserve('full-middle',15),/full/)
  await reserve('after',60)
  await db.exec('delete from appointments;update booking_settings set capacity=1,buffer_minutes=15')
  await reserve('buffered',0,30)
  await assert.rejects(reserve('too-close',45),/full/)
  await reserve('enough-gap',60)
})
test('parallel requests cannot consume the last place twice and retry keys do not duplicate',async()=>{
  await run('update booking_settings set capacity=1')
  const results=await Promise.allSettled([reserve('simultaneous-one'),reserve('simultaneous-two')])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  const first=results.find(r=>r.status==='fulfilled').value
  const again=await reserve(first.booking_key)
  assert.equal(again.id,first.id)
  assert.equal((await run('select count(*)::int as n from appointments'))[0].n,1)
})
test('reschedule and cancellation release capacity, reject stale edits and enforce tenant ownership',async()=>{
  await run('update booking_settings set capacity=1')
  const first=await reserve('first')
  const moved=await reserve('first',60,30,{},first.id,first.booking_version)
  assert.equal(moved.booking_version,2)
  await reserve('new-in-old-slot')
  await assert.rejects(reserve('first',90,30,{},first.id,1),/changed/)
  await run('select cancel_recepta_booking($1,$2,$3)',[client,moved.id,moved.booking_version])
  await reserve('new-in-freed-slot',60)
  await assert.rejects(run('select cancel_recepta_booking($1,$2,$3)',[other,moved.id,3]),/changed/)
})
test('pending requests promote to real reservations without duplicate call records',async()=>{
  await run('select capture_recepta_appointment_request($1,$2,$3)',[client,'call_synthetic',JSON.stringify({customer_name:'Pending caller'})])
  const response=await retell(signed('recepta_book_appointment',{customer_name:'Pending caller',start:at()}))
  assert.equal(response.status,200)
  assert.equal((await (await retell(signed('recepta_book_appointment',{customer_name:'Pending caller',start:at()}))).json()).status,'booked')
  const rows=await run('select * from appointments');assert.equal(rows.length,1);assert.equal(rows[0].status,'booked');assert.ok(rows[0].appointment_time)
})
test('Standard, unpaid and unsigned callers cannot use booking tools or the Pro dashboard API',async()=>{
  plan='Recepta Standard';assert.equal((await api(request())).status,403);assert.equal((await retell(signed('recepta_check_availability',{start:at()}))).status,403)
  assert.equal((await calendar(request())).status,403)
  plan='Recepta Pro';await run("update subscriptions set current_period_end=now()-interval '1 second'")
  assert.equal((await retell(signed('recepta_book_appointment',{customer_name:'Caller',start:at()}))).status,403)
  assert.equal((await api(request())).status,200)
  assert.equal((await api(request('POST',{customer_name:'Caller',start:at()}))).status,403)
  assert.equal((await retell(new Request('https://synthetic.test',{method:'POST',body:'{}'}))).status,401)
  authenticated=false;assert.equal((await api(request())).status,401)
})
test('staff API saves and edits offline bookings, rejects a fourth booking and malformed updates',async()=>{
  await run('update booking_settings set enabled=false')
  const input={booking_key:'staff-api',customer_name:'Staff entry',service:'Consultation',start:at(),duration_minutes:30}
  let response=await api(request('POST',input));assert.equal(response.status,200)
  const record=(await response.json()).appointments.find(a=>a.booking_key==='staff-api')
  assert.ok(record?.id)
  response=await api(request('PATCH',{...input,id:record.id,version:record.booking_version,start:at(60)}));assert.equal(response.status,200)
  await reserve('same-slot-one',60);await reserve('same-slot-two',60)
  response=await api(request('POST',{...input,booking_key:'fourth',start:at(60)}));assert.equal(response.status,409)
  assert.equal((await api(request('PATCH',input))).status,400)
  assert.equal((await api(request('PATCH',{...input,id:'00000000-0000-0000-0000-000000000099',version:1}))).status,409)
})
test('disconnect pauses AI booking atomically while allowing staff to populate the offline ledger',async()=>{
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token) values($1,'synthetic')",[client])
  await run("insert into booking_calendar_events(client_id,calendar_id,event_id,starts_at,ends_at) values($1,'calendar','external',$2,$3)",[client,at(),at(30)])
  await run('select disconnect_recepta_calendar($1)',[client])
  assert.equal((await run('select enabled from booking_settings'))[0].enabled,false)
  assert.equal((await run('select count(*)::int as n from google_calendar_connections'))[0].n,0)
  assert.equal((await run('select count(*)::int as n from booking_calendar_events'))[0].n,0)
  await reserve('staff-first')
  await assert.rejects(reserve('ai-cannot-resume',30,30,{source:'retell'}),/not enabled/)
})
test('disabled booking falls back to requests, and server rejects forged or tenant-mismatched agents',async()=>{
  await run('update booking_settings set enabled=false')
  const result=await (await retell(signed('recepta_check_availability',{start:at()}))).json()
  assert.equal(result.enabled,false);assert.match(result.instruction,/request/)
  await assert.rejects(reserve('disabled',0,30,{source:'retell'}),/not enabled/)
  await reserve('staff-while-ai-disabled')
  await run('update agents set client_id=$1',[other])
  assert.equal((await retell(signed('recepta_check_availability',{start:at()}))).status,403)
})
test('connected Google events count toward capacity and failed/stale reads prevent new reservations',async()=>{
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token,selected_calendars,write_calendar_id,synced_at) values($1,'synthetic','[{\"id\":\"calendar\"}]','calendar',now())",[client])
  await run("insert into booking_calendar_events(client_id,calendar_id,event_id,starts_at,ends_at) values($1,'calendar','offline-google',$2,$3)",[client,at(),at(30)])
  await reserve('one');await reserve('two');await assert.rejects(reserve('three'),/full/)
  await run("update google_calendar_connections set synced_at=now()-interval '2 minutes'")
  await assert.rejects(reserve('stale',60),/must be refreshed/)
  await run("update google_calendar_connections set synced_at=now(),sync_error='synthetic failure'")
  await assert.rejects(reserve('failure',60),/must be refreshed/)
})
test('Google refresh is complete before replacement; paginated reads and all-day events are respected',async()=>{
  const encrypted=google.encryptGoogleToken('synthetic-refresh')
  assert.equal(google.decryptGoogleToken(encrypted),'synthetic-refresh')
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token,selected_calendars,write_calendar_id) values($1,$2,$3,'calendar')",[client,encrypted,JSON.stringify([{id:'calendar',timeZone:'America/Toronto'}])])
  globalThis.fetch=async(url)=>{
    if(String(url).includes('/token'))return Response.json({access_token:'synthetic-access'})
    if(String(url).includes('pageToken='))return Response.json({items:[{id:'all-day',start:{date:'2026-11-03'},end:{date:'2026-11-04'}}]})
    return Response.json({items:[{id:'busy',start:{dateTime:at()},end:{dateTime:at(30)}}],nextPageToken:'page-two'})
  }
  await google.syncGoogleAvailability(globalThis.__bookingDb,client)
  const rows=await run('select * from booking_calendar_events order by event_id');assert.equal(rows.length,2)
  assert.equal(rows[0].starts_at.toISOString(),'2026-11-03T05:00:00.000Z')
  globalThis.fetch=async(url)=>String(url).includes('/token')?Response.json({access_token:'synthetic-access'}):new Response('',{status:503})
  await assert.rejects(google.syncGoogleAvailability(globalThis.__bookingDb,client),/verify Google/)
  assert.equal((await run('select count(*)::int as n from booking_calendar_events'))[0].n,2)
  assert.ok((await run('select sync_error from google_calendar_connections'))[0].sync_error)
})
test('calendar mirror jobs are durable and idempotent, and managed events are not counted twice',async()=>{
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token,selected_calendars,write_calendar_id,synced_at) values($1,$2,'[{\"id\":\"calendar\"}]','calendar',now())",[client,google.encryptGoogleToken('synthetic')])
  const booking=await reserve('mirrored')
  globalThis.fetch=async(url)=>String(url).includes('/token')?Response.json({access_token:'synthetic'}):new Response('',{status:503})
  await google.deliverGoogleBookingJobs(globalThis.__bookingDb,client)
  assert.match((await run('select last_error from booking_calendar_jobs'))[0].last_error,/retry/)
  await run('update booking_calendar_jobs set retry_at=now()')
  globalThis.fetch=async(url,init)=>{calledFetch.push([String(url),init]);if(String(url).includes('/token'))return Response.json({access_token:'synthetic'});return Response.json({id:'synthetic-event'})}
  await google.deliverGoogleBookingJobs(globalThis.__bookingDb,client)
  assert.equal((await run('select count(*)::int as n from booking_calendar_jobs'))[0].n,0)
  const event={calendar_id:'calendar',event_id:'recepta'+booking.id.replaceAll('-',''),starts_at:at(),ends_at:at(30),cancelled:false}
  await run('select sync_recepta_calendar_snapshot($1,$2,now())',[client,JSON.stringify([event])])
  assert.equal((await run('select recepta_booking_remaining($1,$2,$3) as n',[client,at(),at(30)]))[0].n,2)
  event.starts_at=at(60);event.ends_at=at(90)
  await run('select sync_recepta_calendar_snapshot($1,$2,now())',[client,JSON.stringify([event])])
  assert.equal((await run('select appointment_time from appointments'))[0].appointment_time.toISOString(),at(60))
  await run('select sync_recepta_calendar_snapshot($1,$2,now())',[client,JSON.stringify([{...event,cancelled:true}])])
  assert.equal((await run('select status from appointments'))[0].status,'cancelled')
})
test('OAuth callback rejects missing state and replay; browser never receives stored tokens',async()=>{
  assert.equal((await callback(new Request('https://synthetic.test/.netlify/functions/google-calendar-callback?code=forged'))).status,303)
  assert.equal(calledFetch.length,0)
  await run('insert into google_calendar_oauth_states(state_hash,client_id,browser_hash,expires_at) values($1,$2,$3,now()+interval \'5 minutes\')',[google.hashGoogleState('synthetic-state'),client,google.hashGoogleState('synthetic-browser')])
  globalThis.fetch=async(url)=>{calledFetch.push(String(url));return new Response('',{status:400})}
  const valid=new Request('https://synthetic.test/.netlify/functions/google-calendar-callback?state=synthetic-state&code=synthetic',{headers:{cookie:'recepta_google_oauth=synthetic-browser'}})
  await callback(valid);assert.equal(calledFetch.length,1)
  await callback(valid);assert.equal(calledFetch.length,1)
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token) values($1,'must-not-leak')",[client])
  const response=await api(request());assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/must-not-leak|encrypted_refresh_token/)
  assert.equal((await run("select has_table_privilege('authenticated','google_calendar_connections','select') as allowed"))[0].allowed,false)
  assert.equal((await run("select has_function_privilege('authenticated','reserve_recepta_booking(uuid,text,jsonb,uuid,integer)','execute') as allowed"))[0].allowed,false)
  assert.equal((await run("select has_table_privilege('authenticated','appointments','update') as allowed"))[0].allowed,false)
})
test('a snapshot made before calendar selection changed cannot overwrite new availability',async()=>{
  await run("insert into google_calendar_connections(client_id,encrypted_refresh_token) values($1,'synthetic')",[client])
  await assert.rejects(run('select sync_recepta_calendar_snapshot($1,$2,now(),now()-interval \'1 day\')',[client,'[]']),/connection changed/)
})
test('business timezone conversion handles phone timezone differences and rejects nonexistent DST times',()=>{
  assert.equal(localBookingTime('2026-11-03T14:00','America/Toronto'),'2026-11-03T19:00:00.000Z')
  assert.equal(bookingFormTime('2026-11-03T19:00:00Z','America/Toronto'),'2026-11-03T14:00')
  assert.throws(()=>localBookingTime('2027-03-14T02:30','America/Toronto'),/does not exist/)
  assert.throws(()=>localBookingTime('2026-11-01T01:30','America/Toronto'),/occurs twice/)
})
test('business and employee hours are checked across full duration, and the same employee cannot overlap',async()=>{
  const employee='00000000-0000-0000-0000-000000000003'
  await run("insert into employees values($1,$2,'Synthetic staff','Stylist',true)",[employee,client])
  for(let d=0;d<7;d++)await run("insert into employee_schedules values($1,$2,true,'09:00','17:00')",[employee,d])
  await reserve('employee',0,30,{employee_id:employee})
  const response=await retell(signed('recepta_book_appointment',{customer_name:'Other caller',start:at(),employee_id:employee}))
  assert.equal(response.status,409)
  const result=await (await retell(signed('recepta_check_availability',{start:at(),employee_id:employee}))).json()
  assert.ok(!result.options.some(o=>o.start===at()))
  await run('update agents set business_hours=$1',[JSON.stringify({mode:'custom',timeZone:'America/Toronto',hours:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(day=>({day,open:true,start:'09:00',end:'10:30'}))})])
  const rejected=await retell(signed('recepta_book_appointment',{customer_name:'Too long',start:at(),duration_minutes:480}))
  assert.equal(rejected.status,409)
})
test('live booking tools are installed only on explicit Pro enable and preserved on later schedule syncs',async()=>{
  let existing=[],written
  globalThis.fetch=async(url,init)=>{
    const path=new URL(url).pathname
    if(path.startsWith('/list-agent-versions'))return Response.json({items:[{version:1,is_published:true}]})
    if(path.startsWith('/create-agent-version'))return Response.json({version:2,response_engine:{type:'retell-llm',llm_id:'synthetic_llm',version:2}})
    if(path.startsWith('/get-retell-llm'))return Response.json({general_prompt:'Existing business instructions',general_tools:existing})
    if(path.startsWith('/update-retell-llm')){written=JSON.parse(init.body);return Response.json({})}
    return Response.json({})
  }
  const input={apiKey:'synthetic',agentId:'agent_synthetic',schedule:{mode:'24/7',timeZone:'America/Toronto',hours:[]}}
  await syncRetell(input)
  assert.deepEqual(written.general_tools.map(t=>t.name),['recepta_save_appointment_details'])
  await syncRetell({...input,liveBookingTools:true})
  assert.ok(written.general_tools.some(t=>t.name==='recepta_book_appointment'))
  assert.match(written.general_prompt,/Only a successful tool result with status booked/)
  existing=written.general_tools
  await syncRetell(input)
  assert.ok(written.general_tools.some(t=>t.name==='recepta_check_availability'))
})
