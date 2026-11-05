import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
const compile = async path => {
  const output = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const { normalizeTransferSchedule, defaultTransferSchedule } = await compile('src/lib/transferSchedule.ts')
const { transferWindowOpen } = await compile('netlify/lib/transferSchedule.ts')
const custom = (start = '09:00', end = '21:00', timeZone = 'America/Toronto') => ({ ...defaultTransferSchedule(), mode: 'custom', timeZone, hours: defaultTransferSchedule().hours.map(day => ({ ...day, start, end })) })
test('transfer cutoff is exclusive and covers the entire enforced call lifetime', () => {
  const setting = custom()
  assert.equal(transferWindowOpen(setting, null, 600, new Date('2026-11-05T00:30:00Z')), true) // 19:30 Toronto
  assert.equal(transferWindowOpen(setting, null, 600, new Date('2026-11-05T01:59:00Z')), false)
  assert.equal(transferWindowOpen(setting, null, 1, new Date('2026-11-05T02:00:00Z')), false)
  assert.equal(transferWindowOpen(setting, null, 600, new Date('2026-11-04T13:59:00Z')), false)
})
test('time zones, overnight windows and closed days remain independent for each customer', () => {
  const at = new Date('2026-11-05T02:30:00Z')
  assert.equal(transferWindowOpen(custom(), null, 60, at), false)
  assert.equal(transferWindowOpen(custom('09:00', '21:00', 'America/Vancouver'), null, 60, at), true)
  const overnight = custom('21:00', '02:00')
  overnight.hours.forEach(day => { day.open = day.day === 'Wednesday' })
  assert.equal(transferWindowOpen(overnight, null, 60, new Date('2026-11-05T06:00:00Z')), true)
  assert.equal(transferWindowOpen(overnight, null, 60, new Date('2026-11-06T06:00:00Z')), false)
})
test('DST spring gaps and repeated autumn hours use actual local clock times', () => {
  assert.equal(transferWindowOpen(custom('00:00', '02:00'), null, 60, new Date('2026-11-01T05:30:00Z')), true)
  assert.equal(transferWindowOpen(custom('00:00', '02:00'), null, 60, new Date('2026-11-01T06:30:00Z')), true)
  assert.equal(transferWindowOpen(custom('01:00', '03:00'), null, 3600, new Date('2026-03-08T06:30:00Z')), false)
})
test('business-hours mode inherits admin store hours without changing them', () => {
  const setting = { ...defaultTransferSchedule(), mode: 'business_hours' }
  const hours = JSON.stringify({ ...custom('10:00', '16:00'), mode: 'custom' })
  assert.equal(transferWindowOpen(setting, hours, 60, new Date('2026-11-04T16:00:00Z')), true)
  assert.equal(transferWindowOpen(setting, hours, 60, new Date('2026-11-04T22:00:00Z')), false)
  assert.equal(transferWindowOpen(setting, null, 60), false)
  assert.equal(transferWindowOpen(defaultTransferSchedule(), null, 7200), true)
})
test('malformed or ambiguous hours and unbounded durations fail closed', () => {
  for (const value of [{}, { ...custom(), timeZone: 'Made/Up' }, { ...custom(), hours: [] }, custom('09:00', '09:00'), custom('29:00', '30:00')]) {
    assert.throws(() => normalizeTransferSchedule(value))
    assert.equal(transferWindowOpen(value, null, 60), false)
  }
  assert.equal(transferWindowOpen(defaultTransferSchedule(), null, 7201), false)
})
