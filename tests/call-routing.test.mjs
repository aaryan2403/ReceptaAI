import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { isBusinessOpen, getAnsweringMode } from '../netlify/lib/businessHours.ts'

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
test('all store hours, including legacy restricted settings, use 24/7 AI answering', () => {
  assert.equal(getAnsweringMode(JSON.stringify({ mode:'custom' })), '24/7')
  assert.equal(getAnsweringMode(JSON.stringify({ mode:'custom', answeringMode:'business_hours' })), '24/7')
  assert.equal(getAnsweringMode('old free text'), '24/7')
})

test('inbound calls do not reject on store hours but retain minute admission', () => {
  const source = readFileSync(new URL('../netlify/functions/retell-inbound.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /return decline\('outside_answering_hours'\)/)
  assert.match(source, /reserve_recepta_agent_call/)
})
