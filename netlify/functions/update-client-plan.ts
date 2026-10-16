// Retired: this legacy endpoint granted active plans without collecting payment.
// Admin configuration now goes through update-clients; activation is Stripe-only.
export default async () => new Response(JSON.stringify({
  error: 'This plan update endpoint is retired. Save the client configuration in Admin, then use paid Checkout from Billing.',
}), { status: 410, headers: { 'Content-Type': 'application/json' } })
