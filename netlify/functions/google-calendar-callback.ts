// Discard old OAuth callbacks without exchanging codes or storing credentials.
export default async () => new Response(null, {
  status: 303,
  headers: {
    Location: '/dashboard/calls',
    'Cache-Control': 'no-store',
    'Set-Cookie': 'recepta_google_oauth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
  },
})
