// Discard old OAuth callbacks without exchanging codes or storing credentials.
export default async () => new Response(null, {
  status: 303,
  headers: {
    // An explicit harmless query prevents Netlify forwarding old OAuth values.
    Location: '/dashboard/calls?calendar=removed',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': 'recepta_google_oauth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
  },
})
