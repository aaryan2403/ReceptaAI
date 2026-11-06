# Isolated Recepta staging database

Target: **Recepta Staging**, project `mvufjeqxqvpcfqwmihpy`.
Production (`qkdsdaboxkysabnbjmej`) is not modified by this setup.

`bootstrap.sql` is a schema-only baseline from the existing Recepta database.
It contains no customer rows, Auth users, credentials, phone assignments or paid
subscriptions. It reproduces existing authorization and server-only functions.
It refuses an existing application schema. Keep it outside normal migrations:
**never run this bootstrap against production or an existing application DB**.

For a new empty hosted Supabase test project, apply in this order:

1. `supabase/staging/bootstrap.sql`
2. `supabase/migrations/20261102183345_phone_setup_verified_transfers.sql`
3. `supabase/migrations/20261105023555_require_single_customer_agent.sql`
4. `supabase/migrations/20261105025833_phone_transfer_schedules_and_call_tests.sql`
5. `supabase/migrations/20261105030353_paid_reception_provisioning.sql`
6. `supabase/staging/seed_catalog.sql` (empty catalog only)

Do not replay older migrations after the bootstrap: their resulting schema is
already in the baseline. Do not use `db push` indiscriminately against this
baseline project; hosted baseline migration history differs from the old chain.

The single-agent constraint is required by the existing atomic phone-link RPC's
`ON CONFLICT(client_id)`. Existing duplicate assignments cause an explicit failure;
no migration deletes or reassigns them automatically. The new LLM ownership index
also rejects sharing one provider LLM between customer agents.

The public product catalog is copied as configuration only. It preserves current
prices/model IDs; it does not verify provider model availability or activate paid
access. Each model must still be validated against the intended Retell workspace.

## Deployment boundary

Use PR #23's Netlify Deploy Preview with explicit overrides for only
`feature/existing-number-onboarding`. Netlify branch values take precedence for
that branch's Deploy Preview. Preserve existing production and generic context
values. Build with `npm run build`, publish `dist`, and use `netlify/functions`.
Set both frontend and server Supabase URLs/keys to this staging project; never
test with production customer data. Server-only secrets belong in Netlify's
secret settings, never chat or source. `RECEPTA_APP_URL` must point to the preview.

Public: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.
Server: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `RETELL_API_KEY`, `ADMIN_EMAIL`,
`RECEPTA_APP_URL`, `STRIPE_STAGING_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the
existing owner-notification configuration, and Twilio Account SID/Auth Token/Verify Service SID.
Set `RECEPTA_REQUIRE_STRIPE_TEST_MODE=true` on this branch. Staging and other
non-production Netlify contexts use only `STRIPE_STAGING_SECRET_KEY`, which
must start with `sk_test_` or `rk_test_`. A missing or invalid staging key blocks
billing. Production reads `STRIPE_SECRET_KEY`. Set the sandbox webhook signing
secret in the branch override of `STRIPE_WEBHOOK_SECRET`. The webhook rejects
live events before database changes and reserves Retell purchases and releases
for live Stripe events.
Keep `RECEPTA_PHONE_SETUP_ENABLED=false` until isolated credentials are ready.
Automatic creation additionally needs `RECEPTA_AUTO_PROVISION_ENABLED=true` and an
approved **generic, unassigned** `RETELL_ONBOARDING_TEMPLATE_AGENT_ID`.

Never use a customer's receptionist as the creation template. It must be a
single-prompt Retell LLM template without transfer routes or customer knowledge
bases. Creation copies only allowed generic prompt/tools/voice fields, creates a
separate LLM and agent, and never shares a customer's provider configuration.
Initial account and approved plan/quote creation remain the existing workflow;
routine agent/first-number fulfillment after payment is automated. This feature
does not change plan approval, signup eligibility, or admin store-hours control.

Lost creation responses remain in the server-only creation journal. An operator
must reconcile those exceptional outcomes with the provider before clearing an
intent or retrying; blind retry could create a duplicate or incur charges. Known
LLM/agent IDs and pending purchased numbers are retained for safe continuation.
The existing orphan-number cleanup workflow remains in place.

## Real-world gates

Netlify sign-in, secure provider configuration, a carrier-authorized original
business line, and an authorized direct worker line are required for live tests.
No carrier integration is currently configured for managed forwarding activation;
use the verified carrier instructions. Never infer authorization from number
verification. Hidden forwarding rules and the original number dialed are not
always exposed by carriers; test the original line from another phone.

Automated tests use synthetic accounts and mocked providers. They cannot certify
actual audio reception, forwarding, warm briefing, bridge audio, voicemail failure
recovery, delivery to a real owner inbox, or provider billing. Keep PR #23 draft
and production unchanged until the real-call release gates pass.


## Verified staging state (2026-11-05 UTC)

All baseline and feature migrations above, plus the public catalog seed, were
applied successfully to the staging project. The hosted checks found **37 public
application tables with RLS on all 37**, zero customer accounts, zero agent/phone
assignments, and four public catalog entries. Browser roles cannot read reception
codes, mutate provisioning or claim provider LLMs; service-role callback capture
is available. No live customer rows or Auth users were copied.

The security advisor reported no warnings/errors. Its five informational
[RLS-without-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
refer to existing calendar tables retained as server-only with no browser grants.
Original performance advisories were inspected; unrelated legacy policy/index
normalization was not applied as part of this feature.

Netlify and Supabase browser sign-in are now confirmed. The feature branch has
staging-only frontend/server URLs, the staging publishable key and existing
staging server secret, preview app URL, Phone Setup enabled, automatic provisioning
disabled, and existing Twilio account/service identifiers. Production values were
preserved. The server secret is marked secret for Builds, Functions and Runtime.

The rotated Twilio Auth Token and Stripe test credentials still need secure
configuration. The Stripe connector currently has access only to the live Recepta
account; this does not supply test API keys. No staging Auth/customer accounts or
Retell resource assignments have been fabricated to bypass payment/ownership.
Redeployment and hosted verification are required after configuration changes.
Netlify reports production deploys paused because only operational credits remain.
No plan upgrade/payment, live messages/calls, purchases or provider agents were made.
