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

The Recepta customer’s contact email is always used for plan-appropriate call notifications. Standard receives the basic call notice. Pro receives the AI call summary and full appointment details when an appointment was booked. The buyer’s appointment email is controlled separately from the Agent dashboard.

## 2. Prepare optional buyer SMS delivery

To enable the optional buyer SMS switch, configure Twilio in Netlify:

```text
TWILIO_ACCOUNT_SID=AC_your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_SMS_FROM_NUMBER=+14165550123
```

You can use `TWILIO_MESSAGING_SERVICE_SID` instead of `TWILIO_SMS_FROM_NUMBER`. The sender must be SMS-capable and properly registered for the countries it texts. The AI asks for explicit buyer consent, and dashboard users must check the consent box before a manual appointment sends SMS.

## 3. Create the database calendar

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

## 4. Deploy the website

Deploy the current `main` branch through Netlify.

## 5. Connect one assigned Retell agent

1. Sign in to the client’s active Recepta Pro dashboard.
2. Open **Employees**.
3. Confirm each employee’s working hours.
4. Click **Update & Sync with AI Agent**.
5. Open **Agent**, choose the optional buyer email and SMS settings, then click **Sync Notification Settings**.

That sync preserves the existing Retell prompt and adds three managed tools:

- `recepta_list_employees`
- `recepta_check_availability`
- `recepta_book_appointment`

Blocked times and newly booked appointments are read live from Recepta. They do not require another schedule sync.

## 6. Test the complete flow

1. Open **Appointments** in the Pro dashboard.
2. Select an employee and a future date.
3. Add a blocked period.
4. Call or test the assigned Retell agent.
5. Ask for the blocked time and confirm that the agent does not offer it.
6. Choose an available employee and time.
7. Give a test name and email address. If testing SMS, give a valid international-format phone number and explicitly consent to the confirmation text. Then confirm the booking.
8. Refresh **Appointments** and verify the booking appears under that employee.
9. Confirm that the business owner receives their notification. Confirm that the buyer receives only the channels enabled in the Agent dashboard.
10. After Retell sends `call_analyzed`, confirm Standard receives a basic call email and Pro receives the call summary plus appointment details.

If the appointment appears but email does not arrive, check the Resend domain status, Resend logs, `RESEND_API_KEY`, and `APPOINTMENT_FROM_EMAIL` first.
