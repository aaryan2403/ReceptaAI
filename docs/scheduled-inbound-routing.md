# Schedule-based inbound calls

The Retell inbound webhook on the main branch already checked AI answering hours before reserving minutes. It declined closed-hours calls and created a callback. The previous phone-setup branch implements warm transfers during AI calls. Retell's documented inbound webhook can select an agent or reject a call. Its phone-number fallback is for provider-level routing, such as concurrency overflow. A webhook rejection hangs up the call.

## Setup in Recepta Staging

Use the existing Recepta Staging database and the assigned Retell agent and number for the same preview. Use an existing programmable Twilio number in the isolated staging account as the caller-facing line. Keep the Retell number as the AI destination. A Retell-owned number receives calls directly in Retell, so calling that number directly cannot ring the after-hours human endpoint. If an existing business number forwards calls, point its carrier forwarding at the Twilio ingress line.

The preview uses `TWILIO_VOICE_STAGING_ACCOUNT_SID`, `TWILIO_VOICE_STAGING_AUTH_TOKEN` and the comma-separated `RECEPTA_STAGING_VOICE_NUMBERS`. Set them in the preview's server environment only. Use a different account from production and allowlist only the test ingress lines. Apply the scheduled inbound routing migration to staging.

In **Admin → Clients → Edit client → Inbound phone routing**, enter the existing Twilio ingress, assigned Retell number, direct human number and original business number if forwarding. Enter a direct US or Canadian number for the human destination. **Save Phone Routing** verifies the Twilio account and Retell line, stores the settings, and attaches the signed Twilio webhook. From then on, **Store hours & AI answering** controls each inbound call as it arrives.

The human leg shows the Twilio ingress as caller ID. Recepta blocks routing to known Recepta numbers, known forwarding sources, and the original business line. A carrier that preserves the ingress caller ID on a forwarded return leg lets Recepta reject it immediately. Use a direct human number with forwarding disabled to cover carriers that strip both caller ID and forwarding information.

If the human's carrier answers with voicemail, the caller reaches that mailbox. If Twilio sees a missed or unavailable call, the caller can leave a message in Recepta. **Calls → Missed calls & callbacks** shows that recording to the client. Enable authentication for recordings in the Twilio account. Use normal test messages with no customer data. Human calls skip Retell and its minute reservation. Normal carrier usage applies.

## Physical verification

Call from a third phone, separate from the human destination, and use the same connected Twilio line or forwarded test business number for all calls.

1. Save **24/7, including outside store hours** and call. The existing AI agent should greet you.
2. Save **Only during store hours** with a window that includes the current local time and call. The same AI should greet you.
3. Save a window that excludes the current local time and call. The human phone should ring. Answer and verify two-way audio and no AI greeting.
4. Repeat step 3 and let the call go unanswered. Leave a message with carrier voicemail or in Recepta, depending on which answers the call. Verify the message and confirm that the two after-hours calls produced no Retell call and no AI-minute usage.
