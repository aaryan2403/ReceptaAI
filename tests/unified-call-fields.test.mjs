import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const compile = async path => {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const { normalizeCallEmailSettings, customCallFields, customCallFieldError, capturedCallFields } = await compile('src/lib/callEmailSettings.ts')
const { captureCallEmailDetails, emailFieldKey, mergeEmailAnalysis } = await compile('netlify/lib/callEmailCapture.ts')
const { buildCallNotification } = await compile('netlify/lib/callNotificationEmail.ts')
const options = [
  { label: 'Postcode', analysisKey: 'postcode', owner: true, caller: true },
  { label: 'Customer address', analysisKey: 'customer_address', owner: true, caller: false },
  { label: 'Windows requested', analysisKey: 'windows', owner: true, caller: true },
  { label: 'Callback required', analysisKey: 'callback_required', owner: true, caller: false },
]
const settings = () => normalizeCallEmailSettings({ callerEnabled: true, ownerFields: ['custom'], callerFields: ['custom'],
  customFields: options.map(field => field.label), customFieldOptions: options })

test('legacy labels keep their keys and audience while removed options cannot survive old-tab edits', () => {
  const legacy = normalizeCallEmailSettings({ customFields: [' Postcode ', 'postcode', 'Customer address'] })
  assert.deepEqual(legacy.customFields, ['postcode', 'Customer address'])
  assert.ok(customCallFields(legacy).every(field => field.owner && field.caller && !field.analysisKey))
  const oldTab = normalizeCallEmailSettings({ ...settings(), customFields: ['New question'] })
  assert.deepEqual(oldTab.customFields, ['New question'])
  assert.equal(customCallFields(oldTab)[0].analysisKey, '')
})

test('one extraction snapshot supplies matching dashboard and email values, with caller exclusions enforced', () => {
  const saved = settings()
  const snapshot = captureCallEmailDetails(saved, { postcode: 'M4P 0A1', customer_address: '12 Example Street', windows: 6, callback_required: false })
  assert.deepEqual(capturedCallFields(snapshot), [
    { label: 'Postcode', value: 'M4P 0A1' }, { label: 'Customer address', value: '12 Example Street' },
    { label: 'Windows requested', value: '6' }, { label: 'Callback required', value: 'false' },
  ])
  const input = { planName: 'Recepta Pro', businessName: 'Test business', ownerEmail: 'owner@example.test', callerEmail: 'caller@example.test',
    startedAt: '2026-11-08T12:00:00Z', durationSeconds: 60, timeZone: 'America/Toronto', settings: saved, customDetails: snapshot.customDetails }
  const owner = buildCallNotification(input), caller = buildCallNotification({ ...input, recipient: 'caller' })
  assert.match(owner.text, /Customer address: 12 Example Street/)
  assert.match(owner.text, /Callback required: false/)
  assert.match(caller.text, /Postcode: M4P 0A1/)
  assert.match(caller.text, /Windows requested: 6/)
  assert.doesNotMatch(caller.text, /12 Example Street|Callback required/)
  assert.doesNotMatch(buildCallNotification({ ...input, planName: 'Recepta Standard' }).text, /M4P 0A1|12 Example Street/)
})

test('mapping preserves existing types, extraction instructions and unrelated analysis fields', () => {
  const existing = options.map(field => ({ name: field.analysisKey, type: field.analysisKey === 'windows' ? 'number' : field.analysisKey === 'callback_required' ? 'boolean' : 'string', description: 'Keep my extraction rule', required: false }))
  existing.push({ name: 'unrelated_business_metric', type: 'number', description: 'Unrelated metric', required: true })
  const next = mergeEmailAnalysis(settings(), existing)
  for (const field of existing) assert.deepEqual(next.find(item => item.name === field.name), field)
  assert.equal(next.filter(item => item.name === 'postcode').length, 1)
  assert.ok(next.some(item => item.name === 'recepta_caller_email_confirmed'))
  assert.throws(() => mergeEmailAnalysis(settings(), []), /not found uniquely/)
})

test('new fields create extraction keys; missing or malformed values are never invented and redaction suppresses them', () => {
  const saved = normalizeCallEmailSettings({ customFields: ['Service needed'] })
  assert.ok(mergeEmailAnalysis(saved, []).some(item => item.name === emailFieldKey('Service needed')))
  assert.equal(captureCallEmailDetails(saved, {}).customDetails[0].value, 'Not provided')
  assert.equal(captureCallEmailDetails(saved, { [emailFieldKey('Service needed')]: { nested: 'private' } }).customDetails[0].value, 'Not provided')
  assert.deepEqual(captureCallEmailDetails(settings(), { postcode: 'private' }, true).customDetails, [])
})

test('duplicate or reserved mappings cannot replace confirmation and consent extraction', () => {
  assert.match(customCallFieldError([{ ...options[0], analysisKey: 'recepta_caller_email_confirmed' }]), /valid Retell/)
  assert.match(customCallFieldError([{ ...options[0] }, { ...options[1], analysisKey: 'postcode' }]), /only once/)
  assert.match(customCallFieldError([{ ...options[0] }, { ...options[0] }]), /different name/)
})

test('field exclusions also apply when appointment notes contain structured answers', () => {
  const config = normalizeCallEmailSettings({ ownerFields: ['appointment','custom'], customFields: ['Private detail'],
    customFieldOptions: [{label:'Private detail',analysisKey:'private detail',owner:false,caller:false}] })
  const mail = buildCallNotification({planName:'Recepta Pro',businessName:'Business',ownerEmail:'owner@example.test',startedAt:'2026-11-08T12:00:00Z',durationSeconds:60,timeZone:'America/Toronto',settings:config,customDetails:[{label:'Private detail',value:'Excluded answer'}],
    appointment:{status:'pending',timeZone:'America/Toronto',notes:JSON.stringify({version:1,details:[{label:'Private detail',value:'Excluded answer'}]})}})
  assert.doesNotMatch(mail.text,/Excluded answer/)
  assert.equal(customCallFieldError(customCallFields(config)),null)
})
