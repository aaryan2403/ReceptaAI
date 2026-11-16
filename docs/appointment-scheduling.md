# Appointment scheduling

Admin → Clients → Edit Client → Appointment Scheduling Settings and the Pro Appointments page share the same rules. New accounts start in request-only mode. Admins can prepare rules during client setup, before payment. Customer access, booking management, and all Retell appointment tools require a current paid Pro subscription. Recepta installs and verifies the three appointment tools when it configures a Pro agent or saves its appointment settings. Schedule and capacity rules take effect in the database. Recepta reuses the published agent version when its appointment configuration already matches.

- Appointment starts follow the configured interval from each day's opening time. A date exception replaces the entire weekly rule for that date.
- A capacity block sets a separate start limit for the part of each local clock hour the block covers. A 9:00–12:00 block with a limit of four permits four starts in each of those three hours. The default applies to starts outside blocks. A limit of zero closes a block to new starts. During a repeated daylight-saving hour, both offsets are offered separately and share the local hourly limit.
- Simultaneous capacity applies from the start through the appointment and its buffer. The appointment must end by closing time. The buffer can run past closing time and still counts toward overlap.
- The scheduling engine checks capacity in a tenant-serialized transaction. Requests do not reserve space. Existing bookings retain their stored duration and buffer when settings change, and the dashboard flags bookings that conflict with updated rules. A Retell call can create one appointment or request, identified by its signed call ID.
- The dashboard permits booking up to 366 days ahead. Weekly opening and closing times use the same day, with a midnight option. Use two daily rules for an overnight schedule.

## Client setup and recovery

Open **Admin → Clients → Edit Client → Receptionist setup** after saving the agent and phone assignment. Check the paid billing period, published agent and tool configuration, signed availability lookup, inbound phone webhook and booking mode. **Retry appointment tool sync** updates the assigned agent’s managed appointment tools and prompt, then reads back the published version. The Pro Appointments page can retry without resaving rules. Finish with a real inbound call and, when configured, an answered and an unanswered transfer.

## Staging verification

Apply the scheduling and paid-access migrations before testing the new dashboard. Use the PR preview backed by Recepta Staging and an isolated Retell workspace. Use a Stripe sandbox key in `STRIPE_STAGING_SECRET_KEY` or the preview-scoped `STRIPE_SECRET_KEY`. Set `RETELL_STAGING_API_KEY` and, if needed, set `RECEPTA_APPOINTMENT_FUNCTION_URL` to the public preview origin. Otherwise the booking tools use Netlify's `DEPLOY_PRIME_URL`. To test Resend, use `RESEND_STAGING_API_KEY` and allowlist the test inboxes in `RECEPTA_STAGING_EMAIL_TARGETS`.

1. Assign an isolated number and an agent to an active Pro test tenant in the normal Admin Dashboard. In **Receptionist setup**, run the readiness check, retry sync if needed and record the published agent version. Compare it with the version shown in Retell for the incoming call.
2. Set a 30-minute duration, 15-minute start interval, 10-minute buffer and one simultaneous appointment. Call for a future 10:00 slot in an open period. Verify the agent reads a booking reference only after Supabase records **Confirmed** and both dashboards show the same start and duration. Call for 10:30 to test the buffer. With those settings, 10:45 can be offered if it has capacity.
3. Raise simultaneous capacity to five and set a 60-minute duration, 30-minute interval, 15-minute buffer, and a start cap of two in a 9:00–11:00 capacity block. On a separate future day, confirm two at 9:00, decline a third at 9:00, and verify 10:00 can still be offered. Set a 11:00–12:00 block to zero and verify no starts are offered inside it. Check that the save takes effect on the next call.
4. Decline the alternatives for a blocked time and accept a pending request. Repeat in request-only mode. Both records must display **Awaiting Confirmation** with no reserved time. In the dashboards, confirm one request, reschedule it, cancel it, and verify availability changes after each action. Test a date exception and a different tenant timezone.
5. Sign in as a second staging customer and verify the first tenant’s records cannot be loaded or changed. Use a Standard or unpaid test tenant to verify booking is denied and that an admin can save setup rules without enabling booking.
6. Place separate calls for answered transfer, unanswered transfer and ordinary hang-up. Enable appointment emails for designated test inboxes. In Netlify’s preview function screen, use **Run now** on `service-job-retries` and verify the booked and pending messages in Resend and at the allowlisted inboxes.

The automated suite uses PostgreSQL 17 for the two-session concurrency test. For a local run, set `RECEPTA_TEST_PG_URL` to a disposable empty PostgreSQL database on localhost, then run `npm run test:appointments`. Without the URL, the remaining tests use an isolated embedded database.

For an operational rollback, turn off automatic booking for the affected tenant. Previously confirmed bookings and pending requests remain visible. Keep the migration applied if rolling back application code so recorded appointments and history remain available.
