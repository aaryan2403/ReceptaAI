# Scheduled inbound routing

**Admin → Clients → Edit client → Store hours & AI answering** controls incoming calls on the client's Retell-purchased lines. With custom store hours and **Only during store hours**, Recepta uses the existing primary human transfer number. Enter it in the same panel if the client has no saved destination. If a carrier forwards the original business number to Recepta, register that source and use a different direct number for the human. Enable the human line's carrier voicemail for unanswered calls.

- During AI hours, and always in 24/7 AI mode, Recepta clears the Retell fallback number and turns off Backup mode. Inbound calls use the existing signed admission webhook, payment authorization and AI minute limits.
- Outside AI hours, an authorized client's line uses Retell Backup mode and points to the human number. Retell routes before choosing an agent and charges no AI agent fee. Recepta does not reserve AI minutes. Retell can still charge for the connected phone leg. If the destination cannot connect, Retell ends the call.
- The scheduler discovers existing and newly assigned Retell-purchased lines using the deployment's phone inventory and the existing Recepta line registry. It only manages numbers pointing to the current deployment's admission webhook. Human destinations cannot be Retell numbers, known Recepta numbers or registered forwarding sources. Unknown carrier redirects require a direct line that does not forward back.
- Saving hours triggers a sync. The Netlify scheduled function reconciles once a minute and retries incomplete updates. It reads back both Retell settings after changes. Opening, closing and suspension are subject to that interval and the provider's availability. The signed webhook still blocks any AI calls that arrive outside AI hours or lack payment or minute authorization.

## Staging call verification

Use an existing Retell-owned test line whose inbound webhook already points to the isolated preview. Assign it and its agent to the staging client. The preview uses `RETELL_STAGING_API_KEY` and the Recepta Staging database. Netlify runs cron automatically on published deploys. A preview can reconcile immediately on a schedule save or through **Functions → retell-forwarding-schedule → Run now**.

1. Save AI hours that include the current local time. Call the Retell number from another phone. The AI should answer.
2. Save AI hours that exclude the current time. Call the same Retell number. The human line should ring with no AI greeting. Repeat and let the human line's voicemail answer. Verify no agent call or new AI minute usage.
3. Save **24/7**. Call the same number again. The AI should answer and Backup mode should be off.

Provider references: [Retell Backup mode and billing](https://docs.retellai.com/deploy/inbound-call#divert-calls-with-backup-mode), [Retell phone settings](https://docs.retellai.com/api-references/update-phone-number), [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/).
