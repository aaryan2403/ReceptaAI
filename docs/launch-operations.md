# Recepta operations

- Store opening hours and AI answering hours are separate in Agent. AI answering defaults to 24/7; paid admission and remaining minutes still apply. Unconfigured store hours must never be described as a 24/7 business.
- A declined call creates a callback request on Calls, with its reason and caller ID when available. Staff can mark it contacted, resolved or unreachable. These records are not answered calls and consume no AI minutes.
- Delete Client pauses the account and queues cleanup. Records and provider identifiers remain until Stripe cancellation/customer deletion and Retell number, call and dedicated-agent cleanup succeed. Imported/manual numbers are detached, not released. Shared agents require separation. An active call postpones cleanup without exhausting retries.
- Admin → Operations shows queued cleanup, failures, email bounces and delayed delivery. Retry paused provider cleanup only after correcting its reported problem. An ambiguous email is not automatically resent after the provider's idempotency window expires.
- Delivery tracking uses signed Resend webhooks and a private receipt ledger. Acceptance by Resend is not delivery. A delivered receipt means the receiving mail server accepted the email; it does not prove inbox placement or reading.
- The email setup job runs every 15 minutes. A Resend key with webhook-management access is required. Admin → Operations → Connect Email Delivery Tracking retries setup immediately. Secrets remain private and are never returned to browser clients.
- Callback/provider-cleanup workers and owner-email retry workers run every five minutes. Billing reminders run hourly. Retention queues run hourly at minute 17. All scheduled functions run on production.
- Call personal content defaults to 90 days and can be set to 7–365 days per client in Operations. Retell erasure must succeed before local call content is erased. Duration and timestamps remain for accounting. Late updates cannot restore erased caller content. Expired callback content and old accepted notification bodies have cleanup rules too. See the public Privacy Notice for the full description.
- Public visitors have no direct application-table access. Signed-in dashboard access retains tenant RLS. Backend queues, financial writes and integration secrets are service-only. The old client-detail editor redirects to the current admin workflow.

## Remaining launch checks

1. Attach the intended customer agent and use a Stripe testing environment to exercise cancelled, unpaid and successful Checkout. Verify the signed webhook updates the paid period and provisions only the purchased configuration.
2. With a paid test configuration and assigned number, place a call. Verify call admission, agent answers, terminal dashboard record, appointment request requiring confirmation, owner email acceptance and signed delivery receipt.
3. Test a declined call and its callback record; mark the follow-up complete.
4. Confirm email delivery tracking is connected in Operations. A sending-only Resend key cannot manage webhooks; configuration failures remain visible.
5. Supabase leaked-password protection is not enabled: the connected organization uses Free, while Supabase requires Pro or above for that feature. No plan upgrade has been performed.
6. Signed-in GraphQL schema visibility is intentional for dashboard tables under tenant RLS; it is not proof of cross-client row access. Anonymous visibility and unnecessary privileged RPC access are revoked.

Automated tests use PostgreSQL and production handlers with synthetic external services. They do not demonstrate a real phone conversation, real card payment or inbox delivery.
