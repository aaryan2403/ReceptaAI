# Per-client call email notifications

Implemented on the existing PR #23 staging branch. Do not merge/deploy production
as part of this change. Production credentials, clients, agents and numbers are
not changed by the implementation or automated tests.

## Admin workflow

Open **Admin → Clients → Edit Client → Email notifications after each call**.
The owner destination is the client's saved contact email (account email fallback).
Select owner and caller fields individually; save the client separately if changing
its contact email. Enter up to 20 custom questions/labels, one per line. Save Email
Settings & Update Agent publishes receipt collection and post-call extraction for
that dedicated client agent. A failed publication explicitly reports that settings
were saved but agent sync failed. Retry that save after fixing the reported cause.

Owner mail remains enabled. Existing accounts have caller receipts off until an
admin enables them. The create-client caller receipt checkbox initializes the
same setting for new admin-created accounts. Self-service accounts use the default
until an admin configures them. The new independent email save does not change
billing, phone assignments, transfer destinations or subscription entitlements.

Standard emails contain selected basic call information. Pro adds the selected
AI summary, appointment details and custom answers. Unknown custom answers say
“Not provided”. A caller-facing summary is extracted separately from the owner’s
internal summary. Caller copies omit staff notes, employee names/contact details,
and raw transcripts/recordings. Admin-selected custom answers are included only
when the corresponding custom-details checkbox is selected.

The agent offers a receipt, asks permission, reads the caller's email back, and
asks for confirmation. No guessed, invalid, unconfirmed or nonconsenting address
is mailed. A skipped caller receipt is visible with its reason. PII redaction
suppresses captured custom/contact data and blocks caller receipts. Do not turn
redaction off just to obtain an email address.

Pending requests say pending/follow-up required. They do not claim a booked slot.
Actual confirmed historical appointments retain their confirmed status.

## Email checks

1. Preview Both Emails renders synthetic examples without sending anything.
2. Check Resend Connection validates authentication and the configured sender
   domain using the domains API. This check needs domain-read/full-access rights;
   a send-only key can send mail but cannot perform this diagnostic.
3. Test Owner Email to My Inbox / Test Caller Email to My Inbox send synthetic
   samples **only to the authenticated administrator**. No customer recipient can
   be injected into this endpoint. A returned provider ID means accepted, not
   delivered. Confirm receipt in that inbox and its spam folder.
4. Connect delivery tracking in Admin Operations. Call history shows owner and
   caller status independently. Admin Operations labels each role and shows
   failures, skipped receipts and provider bounce/delay events.
5. Run an authorized staging call with a staging client: collect an address and
   custom answers, confirm a pending appointment request, then check both receiving
   inboxes plus the signed `email.delivered` events. Repeat with a missing address,
   provider rejection/retry, duplicate Retell event, and an unmatched client agent.

## Configuration

Production call and transactional email sends use `RESEND_API_KEY`, trimmed on
read. Preview/non-production sends require **`RESEND_STAGING_API_KEY`** instead;
an inherited production key cannot be used. Preview recipient addresses must also
appear in the comma-separated **`RECEPTA_STAGING_EMAIL_TARGETS`** list. Include only
approved test inboxes (the admin address for test buttons). This applies to calls,
callbacks, billing, request emails and the legacy appointment sender.

Call sender priority: `CALL_NOTIFICATION_FROM_EMAIL`, `APPOINTMENT_FROM_EMAIL`,
`REQUEST_NOTIFICATION_FROM_EMAIL`, then `Recepta <notifications@mail.recepta.ca>`.
The actual sending domain must be verified in the Resend workspace that owns the
key. Support/reply address uses `RECEPTA_SUPPORT_EMAIL` where configured. Billing
and request senders retain their existing dedicated environment variables.

Netlify keys must be scoped to Functions and applied to the intended branch/context;
redeploy after changes. Never put Resend secrets in frontend VITE variables or source.
Staging Retell updates require `RETELL_STAGING_API_KEY`; never reuse production.
`RECEPTA_APP_URL` must point to PR #23's deploy preview so call events reach staging.

Delivery tracking uses a signed Resend webhook. Production can use
`RESEND_WEBHOOK_SECRET`; preview uses `RESEND_STAGING_WEBHOOK_SECRET`. Alternatively,
the existing connection action stores the webhook secret in the isolated database.
The connection action requires a full-access key for webhook administration.

401: replace the invalid/expired Resend key and redeploy. 403: check key permissions,
domain restriction and sender verification. 429: sending/rate limit; queued sends
retry. A missing/invalid key cannot be repaired by changing email templates.

## Schema and reliability

`20261108033150_client_call_email_preferences.sql` is applied to staging
`mvufjeqxqvpcfqwmihpy`. Read-only verification confirmed the capture column and
protection trigger exist, use invoker permissions, and are not executable by
anonymous or authenticated customers. Set `RECEPTA_CALL_EMAIL_ENABLED=true` in that
branch’s Netlify Functions environment after configuring the dedicated email key
and approved test recipients, then redeploy. The flag defaults off: original-schema deployments continue owner mail
and show new controls as awaiting setup. Do not enable it before the migration. It adds a server-written `calls.notification_details` snapshot, protects
it against stale/sparse replays and retention resurrection, and atomically enqueues
caller receipts alongside the existing owner outbox. There is no historical backfill.
Existing tenant RLS/private outbox permissions remain in place. Admin settings are
stored in Auth **app_metadata**, not customer-editable user_metadata.

Each role has a separate stable notification key. Each worker lease freezes the
complete provider payload before HTTP; a lost response retries the same body and
key. Accepted records are not resent. Ambiguous retries stop after 23 hours, before
Resend's 24-hour idempotency retention expires. Operator review is required after
that point. Content erasure removes the captured fields and stops queued messages.
A different existing agent event webhook blocks publication for review rather than
being overwritten. Repeated synchronization preserves unrelated post-call fields,
custom tools, transfer policy and business prompt content.

## Verification status

Local integration tests use signed webhooks, real PostgreSQL behavior through
PGlite, and synthetic external providers. They validate role-specific delivery,
immutable retries, consent gating, per-client admin authorization, plan filtering,
preview restrictions, safe caller summaries, retention and existing regressions.
They are not evidence of live Resend delivery. The staging migration is now applied
and verified. The deployed implementation at `ed5f244` passed GitHub Actions and
Netlify deploy-preview checks. A subsequent focused rerun passed all 18 admin and
call-email integration tests. The security advisory check introduced no new findings.

Netlify/Resend credentials are unavailable in this execution environment, and the
browser connection timed out. The staging database has no saved Resend setup
status. The rollout flag and dedicated preview email configuration still require
an authenticated Netlify check. Runtime key validity, sender-domain verification,
signed delivery events and receipt in both inboxes remain unverified. No customer
email or paid phone call was sent by these checks. Production remains unchanged.
