# Per-client call email notifications

Available in the normal Recepta admin page using the existing production login.
This update brings only call email controls and delivery support onto main; the
unrelated phone onboarding work in PR #23 remains separate. No staging login is
required. Provider credentials, existing client accounts, agents and phone
numbers are preserved. Automated tests use only synthetic providers and data.

## Admin workflow

Open **Admin → Clients → Edit Client → Email notifications after each call**.
Write the business and caller opening messages in the blank text boxes. Each
message appears first, followed by only the fields selected for that audience.
There are no preset field checkboxes and no automatically inserted business name,
caller name, phone, timestamp, summary, section headings or introductory copy in
this manual layout. The email subject is the neutral `Call update`. Messages are
plain text, preserve internal line breaks and are limited to 4,000 characters.

The business destination is the client's saved contact email (account email
fallback). Save the client separately to change that destination. Under **Call
detail fields**, add up to 20 named fields in the desired order. New fields have
neither destination selected: explicitly choose Business email, Caller receipt,
both or neither. A message-only email is supported. Field details retain the Pro
plan requirement. An enabled email must contain a written message or an eligible
selected field; empty configurations cannot be activated or sent as test samples.

If extraction already exists in Retell, choose **Load existing Retell fields**,
then **Add existing field** or map a row to the desired extraction key. This is
read-only and uses only the assigned agent. Nothing is added automatically when
loading. Mapped types, descriptions, examples and required/optional rules are
preserved. Missing or ambiguous mapped keys stop publication. New configurations
do not preload the old appointment field list.

**Save Email Settings & Update Agent** publishes the selected questions and email
receipt policy. It preserves the agent's availability, other business instructions
and tools. The general **Save Client** action also preserves availability managed
in Retell. The edit panel no longer contains store-hours/AI-answering controls or
the additional-number quote form. Existing numbers remain editable.

Saved drafts become active only after successful agent synchronization. A failed
sync leaves capture using the previous active settings. Existing configured
custom fields remain editable. Legacy email configurations and already captured
calls retain their original format until a newly saved configuration becomes
active. There is no historical rewrite or backfill.

Owner delivery remains enabled. Caller delivery is opt-in and still requires the
agent to ask permission, read the caller's email back and obtain confirmation.
No guessed, invalid or unconfirmed address is mailed. PII redaction suppresses
captured custom/contact data and blocks caller receipts. The same captured field
answers appear in Pro call history. Missing answers say “Not provided”; finite
numbers and booleans are retained as text. Selected fields cannot pull unrelated
appointment notes or an internal summary into a manual email.

The opening text is written by the admin; it does not establish a booked slot.
Retell still treats an appointment request as pending until actually confirmed.

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
5. For end-to-end acceptance, configure an authorized test client and agent from
   the normal admin. Place a call, collect custom answers, confirm receipt consent
   and the email address, then check both inboxes and the signed `email.delivered`
   events. Automated tests separately cover missing addresses, provider retries,
   duplicate Retell events and unmatched client agents.

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
For optional preview testing, `RECEPTA_APP_URL` must point to that deployment so
call events reach the isolated test environment.

Delivery tracking uses a signed Resend webhook. Production can use
`RESEND_WEBHOOK_SECRET`; preview uses `RESEND_STAGING_WEBHOOK_SECRET`. Alternatively,
the existing connection action stores the webhook secret in the isolated database.
The connection action requires a full-access key for webhook administration.

401: replace the invalid/expired Resend key and redeploy. 403: check key permissions,
domain restriction and sender verification. 429: sending/rate limit; queued sends
retry. A missing/invalid key cannot be repaired by changing email templates.

## Schema and reliability

`20261108033150_client_call_email_preferences.sql` is applied to production
`qkdsdaboxkysabnbjmej`. Read-only checks confirmed the capture column, protection
trigger and restricted function permissions. The earlier production activation
blocker is cleared. Normal production email controls are enabled by
default after a runtime schema check; no additional rollout variable is required.
If the schema update is pending, preferences can be saved and samples can be
sent from the normal admin, but AI email collection is not changed. Save again
after activation to publish those preferences to the agent. Existing owner mail
continues through the original schema. An explicit
`RECEPTA_CALL_EMAIL_ENABLED=false` remains an emergency off switch. Optional preview
deployments require their own migration and explicit
`RECEPTA_CALL_EMAIL_ENABLED=true`. It adds a server-written `calls.notification_details` snapshot, protects
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

Automated checks use signed webhooks, real PostgreSQL behavior through PGlite,
and synthetic providers. They validate independent owner/caller delivery, retries,
consent, tenant authorization, plan filtering, erasure and existing regressions.
Production-specific tests additionally verify normal-admin defaults, preview
credential isolation, persistence through later agent schedule saves, existing-field
mapping, audience exclusions, last-synchronized configuration, tenant isolation,
redaction, erasure and refusal to replace another service's webhook.

The production database reports Resend delivery tracking configured. This is not
proof of delivery to an inbox. After publication, use the normal admin preview,
connection check and synthetic sample buttons, followed by an authorized real
call. A provider acceptance ID is not the same as an email.delivered event or
receipt in the destination inbox. No real email or paid phone call is sent by
automated tests.
