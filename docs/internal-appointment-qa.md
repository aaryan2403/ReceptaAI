# Internal appointment QA access (PR #32)

This is a temporary **appointment-tool-only** exception for the explicitly designated owner test client and its **current** Retell agent. It is not a Stripe entitlement, does not mark subscriptions paid, does not admit inbound calls, does not allocate minutes, does not alter phone routing, and does not enable human transfers. Nothing is issued by the migration itself. Do not merge or deploy to production before security review and a real signed Retell call.

## Existing mechanism audit

`claim_recepta_demo` only manages shareable demo links. `agents.demo_mode` and demo minute reservations relate to reception/call admission. None can securely authorize live appointment functions for a single unpaid client and specific assigned agent. Therefore the appointment-only implementation uses separate dedicated grant and usage tables while retaining the normal paid-Pro check.

## Grant controls

The existing authenticated ADMIN_EMAIL owner in the normal Admin → Edit Client panel can issue and revoke an internal test grant. The panel always passes **explicit** client and saved agent IDs, exact expiration, maximum distinct calls, and total signed appointment tool invocations.

The server route `/.netlify/functions/admin-appointment-test-entitlement` requires `requestAuth(request, true)` and issues the grant through `service_role` SQL:

- `POST` JSON: `{"clientId":"<uuid>","agentId":"<retell agent ID>","expiresAt":"<UTC ISO timestamp>","maxCalls":3,"maxInvocations":15}`.
- `DELETE` JSON: `{"clientId":"<uuid>","agentId":"<retell agent ID>"}` revokes access immediately.
- `GET ?clientId=<uuid>&agentId=<agent ID>` returns recent grant status and usage for an authenticated admin.

A grant requires exactly one assigned Retell agent; the same agent cannot belong to another client. It also requires this client to have **Recepta Pro selected, `status=pending`, and no Stripe subscription ID**, and not be scheduled for deletion. Issuance requires an expiration between 15 minutes and 48 hours and at most 10 distinct calls / 50 tool invocations. Only one unrevoked grant may exist in the project: issuing another revokes the previous grant, retaining audit history.

Every **signed** availability, booking, or pending-intake tool invocation calls a database RPC that checks the exact client and agent, authorization, expiry, remaining usage, and current mapping. It serializes concurrent usage under a row lock and writes a timestamped tool audit entry with an irreversible call-ID fingerprint; it never logs caller names, phone numbers, emails, secrets, or the raw Retell call ID. Every attempted authorized invocation consumes one tool unit, whether or not the booking later succeeds. A new call additionally consumes one distinct-call unit. Paid customers never use this budget.

Database scheduling RPCs recheck the grant's validity (including revocation, expiry, changed agent assignment, Pro selection, and missing payment record) before booking and saving. The **normal Stripe path is unchanged**. All new tables have RLS enabled, no `anon` or `authenticated` table permissions, and all grant/meter RPCs are `service_role` only.

The admin readiness panel labels internal test authorization separately from paid call authorization. An unpaid client **still cannot pass paid inbound-minute reservation** simply by holding an appointment test grant. For an actual provider-originated call, use an already legitimately admitted call or a separately authorized staging call test; do not switch on unrestricted demo calling to compensate.

## Verification requirements

The automated suite tests unsigned signatures, missing/incorrect agent binding, admin-only issuance/revocation, selected-plan requirements, bounded usage, concurrent/serial usage accounting, a successful signed pending request appearing in the tenant dashboard, denial of a third distinct call, denial after the invocation budget, immediate revocation, expiry and absence of Stripe mutations. The existing appointment, email and transfer tests must continue to pass.

**Before production:** Review migration and indexes, verify the runtime points to the correct Supabase project, confirm the real Retell published tool URL and signature, intentionally create a grant from the Admin panel with exact client/agent IDs and a short expiration, place one authorized real call, check the matching `appointments` record in the correct dashboard and record email delivery. Revoke the grant afterward. Do not claim any real call-to-database success from CI tests alone.
