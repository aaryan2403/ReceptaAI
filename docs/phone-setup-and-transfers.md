# Phone setup and human handoff — staged release

This extends draft PR #23 on `feature/existing-number-onboarding`. It is **not approved for production**. No live number was purchased, no agent was created, no customer resource was reassigned, and no real verification text/call or transfer test was made during implementation.

## Customer experience

The Agent page has one Phone Setup / Manage Numbers section. Customers can use their assigned Recepta number publicly or retain a carrier number and activate forwarding themselves. Mobile, landline and compatible hosted VoIP services are supported when the carrier supports forwarding. Saving a number does not activate carrier forwarding.

Owners verify existing business and worker numbers using a provider-issued code. Worker changes are self-service, with an authorization/no-forwarding declaration each time transfers are enabled. The first release allows standard US/Canadian direct destinations; it rejects other NANP countries, toll-free, premium, extensions and SIP destinations. The destination table allows additional labeled destinations later; only the primary destination is exposed now.

A dedicated worker line is required. The same phone cannot forward every call to AI and receive the AI's transfer without a separate direct line. Actual carrier rules, forwarding charges and voicemail behavior must be checked by the owner.

## Server configuration

Use an isolated Netlify test environment and isolated Supabase test database first. Do not turn this on in a preview that uses production customer data or production Retell resources for automated tests.

Existing server-only configuration:

- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `RETELL_API_KEY`, `ADMIN_EMAIL`.
- `RECEPTA_APP_URL` must be the externally reachable URL of the intended test deployment. Number routing uses this URL, falling back to Netlify `URL`. Set it explicitly in the test environment so a production value is not inherited.

New configuration:

- `RECEPTA_PHONE_SETUP_ENABLED=true` enables the staged endpoints and runtime destination resolution. Leave it unset/false outside the isolated test environment until the release gates below pass. Turning it off prevents destinations from being supplied for new calls.
- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are existing server-side Twilio settings.
- `TWILIO_VERIFY_SERVICE_SID` is a Twilio Verify service SID (`VA…`). Configure SMS/voice verification and appropriate geographic/fraud controls in that service. This is separate from an SMS sender number. No number purchase is necessary to implement the Verify integration. Verify usage incurs provider charges when users explicitly request codes.

Never put these credentials in `VITE_*`, source files, browser storage or PR comments. The browser never receives provider secrets, verification SIDs or raw verification codes from the server. Codes are sent directly to the verification provider for checking and are not stored by Recepta.

## Database

The staged migration is `supabase/migrations/20261102183345_phone_setup_verified_transfers.sql`. It has been executed against synthetic PGlite PostgreSQL fixtures; **it has not been applied to production**.

All new tables have RLS and service-role-only grants/policies. Authenticated customers access them only through verified-session Netlify handlers, scoped to `user.id`. Editable Auth `user_metadata` is not an authority for destinations, verification or billing. No existing customer metadata flags are trusted or migrated as verified numbers.

Tables: `phone_setups`, `phone_verified_numbers`, `phone_transfer_destinations`, `phone_forwarding_sources`, `phone_operation_limits`, `phone_operation_locks`, `retell_agent_sync_locks`, `call_transfer_events`. Client-linked rows cascade on account deletion. Limits contain hashed keys; their storage is bounded by paid account/verification usage, and expired counter rows can be periodically pruned by operations.

Settings use a revision and a per-account mutation lease. A durable pending state is saved before publishing to Retell. New inbound calls receive no destination while sync is pending or failed. A failure to mark publication successful also leaves transfers disabled. The owner can retry Save & Sync. Disabling transfers works after payment/verification expires or an agent is removed.

A shared agent-publication lease serializes transfer, hours, employee and subscription agent-version publishers when this feature is enabled. It is acquired before loading/cloning the published version. Busy updates return an error for a later retry, rather than publishing an older tool list. Provider failures release the lease; interrupted instances expire after 15 minutes. Changes made directly in Retell outside Recepta are not covered by this lock.

## Existing purchased number association

No account association is inferred from an agent ID, phone number, business name or chat identity. Before any write, Admin → Edit Client → **Link an already purchased number**:

1. Select the correct existing customer account and review its email.
2. Enter the existing agent ID and purchased number.
3. Confirm ownership/authorization.
4. The server verifies the selected client is available, its contact email matches a confirmed Auth login, the provider resources exist in Recepta's Retell workspace, the number is not bound to a different agent, and conflicting database assignments do not exist.
5. The atomic link preserves existing agent prompts/settings and never activates a subscription. It cannot replace a different assigned agent or add unpaid additional numbers. Number routing is switched to Recepta's admission webhook with no static inbound agent fallback.

The supplied production pair was checked read-only during implementation and had no matching `agents` or `agent_phone_numbers` association. The correct customer's login email/account must be identified before using this linking action. Provider workspace ownership still needs a credentialed runtime check.

If a provider routing update fails after assignment, the endpoint reports the partial result and can be retried. Do not mark service live based on the assignment alone. Normal billing/activation and real reception tests remain required. New numbers continue through the existing quote, authorized Checkout, verified payment webhook and provisioning workflow; this PR does not add an unapproved purchase path or new pricing.

## Transfer behavior and limits

The AI answers first. Its managed native Retell `transfer_call` tool uses `warm_transfer`, a 25-second ring period, human detection and a private brief. It offers a transfer for an explicit human request, unresolved issue or urgent concern, asks for consent, and otherwise collects callback details. Immediate safety emergencies are directed to emergency services. The prompt requests at most one handoff attempt per call. The native provider handles the call leg; successful bridging is recorded only from `transfer_bridged`.

The tool's destination is a dynamic variable with an empty default. Only signed inbound admission supplies a verified direct line after checking paid entitlement, dedicated agent, successful sync and loop safety. New calls to an inactive account remain subject to existing minute reservation/activation rules. Already admitted calls retain the settings and paid reservation they started with; disabling applies to new calls.

The worker sees the Recepta AI number, avoiding unsupported caller-ID spoofing. Known AI numbers and all known current/historical forwarding sources are blocked as destinations. A new inbound call whose caller ID is a known Recepta number is rejected before reserving minutes, which stops the usual worker-forwarding-back loop. Unknown carrier forwarding, hidden caller IDs, PBX rewrites or future carrier changes cannot be proven absent by entering a number. Owners must keep the receiving line direct and run the loop/voicemail tests. Historical sources are conservatively retained as unsafe transfer destinations.

Warm transfer cannot be tested with browser audio. Human detection and voicemail behavior depend on the receiving network; they must be tested with the actual worker line. This release uses ordinary warm transfer, not a separate agentic transfer agent. It does not promise a two-way staff acceptance/rejection conversation. A worker hanging up, voicemail or a carrier error must be checked in real calls; do not market guaranteed transfer behavior until these pass.

Transfer sync sets Recepta’s call-event webhook, always subscribes to the existing call lifecycle events plus transfer events, and retains other subscribed events. An agent with a different existing event webhook requires review rather than silently replacing it. Retell transfer webhooks are signature-verified, account-resolved and persisted idempotently. Sparse events fetch the canonical call for ownership. They never update the call lifecycle, duration, minutes, appointments or owner-email delivery state. Calls shows a confirmed handoff only when a bridged event exists; started/ended events alone are not proof. Repeated identically shaped events are deduplicated; the UI does not advertise precise attempt counts. Missing webhook delivery can leave an outcome unknown. Transfers may add carrier/provider leg charges, separate from the existing AI-minute calculation.

## Carrier guides

Guides were checked against carrier-owned documentation on 2026-11-02. They distinguish Rogers mobile, Bell Mobility, TELUS mobile, Rogers Home Phone, TELUS Office Phone and general PBX/other providers. They include source links, carrier activation, deactivation and plan/voicemail caveats. No universal code is advertised for unknown VoIP or landline services.

- https://www.rogers.com/support/mobility/use-call-forwarding
- https://www.rogers.com/support/home-phone/call-forwarding
- https://support.bell.ca/mobility/rate_plans_features/how_to_use_call_forwarding_on_my_mobile_phone
- https://www.telus.com/en/support/article/call-forward-mobile
- https://www.telus.com/en/business/support/article/use-call-forwarding-variable
- https://docs.retellai.com/build/single-multi-prompt/transfer-call
- https://docs.retellai.com/api-references/update-retell-llm
- https://docs.retellai.com/features/webhook-overview
- https://www.twilio.com/docs/verify/api/verification
- https://www.twilio.com/docs/verify/api/verification-check

Cancellation does not deactivate carrier forwarding. The owner must undo it with the carrier, verify their original line and voicemail, and handle subscription cancellation separately. Incompatible or missing numbers are not labeled connected. Dashboard test confirmations are clearly labeled **customer-reported**, not independently observed carrier status.

## Automated verification

`npm run test:phone` runs real authenticated handlers against synthetic PostgreSQL tables/functions and mocked Retell/Twilio APIs. Coverage includes tenant ownership, billing expiry, verification/consent, target/attempt limits, persistence, stale revisions, overlapping publication, provider/storage failure, disabling without an agent, known loops, destination country/tariff restrictions, resource linking, signed sparse/out-of-order transfer events, and preservation of other tools/hours/appointment instructions. No production calls, messages, payments or database writes are used.

Also run all existing tests, frontend production build, backend TypeScript and lint. The browser fixture uses the real React component with synthetic services to test verification, errors, save/disable controls and phone layout. It is not a live telephony test.

## Release gates — all real-call rows remain open

| Gate | Evidence needed |
| --- | --- |
| Isolated test migration/configuration | Apply staged SQL in the test database, set test environment values and verify grants/advisors there. |
| Exact account association | Select the actual owner account and verify provider ownership before linking the existing pair. |
| Paid reception | Call the assigned number; correct AI answers; no default provider binding bypasses admission. |
| Carrier forwarding | Activate with the actual business carrier; call original number from another phone. |
| Successful handoff | Worker hears private brief; both parties can speak; bridge event appears in Calls. |
| Unanswered/rejected/voicemail | AI collects callback details where supported; never claims connection without a bridge. |
| Loop safety | Try same AI/business destination (must reject); controlled worker-forwarding-back test must not loop. |
| Payment/minutes | Unpaid/expired/exhausted accounts cannot admit new calls; paid calls beyond three minutes and demos retain existing limits. |
| Existing workflows | Pending appointment request, owner email delivery/retry, signed call records and admin hours still work in real calls. |
| Cancellation | Pages stay visible; disable transfer works; carrier forwarding is manually removed and tested. |

The pre-existing buyer appointment email/SMS acknowledgement gap is outside this phone-management change. Do not advertise caller confirmations as finished solely because a verification text is working.

Keep PR #23 draft and unmerged until these gates are reviewed. No production telephony deployment is authorized by this implementation request.
