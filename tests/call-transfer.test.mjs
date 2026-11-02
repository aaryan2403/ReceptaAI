import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['netlify/lib/callTransfer.ts'],
  platform: 'node',
  format: 'esm',
  bundle: true,
  write: false,
})
const code = result.outputFiles[0].text
const transfer = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

test('normalizes US/Canadian worker phone numbers', () => {
  assert.equal(transfer.normalizeTransferNumber('(416) 555-0123'), '+14165550123')
  assert.equal(transfer.normalizeTransferNumber('+1 647 555 0189'), '+16475550189')
  assert.equal(transfer.normalizeTransferNumber(null), null)
  assert.throws(() => transfer.normalizeTransferNumber('+442071234567'))
  assert.throws(() => transfer.normalizeTransferNumber('+19005551234'))
})

test('builds a warm Retell transfer tool with an authorized static number', () => {
  const tool = transfer.buildHumanTransferTool('+14165550123')
  assert.equal(tool.type, 'transfer_call')
  assert.deepEqual(tool.transfer_destination, {
    type: 'predefined',
    number: '+14165550123',
  })
  assert.equal(tool.transfer_option.type, 'warm_transfer')
  assert.equal(tool.transfer_option.show_transferee_as_caller, false)
  assert.equal(tool.transfer_option.private_handoff_option.type, 'prompt')
})

test('preserves other Retell tools while enabling and disabling transfers', () => {
  const tools = [{ type: 'end_call', name: 'end_call' }]
  const enabled = transfer.updateHumanTransferTools(tools, '+14165550123')
  assert.equal(enabled.length, 2)
  assert.equal(enabled[0].name, 'end_call')
  assert.equal(transfer.updateHumanTransferTools(enabled, null).length, 1)
  assert.equal(transfer.updateHumanTransferTools(enabled, '+16475550189').length, 2)
  assert.throws(() => transfer.updateHumanTransferTools(
    [{ type: 'transfer_call', name: 'transfer_call' }], '+14165550123'
  ))
})

test('managed transfer prompt can be safely toggled', () => {
  const base = 'Welcome to the business.\n\n[RECEPTA MANAGED HOURS]\nDo not invent hours.'
  const withTransfer = transfer.updateHumanTransferPrompt(base, true)
  assert.match(withTransfer, /recepta_transfer_to_human/)
  assert.equal((withTransfer.match(/\[RECEPTA MANAGED HUMAN TRANSFER\]/g) ?? []).length, 1)
  const updated = transfer.updateHumanTransferPrompt(withTransfer, true)
  assert.equal((updated.match(/\[RECEPTA MANAGED HUMAN TRANSFER\]/g) ?? []).length, 1)
  assert.equal(transfer.updateHumanTransferPrompt(updated, false), base)
})

test('Retell sync updates a draft version and publishes it', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  const responses = [
    { items: [{ version: 4, is_published: true }] },
    { version: 5, response_engine: { type: 'retell-llm', llm_id: 'llm_test', version: 5 } },
    { general_prompt: 'Business receptionist', general_tools: [{ type: 'end_call', name: 'end_call' }] },
    { llm_id: 'llm_test' },
    { agent_id: 'agent_test' },
  ]
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify(responses.shift()), { status: 200 })
  }
  try {
    await transfer.syncHumanCallTransfer({
      apiKey: 'mock-key',
      agentId: 'agent_test',
      destination: '+14165550123',
    })
    assert.equal(calls.length, 5)
    assert.ok(calls[3].url.includes('/update-retell-llm/'))
    const patch = JSON.parse(calls[3].options.body)
    assert.equal(patch.general_tools.find((x) => x.name === 'recepta_transfer_to_human')
      .transfer_destination.number, '+14165550123')
    assert.ok(calls[4].url.includes('/publish-agent-version/'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
