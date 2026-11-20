import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const compile = async entry => {
  const result = await build({ entryPoints:[entry],bundle:true,platform:'node',format:'esm',write:false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const { captureRetellBackup, resolveRetellRecoveryEngine, replaceArchivedRetellAgent } =
  await compile('netlify/lib/retellLifecycle.ts')
const { confirmUnpaidLifecycle, runProLifecycle } = await compile('netlify/lib/proLifecycle.ts')
const oldAgent = 'agent_original'
const phone = '+14165550100'
const retellAgent = {
  agent_id:oldAgent,version:4,is_published:true,voice_id:'retell-test',
  response_engine:{ type:'retell-llm',llm_id:'llm_original',version:3 },
}
const llm = {
  llm_id:'llm_original',version:3,general_prompt:'Existing plumbing receptionist',
  knowledge_base_ids:['kb_existing'],general_tools:[{ type:'transfer_call',name:'owner_transfer' }],
}
const response = (body,status=200) => new Response(body===null?null:JSON.stringify(body),{status})
const strip = path => String(path).replace('https://api.retellai.com','').split('?')[0]
const mockProvider = t => {
  const calls = []
  const state = { exists:true, shared:false, replacement:false, engine:true, ambiguous:false }
  t.mock.method(globalThis,'fetch',async (path,options={}) => {
    const endpoint = strip(path)
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ endpoint,method:options.method??'GET',body })
    if (endpoint==='/get-agent/'+oldAgent) return state.exists?response(retellAgent):response(null,404)
    if (endpoint==='/get-agent/agent_replacement') return response({
      ...retellAgent,agent_id:'agent_replacement',
      response_engine:state.engine?retellAgent.response_engine:{ type:'retell-llm',llm_id:'llm_replacement',version:0 },
    })
    if (endpoint.startsWith('/get-retell-llm/')) return state.engine?response(llm):response(null,404)
    if (endpoint==='/create-retell-llm') return response({ llm_id:'llm_replacement',version:0 },201)
    if (endpoint==='/v2/list-phone-numbers') return response({
      items:[{ phone_number:state.shared?'+14165550999':phone,outbound_agents:[{ agent_id:oldAgent,weight:1 }] }],
      has_more:false,
    })
    if (endpoint==='/delete-agent/'+oldAgent) {
      state.exists=false
      if (state.ambiguous) throw new Error('Synthetic timeout after deletion')
      return response(null,204)
    }
    if (endpoint==='/v2/list-agents') return response({
      items:state.replacement?[{ agent_id:'agent_replacement',agent_name:'Recepta recovered '+oldAgent }]:[],has_more:false,
    })
    if (endpoint==='/create-agent') {
      state.replacement=true
      return response({ agent_id:'agent_replacement' },201)
    }
    throw new Error('Unexpected provider request '+endpoint)
  })
  return { calls,state }
}

test('archive preserves the business script, knowledge and transfer tool, and rejects shared routing', async t => {
  const provider = mockProvider(t)
  const saved = await captureRetellBackup('synthetic',oldAgent,[phone])
  assert.deepEqual(saved.llm.general_tools,llm.general_tools)
  assert.deepEqual(saved.llm.knowledge_base_ids,llm.knowledge_base_ids)
  assert.equal(saved.llm.general_prompt,llm.general_prompt)
  assert.equal(saved.outbound[phone][0].agent_id,oldAgent)
  provider.state.shared=true
  await assert.rejects(captureRetellBackup('synthetic',oldAgent,[phone]),/another Retell phone number/)
  assert.equal(provider.calls.some(call=>call.method==='DELETE'),false)
})

test('recovery recreates a lost engine and reuses an already-created replacement', async t => {
  const provider = mockProvider(t)
  const saved = await captureRetellBackup('synthetic',oldAgent,[phone])
  provider.state.engine=false
  const engine = await resolveRetellRecoveryEngine('synthetic',saved)
  assert.equal(engine.llm_id,'llm_replacement')
  const first = await replaceArchivedRetellAgent('synthetic',oldAgent,saved,engine)
  const second = await replaceArchivedRetellAgent('synthetic',oldAgent,saved,engine)
  assert.equal(first,'agent_replacement')
  assert.equal(second,first)
  assert.equal(provider.calls.filter(call=>call.endpoint==='/create-agent').length,1)
  assert.deepEqual(provider.calls.find(call=>call.endpoint==='/create-retell-llm').body.general_tools,llm.general_tools)
})

test('a paid or replaced Stripe invoice blocks cleanup even if a webhook is late', async () => {
  let live = { id:'sub_current',status:'past_due',latest_invoice:'in_due',livemode:false }
  let invoice = { id:'in_due',status:'open',amount_remaining:29900,livemode:false }
  const stripe = { subscriptions:{ retrieve:async()=>live },invoices:{ retrieve:async()=>invoice } }
  const timeline = { reason:'nonpayment',stripe_id:'sub_current',invoice_id:'in_due' }
  assert.equal(await confirmUnpaidLifecycle(stripe,timeline,true),true)
  invoice={ ...invoice,status:'paid',amount_remaining:0 }
  assert.equal(await confirmUnpaidLifecycle(stripe,timeline,true),false)
  live={ ...live,latest_invoice:'in_new' }
  assert.equal(await confirmUnpaidLifecycle(stripe,timeline,true),false)
  live={ ...live,status:'active' }
  assert.equal(await confirmUnpaidLifecycle(stripe,{ ...timeline,reason:'cancellation' },true),false)
  live={ ...live,status:'canceled',livemode:true }
  assert.equal(await confirmUnpaidLifecycle(stripe,{ ...timeline,reason:'cancellation' },true),false)
})

test('worker archives before deleting, recovers a lost DELETE response, and never releases the line', async t => {
  const provider = mockProvider(t)
  t.mock.method(console,'error',()=>{})
  const result = data=>({ data,error:null })
  const timeline = { reason:'nonpayment',deadline:new Date(Date.now()-60000).toISOString() }
  const work = { client_id:'synthetic-client',agent_id:oldAgent,operation:null,timeline,notice_key:'synthetic-notice' }
  const lease = { lease:'leased',original_agent_id:oldAgent,backup:null }
  const finished = []
  const db = {
    rpc: async (name,args) => {
      if (name==='recepta_pro_lifecycle_work') return result([work])
      if (name==='recepta_pro_claim_lifecycle') return result(lease)
      if (name==='recepta_pro_timeline') return result(timeline)
      if (name==='recepta_pro_confirm_delete') return result(Boolean(lease.backup))
      if (name==='recepta_pro_finish_lifecycle') { finished.push(args.p_result);return result(true) }
      throw new Error(name)
    },
    from(table) {
      let changed
      let filter
      const api = {
        eq:(key,value)=>{ if (!filter) filter=[key,value]; return api },
        select:()=>api,
        maybeSingle:async ()=>{
          if (table==='agents') return result({ retell_agent_id:oldAgent,phone_number:phone,business_hours:'Not configured' })
          if (table==='recepta_pro_lifecycle') { Object.assign(lease,changed);return result({client_id:work.client_id}) }
          throw new Error(table)
        },
        update:values=>{ changed=values;return api },
        upsert:async()=>result(null),
        then:(resolve,reject)=>Promise.resolve(result(table==='agents'?[{client_id:work.client_id}]:[])).then(resolve,reject),
      }
      return api
    },
  }
  provider.state.ambiguous=true
  await runProLifecycle(db,{ key:'synthetic',preview:true })
  assert.deepEqual(finished,['retry'])
  work.operation='deleting'
  await runProLifecycle(db,{ key:'synthetic',preview:true })
  assert.deepEqual(finished,['retry','deleted'])
  assert.equal(lease.backup.llm.general_prompt,llm.general_prompt)
  assert.deepEqual(provider.calls.filter(call=>call.method==='DELETE').map(call=>call.endpoint),['/delete-agent/'+oldAgent])
})
