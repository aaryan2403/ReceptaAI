// Read-only deployed preview/prod smoke test. No credentials, caller data, secrets, or DB writes.
const url = process.env.RECEPTA_APPOINTMENT_SMOKE_URL
if (!url || !/^https:\/\/(?:deploy-preview-\d+--)?receptaai\.netlify\.app\/\.netlify\/functions\/retell-appointment$/.test(url)) {
  console.error('Expected the Netlify preview or production appointment-function URL.')
  process.exit(1)
}
const preview = url.includes('deploy-preview-')
const stageRef = 'mvufjeqxqvpcfqwmihpy'
const prodRef = 'qkdsdaboxkysabnbjmej'

const request = async (method) => {
  const response = await fetch(url, {
    method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    redirect: 'follow',
    signal: AbortSignal.timeout(8_000),
  })
  // Only read non-sensitive status/attestation headers.
  return { status: response.status, database: response.headers.get('x-recepta-preview-database') }
}

const checkPreviewFrontend = async () => {
  const origin = new URL(url).origin
  const htmlResponse = await fetch(origin + '/', { signal: AbortSignal.timeout(8_000) })
  if (htmlResponse.status !== 200) throw new Error('Preview landing page returned HTTP ' + htmlResponse.status)
  const html = await htmlResponse.text()
  const assets = [...html.matchAll(/(?:src|href)=["']([^"'?#]+\.js)["']/g)]
    .map(match => new URL(match[1], origin).href)
    .filter(value => value.startsWith(origin + '/'))
  const distinct = [...new Set(assets)].slice(0, 16)
  if (distinct.length === 0) throw new Error('Preview landing page does not reference a Vite JavaScript bundle.')
  const bundles = await Promise.all(distinct.map(async asset => {
    const res = await fetch(asset, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error('Could not read the preview frontend bundle.')
    return res.text()
  }))
  const combined = bundles.join('\n')
  if (combined.includes(prodRef)) throw new Error('Preview frontend bundle contains the production Supabase project ref.')
  if (!combined.includes(stageRef)) throw new Error('Preview frontend bundle does not contain the staging Supabase project ref.')
  console.log('PASS: served preview frontend bundle is configured for the staging Supabase project, not production.')
}

let error = 'No connection could be established.'
for (let attempt = 1; attempt <= (preview ? 15 : 6); attempt += 1) {
  try {
    const get = await request('GET')
    const post = await request('POST')
    console.log(`Appointment endpoint smoke attempt ${attempt}: GET=${get.status}, unsigned POST=${post.status}`)
    if (get.status === 405 && post.status === 401) {
      if (!preview || get.database === 'staging') {
        if (preview) {
          await checkPreviewFrontend()
          console.log('PASS: server-side preview appointment handler reports staging Supabase binding.')
        }
        console.log('PASS: appointment function reachable and expected variables present. Signed Retell calls not verified.')
        process.exit(0)
      }
      error = get.database === 'mismatch'
        ? 'Preview appointment function is bound to a NON-STAGING Supabase database.'
        : 'Preview appointment function has not deployed the staging database binding guard.'
    } else if (get.status === 405 && post.status === 503) {
      error = get.database === 'mismatch'
        ? 'Preview appointment function fails closed due to wrong Supabase database.'
        : 'Appointment function reports missing required Netlify configuration.'
    } else if (get.status === 404 || post.status === 404) {
      error = 'Netlify appointment handler is not deployed at the expected URL (404).'
    } else {
      error = `Unexpected HTTP statuses: GET=${get.status}, unsigned POST=${post.status}.`
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'Network error'
    console.warn(`Appointment endpoint smoke attempt ${attempt}: ${error}`)
  }
  if (attempt < (preview ? 15 : 6)) await new Promise(resolve => setTimeout(resolve, 8_000))
}
console.error('FAIL: ' + error)
process.exit(1)
