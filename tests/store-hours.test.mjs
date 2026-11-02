import test from 'node:test'
import assert from 'node:assert/strict'
import { readStoreHours, storeHoursSummary } from '../src/lib/storeHours.ts'

test('read-only store hours reflect the saved schedule without inventing unconfigured opening hours', () => {
  for (const value of [null, '', 'Not configured', '{"mode":"custom"}', 'not valid JSON']) {
    assert.equal(readStoreHours(value).mode, null)
    assert.equal(storeHoursSummary(value), 'Awaiting Recepta setup')
  }
  assert.equal(storeHoursSummary('24/7'), '24/7')
  const hours = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
    .map(day => ({ day, open: day === 'Monday', start: '10:00', end: '16:00' }))
  const value = JSON.stringify({ mode: 'custom', answeringMode: 'business_hours', timeZone: 'America/Vancouver', hours })
  assert.deepEqual(readStoreHours(value), { mode: 'custom', answeringMode: 'business_hours', timeZone: 'America/Vancouver', hours })
  assert.equal(storeHoursSummary(value), '1 day · 10:00–16:00')
  assert.equal(storeHoursSummary(JSON.stringify(hours.map(day => ({ ...day, open: false })))), 'Closed all week')
})
