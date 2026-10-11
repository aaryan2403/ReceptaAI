# Paid subscriptions and one-cycle rollover

The monthly fee is mandatory while service is active. Stripe charges the saved payment method monthly. Unused **new monthly** minutes carry into the following paid billing cycle, capped at one monthly allowance. Rollover is consumed first and expires at that cycle's end. Older rollover never carries again. Cancellation forfeits the balance; failed payment freezes access until a paid renewal is confirmed.

The dashboard and billing page show the full cycle allowance, remaining monthly and rollover minutes, expiry, and next payment date. Usage is aggregated in PostgreSQL across all calls rather than a paginated call-history response. Existing call-limit behavior is preserved: new AI calls pause at the allowance; already-running calls can finish.

## Deploy in this order

1. Run `supabase_add_minute_enforcement.sql` if it has not already been applied.
2. Run `supabase_add_billing_notifications.sql` in the Recepta Supabase project's SQL editor **before deploying this code**. It includes the rollover column, server-only atomic paid-cycle functions, usage aggregation and a private notification outbox. It does not modify existing customer balances on installation.
3. Configure the Netlify function environment with the existing `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RETELL_API_KEY` and `RESEND_API_KEY`. Set `BILLING_FROM_EMAIL` to a sender on your verified email domain and `RECEPTA_APP_URL=https://recepta.ca`. Existing appointment/request sender settings can be used as fallbacks.
4. Enable the Stripe Customer Portal for payment-method updates, invoices and cancellation. Disable plan/quantity changes in the portal: Recepta's existing paid Checkout controls allowance changes. Optionally set `STRIPE_PORTAL_CONFIGURATION_ID` to a dedicated configuration.
5. Ensure the signed Stripe webhook at `https://recepta.ca/.netlify/functions/stripe-webhook` receives `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted` in the correct test/live mode. The Retell webhook continues to deliver completed calls.
6. Deploy to the existing Netlify site. Confirm `billing-reminders` is listed as a scheduled function. It runs hourly in production, queues one reminder per cycle during the seven days before renewal, skips Stripe subscriptions scheduled to cancel, and retries unsent notices. New queued reminders may take up to the next hourly run to send. Test-mode webhooks must use a separate test database/deployment and Stripe test keys.

Payment confirmation, payment failure and 80%/100% usage notices are queued by webhooks. Each notification has a unique cycle/invoice key, a database delivery lease, and a Resend idempotency key. Missing email configuration leaves notices pending and logs an error; it does not undo payment.

Paying to replace a monthly allowance starts a new fully paid cycle, as in the existing Checkout flow. Fresh unused allowance may carry once into that cycle, capped to the new allowance; older rollover expires. The old Stripe subscription is cancelled after the new paid subscription is recorded.

## Verification

Run `npm ci`, `npm run test:billing`, and `npm run build` with Node 22.18+ (or Node 24). The tests execute the SQL in embedded PostgreSQL and exercise expiry, paid recovery, replayed/stale events, skipped cycles, more than 1,000 calls, paid Checkout replacement, private RPC permissions and email delivery leases.

Before live launch, verify a complete Stripe **test-mode** Checkout, renewal, failed-card recovery, cancellation, a billing portal visit, and receipt of email on your verified sender. Inspect `billing_notifications.sent_at`, `attempts` and `last_error` for delivery results. No test command makes a real charge or sends a customer email.

Local tests do not prove that production environment variables, the Supabase migration, Stripe events, Netlify schedule, Retell call reporting, and email sender verification have been configured. Those must be checked on the connected deployment.
