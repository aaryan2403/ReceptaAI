import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const bundle = await build({
  entryPoints: ['src/components/CompanyStatisticsChart.tsx'],
  bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'automatic',
})
const { default: Chart } = await import('data:text/javascript;base64,' +
  Buffer.from(bundle.outputFiles[0].text).toString('base64'))

const markup = props => renderToStaticMarkup(createElement(Chart, { title: 'Confirmed Appointments', ...props }))
const points = values => values.map((value, index) => ({ label: 'Day ' + (index + 1), value }))

test('a seven-day chart uses distinct integer tick labels and sums the plotted counts', () => {
  for (const values of [[0, 0, 1, 0, 0, 0, 1], [0, 0, 1, 12, 0, 10, 0]]) {
    const html = markup({ points: points(values) })
    const ticks = [...html.matchAll(/<text[^>]+text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map(([, label]) => Number(label))
    assert.ok(ticks.length >= 2)
    assert.equal(new Set(ticks).size, ticks.length)
    assert.ok(ticks.every(Number.isInteger))
    assert.equal(ticks.at(-1), 0)
    assert.match(html, new RegExp('<strong>' + values.reduce((sum, value) => sum + value, 0) + '</strong>'))
  }
})

test('a confirmed zero week renders zero, while loading and failure render no plotted data', () => {
  const empty = markup({ points: points([0, 0, 0, 0, 0, 0, 0]), statusMessage: 'No bookings' })
  assert.match(empty, /<strong>0<\/strong>/)
  assert.match(empty, /<svg/)
  const loading = markup({ statusMessage: 'Loading' })
  assert.match(loading, /role="status">Loading/)
  assert.doesNotMatch(loading, /<svg|<strong>0<\/strong>/)
  const failure = markup({ statusMessage: 'Unavailable', unavailable: true })
  assert.match(failure, /role="alert">Unavailable/)
  assert.doesNotMatch(failure, /<svg|<strong>0<\/strong>/)
})
