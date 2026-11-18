import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: ['netlify/lib/bookingStoreHours.ts'], bundle: true, platform: 'node',
  format: 'esm', write: false,
})
const { bookingCalendarFromStoreHours } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
)

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const custom = {
  mode: 'custom', answeringMode: 'business_hours', timeZone: 'America/Toronto',
  hours: weekdays.map((day, index) => ({
    day, open: index < 5, start: '09:00', end: '17:00',
  })),
}

test('booking calendar follows each business opening day and removes old exceptions or capacity blocks', () => {
  const rules = bookingCalendarFromStoreHours(custom)
  assert.deepEqual(Object.keys(rules.weekly), ['1','2','3','4','5','6','7'])
  assert.equal(rules.weekly['1'].open, true)
  assert.equal(rules.weekly['1'].start, '09:00')
  assert.equal(rules.weekly['5'].end, '17:00')
  assert.equal(rules.weekly['6'].open, false)
  assert.equal(rules.weekly['7'].open, false)
  assert.deepEqual(rules.weekly['1'].blocks, [])
  assert.deepEqual(rules.exceptions, {})
  assert.equal(rules.time_zone, 'America/Toronto')
})

test('24/7 businesses can accept any day and time', () => {
  const rules = bookingCalendarFromStoreHours({ ...custom, mode:'24/7' })
  assert.equal(Object.values(rules.weekly).every(day => day.open && day.start==='00:00' && day.end==='24:00'), true)
})

test('anytime booking ignores closed store days while preserving the business timezone', () => {
  const rules = bookingCalendarFromStoreHours(custom, 'anytime')
  assert.equal(rules.weekly['6'].open, true)
  assert.equal(rules.weekly['7'].open, true)
  assert.equal(rules.weekly['6'].start, '00:00')
  assert.equal(rules.weekly['6'].end, '24:00')
  assert.equal(rules.time_zone, 'America/Toronto')
  assert.equal(bookingCalendarFromStoreHours({ ...custom, mode: 'unconfigured' }, 'anytime').weekly['7'].open, true)
  assert.throws(() => bookingCalendarFromStoreHours(custom, 'invalid'), /Select when/)
})

test('unknown and overnight store hours fail closed instead of offering wrong appointments', () => {
  assert.throws(() => bookingCalendarFromStoreHours({ ...custom, mode:'unconfigured' }), /Configure/)
  assert.throws(() => bookingCalendarFromStoreHours({
    ...custom, hours: custom.hours.map((day,i) => i===0 ? { ...day, end:'08:00' } : day),
  }), /Overnight/)
})
