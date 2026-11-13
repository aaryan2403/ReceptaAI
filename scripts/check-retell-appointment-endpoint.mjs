// Probe the Netlify deployment without credentials, caller data, or database writes.
const url = process.env.RECEPTA_APPOINTMENT_SMOKE_URL
if (!url || !/^https:\/\/deploy-preview-\d+--receptaai\.netlify\.app\/\.netlify\/functions\/retell-appointment$/.test(url)) {
  console.error('Expected the Netlify PR preview appointment-function URL.')
  process.exit(1)
}

const request = async (method) => {
  const response = await fetch(url, {
    method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  })
  // Do not read or log response bodies; never expose environment variable values.
  return response.status
}

let error = 'No connection could be established.'
for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const getStatus = await request('GET')
    const unsignedPostStatus = await request('POST')
    console.log(`Appointment endpoint smoke attempt ${attempt}: GET=${getStatus}, unsigned POST=${unsignedPostStatus}`)
    if (getStatus === 405 && unsignedPostStatus === 401) {
      console.log('PASS: preview function reachable and required environment variables present. Signed Retell calls not verified.')
      process.exit(0)
    }
    if (getStatus === 405 && unsignedPostStatus === 503) {
      error = 'Handler is deployed but reports missing Supabase or Retell preview configuration (503).'
    } else if (getStatus === 404 || unsignedPostStatus === 404) {
      error = 'Netlify appointment handler is not deployed at this URL (404).'
    } else {
      error = `Unexpected HTTP statuses: GET=${getStatus}, unsigned POST=${unsignedPostStatus}.`
    }
  } catch (caught) {
    error = `Endpoint unreachable: ${caught instanceof Error ? caught.name : 'network error'}`
    console.warn(`Appointment endpoint smoke attempt ${attempt}: ${error}`)
  }
  if (attempt < 6) await new Promise(resolve => setTimeout(resolve, 8_000))
}
console.error(`FAIL: ${error}`)
process.exit(1)
