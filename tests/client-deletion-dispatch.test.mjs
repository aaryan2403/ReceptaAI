import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

// Exercise the real deletion handler with mocked authentication and queue dispatch.
// Never make a real Stripe/Retell request or modify a live database.
const output = await build({
  entryPoints: ['netlify/functions/delete-client.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'mock-deletion-services',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/lib\/(requestAuth|serviceJobs)$/ }, args => ({
        path: args.path, namespace: 'mock-deletion',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'mock-deletion' }, args => ({
        loader: 'js',
        contents: args.path.endsWith('/requestAuth')
          ? `export const requestAuth = async () => globalThis.__deletionHarness.auth
             export const json = (status, data) => new Response(JSON.stringify(data), {
               status, headers: { 'Content-Type': 'application/json' },
             })`
          : `export const processServiceJobs = async (db, key) => {
               globalThis.__deletionHarness.dispatched.push({ db, key })
             }`,
      }))
    },
  }],
})
const handler = (await import('data:text/javascript;base64,' +
  Buffer.from(output.outputFiles[0].text).toString('base64'))).default

const clientId = '00000000-0000-0000-0000-000000000042'
const key = 'delete-client:' + clientId
const setup = () => {
  const db = { rpc: async () => ({ data: key, error: null }) }
  const auth = { db, user: { id: 'admin-account' } }
  globalThis.__deletionHarness = { auth, dispatched: [] }
  return globalThis.__deletionHarness
}
const request = () => new Request('https://recepta.example/.netlify/functions/delete-client', {
  method: 'POST', body: JSON.stringify({ clientId }),
})

test('deleting a client responds immediately and dispatches only its scoped job', async () => {
  const state = setup()
  const background = []
  const response = await handler(request(), { waitUntil: promise => background.push(promise) })
  assert.equal(response.status, 202)
  const body = await response.json()
  assert.equal(body.jobKey, key)
  assert.equal(body.pending, true)
  assert.equal(background.length, 1)
  await Promise.all(background)
  assert.deepEqual(state.dispatched, [{ db: state.auth.db, key }])
})

test('if background execution is unavailable the durable scheduled queue remains', async () => {
  const state = setup()
  const response = await handler(request())
  assert.equal(response.status, 202)
  assert.deepEqual(state.dispatched, [])
})

test('unauthorized attempts never dispatch background deletion', async () => {
  const state = setup()
  state.auth.response = new Response('Forbidden', { status: 403 })
  const background = []
  const response = await handler(request(), { waitUntil: promise => background.push(promise) })
  assert.equal(response.status, 403)
  assert.equal(background.length, 0)
  assert.deepEqual(state.dispatched, [])
})

test('a failed database enqueue never starts provider cleanup', async () => {
  const state = setup()
  state.auth.db.rpc = async () => ({ data: null, error: { message: 'enqueue failed' } })
  const background = []
  const response = await handler(request(), { waitUntil: promise => background.push(promise) })
  assert.equal(response.status, 409)
  assert.equal(background.length, 0)
  assert.deepEqual(state.dispatched, [])
})

test('the lease-protected scheduled fallback runs every minute', async () => {
  const source = await readFile('netlify/functions/service-job-retries.ts', 'utf8')
  assert.match(source, /schedule:\s*'\* \* \* \* \*'/)
  assert.match(source, /processServiceJobs\(db\)/)
})
