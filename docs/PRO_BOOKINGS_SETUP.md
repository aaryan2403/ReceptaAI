# Pro bookings and Google Calendar

The Pro dashboard has a **Bookings** page. Standard accounts cannot access its API or Google connection. Existing accounts start with confirmed booking disabled; their current request intake continues until they configure and enable booking.

## Staff workflow

1. Save business opening hours on **Agent**. AI answering hours remain a separate setting.
2. Open **Bookings**, set the maximum simultaneous appointments, default duration and buffer before/after each appointment, and save the rules with AI booking off.
3. Use **Add offline booking** immediately after accepting a phone or walk-in appointment. The form uses the business timezone, regardless of the phone's timezone.
4. Once existing offline bookings are entered, enable AI booking. Staff entries work while AI booking is off, so the ledger can be prepared safely.
5. Edit/reschedule or cancel from the same page. Pending AI requests can be converted to reservations after selecting an available time.

Saving booking rules installs the live Retell tools on that client's existing agent. Later schedule syncs preserve them. The AI checks live data during the call; staff do not need to retrain the agent after an entry. Enabling requires a paid active Pro period. Read access remains available after cancellation; staff can cancel an existing booking.

Only a successful atomic reservation is a booking. Availability suggestions and pending requests do not reserve capacity. Every reservation is rechecked under a per-client Postgres transaction lock. The limit applies across full overlapping intervals, with half-open end boundaries and saved buffers. An explicitly assigned employee also cannot overlap another booking and must have working hours configured. Booking horizon: 90 days; service duration: 5–480 minutes.

## Google production setup

Create/configure a Google Cloud OAuth **Web application** for Recepta, enable the Calendar API, configure the consent screen, and add this exact authorized redirect URI:

`https://recepta.ca/.netlify/functions/google-calendar-callback`

Set the following **server-only Netlify production environment variables**, then redeploy:

- `GOOGLE_CLIENT_ID`: the OAuth web client ID.
- `GOOGLE_CLIENT_SECRET`: its client secret.
- `GOOGLE_CALENDAR_TOKEN_KEY`: a cryptographically random 32-byte key encoded in base64. Generate securely with `openssl rand -base64 32`. Keep it stable; rotating it without migrating encrypted tokens requires customers to reconnect. Never paste secrets into chat or commit them.
- `RECEPTA_APP_URL=https://recepta.ca` (or the existing production `URL` setting).

Requested Google scopes:

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events`

Configure a test user for initial testing. Public production use may require Google's sensitive-scope verification. Recepta's privacy policy, consent branding, authorized domains and verification must cover Calendar access. A Google Calendar connector installed in ChatGPT does not configure this customer-facing OAuth application.

After setup, each paid Pro customer chooses **Connect Google Calendar**, grants permission, selects up to five calendars to check, and selects one writable calendar for Recepta bookings. Existing Recepta appointments remain in the ledger; new or edited reservations queue a Google event. Selecting Google calendars does not silently export historical bookings.

Refresh tokens are encrypted with AES-256-GCM in a server-only table. OAuth state is short-lived, browser-bound and single-use. Tokens and secrets are never returned by the dashboard API.

## Sync behavior and limits

- Selected calendar events count toward capacity. Transparent/cancelled events do not. Recurring instances and all-day events are read. Identical invited events across selected calendars are deduplicated when Google supplies the same iCalUID and interval.
- Each busy event consumes one appointment of shared capacity. Calendars are pooled; selecting a calendar does not automatically assign it to an employee. A business with different staff/service/resource capacities needs those mappings configured in a later extension.
- Recepta refreshes Google before a new reservation, and every minute while the paid customer's booking page is open. A failed/incomplete refresh retains the previous snapshot and blocks new reservations until a successful refresh. It never treats a failed read as an empty calendar.
- Google event writes use deterministic IDs and a durable retry queue. `booking-calendar-retries` runs every five minutes. The dashboard shows pending/failed updates. A confirmed local reservation continues to hold capacity if mirroring fails.
- Staff edits and cancellations in Recepta update Google. Changes/deletions to a mirrored event in Google are reconciled on the next successful refresh. Human-created Google overlaps are imported as reality rather than silently deleting someone's appointments.
- Direct edits in Google or another app can race with a Recepta reservation. Google's event API has no atomic capacity reservation shared with Recepta. For the strongest protection, put all booking entry through Recepta's form/tools. Unrecorded offline bookings cannot be known by any software.
- Disconnecting leaves existing Google events in place, pauses new bookings, stops syncing, and removes local credentials/snapshots/queued writes atomically. Staff must record every booking in Recepta before re-enabling bookings. Reconnection does not automatically reconcile old disconnected calendars.
- Buyer appointment email/SMS sending is outside this change. Booking tools do not claim buyer notification delivery.

## Validation before client rollout

Automated coverage uses synthetic data and mocked provider APIs. It does not substitute for a real Google consent or telephone test.

1. Connect a designated Google test account; select two calendars and a writable destination.
2. Add an offline reservation; verify the Google event and the displayed sync state.
3. With capacity three, create two overlapping offline bookings and place a test AI call: the third may book and a fourth must receive another option.
4. Test rescheduling, cancellation and a Google-created appointment. Confirm the agent checks updated availability.
5. Test simultaneous staff/AI requests, buffers, business timezone, and unavailable Google access.
6. Test Pro access, Standard rejection, and payment cancellation.

The migration is `supabase/migrations/20261028181051_shared_booking_capacity.sql`. Apply it to the Recepta project before deploying the new API functions.
