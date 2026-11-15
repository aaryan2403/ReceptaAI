# Appointment scheduling

Admin → Clients → Edit Client → Appointment Scheduling Settings and the Pro Appointments page share the same rules. New accounts start in request-only mode. Recepta installs and verifies the three appointment tools when it configures a Pro agent or saves its appointment settings. Schedule and capacity rules take effect in the database. Recepta reuses the published agent version when its appointment configuration already matches.

- Appointment starts follow the configured interval from each day's opening time. A date exception replaces the entire weekly rule for that date.
- A capacity block limits starts within its local time range. The default applies per local clock hour to starts outside a block. A limit of zero closes a block to new starts. During a repeated daylight-saving hour, the two offsets are offered separately and share the local hourly limit.
- Simultaneous capacity applies from the start through the appointment and its buffer. The appointment must end by closing time. The buffer can run past closing time and still counts toward overlap.
- The scheduling engine checks capacity in a tenant-serialized transaction. Requests do not reserve space. Existing bookings retain their stored duration and buffer when settings change, and the dashboard flags bookings that conflict with updated rules. A Retell call can create one appointment or request, identified by its signed call ID.
- The dashboard permits booking up to 366 days ahead. Weekly opening and closing times use the same day, with a midnight option. Use two daily rules for an overnight schedule.

## Client setup and recovery

Open **Admin → Clients → Edit Client → Receptionist setup** after saving the agent and phone assignment. Check the paid billing period, published agent and tool configuration, signed appointment endpoint, inbound phone webhook and booking mode. **Retry appointment tool sync** updates the assigned agent’s managed appointment tools and prompt, then reads back the published version. The action leaves billing, number bindings, other tools and appointment records alone. Finish with a real inbound call and, when configured, an answered and an unanswered transfer.

## Staging verification

Apply `20261113064703_tenant_appointment_scheduling.sql` before testing the new dashboard. Use a Netlify preview backed by Recepta Staging and an isolated Retell workspace. Use a Stripe sandbox key in `STRIPE_STAGING_SECRET_KEY` or the preview-scoped `STRIPE_SECRET_KEY`. Set `RETELL_STAGING_API_KEY` and, if needed, set `RECEPTA_APPOINTMENT_FUNCTION_URL` to the public preview origin. Otherwise the booking tools use Netlify's `DEPLOY_PRIME_URL`. To test Resend, use `RESEND_STAGING_API_KEY` and allowlist the test inboxes in `RECEPTA_STAGING_EMAIL_TARGETS`.

1. Assign a staging agent to an active Pro test tenant. Save a 30-minute appointment, 15-minute start interval, 10-minute buffer and a simultaneous limit of 10. Add start caps of 4 from 9–10, 10 from 10–11 and 0 from 11–12.
2. Call the agent for a time that has capacity. Verify it reads back the confirmed time and booking reference. Check the appointment and captured fields in both dashboards.
3. Call for a time in the zero-capacity block. Verify the agent offers real alternatives and records a pending request if the caller agrees. Cancel or move a confirmed booking and verify availability updates.
4. Verify the agent can still transfer and end calls. Enable appointment emails and use the test inboxes to verify confirmations and **Awaiting Confirmation** notices. In the preview, open its Netlify Functions page and use **Run now** on `service-job-retries`. Netlify runs the scheduled worker automatically only for published deploys. Verify both Resend delivery status and receipt in the allowlisted inboxes.

The automated suite uses PostgreSQL 17 for the two-session concurrency test. For a local run, set `RECEPTA_TEST_PG_URL` to a disposable empty PostgreSQL database on localhost, then run `npm run test:appointments`. Without the URL, the remaining tests use an isolated embedded database.

For an operational rollback, turn off automatic booking for the affected tenant. Previously confirmed bookings and pending requests remain visible. Keep the migration applied if rolling back application code so recorded appointments and history remain available.
