# Recepta Employee Calendar Setup

The code is not live until the database migration and Netlify deployment are completed in this order.

## 1. Prepare appointment email delivery

1. In Resend, add and verify `mail.recepta.ca`.
2. Create a Resend API key with sending access.
3. Add these environment variables to the Recepta Netlify site:

```text
RESEND_API_KEY=re_your_key
APPOINTMENT_FROM_EMAIL=Recepta Appointments <appointments@mail.recepta.ca>
RECEPTA_SUPPORT_EMAIL=receptahelp02@gmail.com
```

Keep the existing `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `RETELL_API_KEY` values. Never place these secrets in a `VITE_` environment variable.

## 2. Create the database calendar

Open Supabase SQL Editor and run the complete contents of:

```text
supabase_add_employee_calendar.sql
```

The migration adds:

- employee-linked appointments;
- appointment duration and end time;
- manager-only internal notes;
- employee calendar blocks;
- the optional saved-client list;
- transaction-safe booking functions that reject overlapping bookings.

## 3. Deploy the website

Deploy the current `main` branch through Netlify.

## 4. Connect one assigned Retell agent

1. Sign in to the client’s active Recepta Pro dashboard.
2. Open **Employees**.
3. Confirm each employee’s working hours.
4. Click **Update & Sync with AI Agent**.

That sync preserves the existing Retell prompt and adds three managed tools:

- `recepta_list_employees`
- `recepta_check_availability`
- `recepta_book_appointment`

Blocked times and newly booked appointments are read live from Recepta. They do not require another schedule sync.

## 5. Test the complete flow

1. Open **Appointments** in the Pro dashboard.
2. Select an employee and a future date.
3. Add a blocked period.
4. Call or test the assigned Retell agent.
5. Ask for the blocked time and confirm that the agent does not offer it.
6. Choose an available employee and time.
7. Give a test name and email address, then explicitly confirm the booking.
8. Refresh **Appointments** and verify the booking appears under that employee.
9. Confirm that separate emails reached the caller and the business owner.

If the appointment appears but email does not arrive, check the Resend domain status, Resend logs, `RESEND_API_KEY`, and `APPOINTMENT_FROM_EMAIL` first.
