import test from 'node:test'
import assert from 'node:assert/strict'
import { isBusinessOpen } from '../netlify/lib/businessHours.ts'

const schedule = (hours, timeZone = 'America/Toronto') => ({ mode:'custom', timeZone, hours })
test('business hours use local timezone, exclusive closing time, overnight shifts and previous day', () => {
  const hours = [{ day:'Monday', open:true, start:'22:00', end:'02:00' }]
  assert.equal(isBusinessOpen(schedule(hours), new Date('2026-10-20T03:00:00Z')), true)
  assert.equal(isBusinessOpen(schedule(hours), new Date('2026-10-20T05:59:00Z')), true)
  assert.equal(isBusinessOpen(schedule(hours), new Date('2026-10-20T06:00:00Z')), false)
  assert.equal(isBusinessOpen(schedule(hours), new Date('2026-10-19T18:00:00Z')), false)
  assert.equal(isBusinessOpen(schedule(hours,'Invalid/Timezone')), false)
  assert.equal(isBusinessOpen({ mode:'24/7', timeZone:'America/Toronto', hours:[] }), true)
  assert.equal(isBusinessOpen({ mode:'unconfigured', timeZone:'America/Toronto', hours:[] }), false)
})
