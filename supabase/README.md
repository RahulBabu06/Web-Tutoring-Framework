# Supabase Setup

Web Tutoring Framework uses Supabase (Postgres + Auth) for student records, attendance, payments, refunds, parent accounts and child link requests. Without it the public site still works; the admin and parent pages show a "not configured" message instead of data.

1. Create a project at https://supabase.com/dashboard/projects.
2. Open the project, then open the SQL Editor.
3. Paste and run the SQL from `supabase/schema.sql`. It is safe to run again after pulling updates.
4. Optional: run `supabase/seed.sql` to add three demo students (they match the default `business.config.json`).
5. Open Project Settings, then API Keys.
6. Copy the project URL into `SUPABASE_URL`.
7. Copy the anon/public key into `SUPABASE_ANON_KEY`.
8. Copy a backend-only Secret key into `SUPABASE_SECRET_KEY`.

## What the schema contains

- `admin_students`, `admin_attendance`, `admin_payments`: students, register entries and payments. Credits only change through the `record_admin_payment`, `save_attendance_register` and refund functions, which lock rows so concurrent changes can't lose credits.
- `parent_profiles`, `parent_student_links`: parent portal accounts (Supabase Auth users) and their approved/pending links to students.
- `attendance_refund_requests`: parents asking for a charged absence to be refunded.
- `class_cancellations`: cancelled dates per group class (`class_id` is the `id` of a class in `business.config.json`).
- `parent_email_log`: every automatic parent email, so each one is sent once.
- `import_admin_backup`: restores a JSON backup in one transaction.

All tables have row level security on and are only reachable with the server's secret key.

Run the site with:

```sh
SUPABASE_URL="https://your-project-ref.supabase.co" \
SUPABASE_ANON_KEY="your-anon-public-key" \
SUPABASE_SECRET_KEY="your-secret-key" \
ADMIN_PASSWORD="choose-a-private-admin-password" \
ADMIN_SESSION_SECRET="choose-a-long-random-session-secret" \
GMAIL_OAUTH_CLIENT_ID="your-oauth-client-id" \
GMAIL_OAUTH_CLIENT_SECRET="your-oauth-client-secret" \
GMAIL_OAUTH_REFRESH_TOKEN="your-refresh-token" \
SITE_URL="https://your-site.example" \
node app.js
```

You can also copy `.env.example` to `.env` and fill it in.

Admin login stays disabled until `ADMIN_SESSION_SECRET` is set to a random value of at least 32 characters that differs from `ADMIN_PASSWORD`. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Logging out also revokes that admin session on the server until the site next restarts (sessions expire after 8 hours regardless). To sign out every admin session (for example after a device is lost), change `ADMIN_SESSION_SECRET` and restart the site.

Refund requests from parents are emailed to `ADMIN_NOTIFICATION_EMAIL`, or to `GMAIL_USER` if that isn't set. They're sent through the Gmail API (see below). Requests also appear at `/admin/refund-requests`.

In Supabase **Authentication > URL Configuration**, set **Site URL** to your `SITE_URL`, and add `<SITE_URL>/parents/login` (for sign-up confirmation links) and `<SITE_URL>/parents/reset-password` (for password resets) to **Redirect URLs**. If `SITE_URL` is not set, links use `siteUrl` from `business.config.json`; they are never built from the request's `Host` header. For local testing, set `SITE_URL=http://localhost:4000`.

Keep `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `GMAIL_OAUTH_CLIENT_SECRET`, and `GMAIL_OAUTH_REFRESH_TOKEN` out of git. These are server secrets. `SUPABASE_ANON_KEY` is public by design, but it still belongs in the server environment for this app.

## Email (Gmail API)

Booking and refund-request emails are sent with the Gmail API using OAuth 2.0, with only the `gmail.send` permission. That permission can send mail but can't read the inbox. App passwords are not used.

One-time setup, signed in as the Gmail account the site sends from (`GMAIL_USER`):

1. In https://console.cloud.google.com, create a project (e.g. "My tutoring website").
2. Go to **APIs & Services > Library**, search for **Gmail API** and click **Enable**.
3. Go to **Google Auth Platform** (OAuth consent screen). Choose **External**, fill in the app name and your email, and save.
4. Under **Audience**, click **Publish app** so the status is **In production**. If you leave it in **Testing**, Google expires the refresh token after 7 days and emails stop. You don't need Google's verification for your own account.
5. Under **Clients**, create an OAuth client of type **Desktop app**. Copy the client ID and client secret.
6. On your own computer, in this repo, run:

   ```sh
   GMAIL_OAUTH_CLIENT_ID="..." GMAIL_OAUTH_CLIENT_SECRET="..." npm run gmail:auth
   ```

   Open the link it prints and sign in as `GMAIL_USER`. You'll see "Google hasn't verified this app": click **Advanced > Go to ... (unsafe)**, then allow sending email. The terminal prints a refresh token.
7. On your host (or in `.env`), set `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET` and `GMAIL_OAUTH_REFRESH_TOKEN`, then delete `GMAIL_APP_PASSWORD`. Revoke any old app passwords at https://myaccount.google.com/apppasswords.

If you change the Google account password or remove the app's access at https://myaccount.google.com/permissions, run step 6 again and update the refresh token on your host.

## Parent emails

Once the Gmail API is set up, the site emails parents automatically. Emails go to the parent email on the student record and to any approved parent-portal account linked to the student (each address once):

- **Payment receipt:** when a paid payment adds lessons, from Stripe or from admin.
- **Attendance:** after a group class register is saved, with the outcome (present, free skip, charged or waived), credits left and free skips left. Saving the same register again doesn't resend it unless that student's entry changed.
- **Low credits:** once when a student's credits drop to `attendance.lowCreditThreshold` (default 2) or fewer. It's sent again only after a new payment.
- **Upcoming class:** for each group class, sent from `reminders.dayBeforeFromHour` (default 18:00) the day before until `reminders.sameDayUntilHour` (default noon) on the day, in the business `timeZone`. Not sent for cancelled classes.
- **Class cancelled:** when you cancel a date on a class register page in admin (and "back on" if you undo it).

Reminders are checked every 15 minutes while the server is running. Every email sent is recorded in `parent_email_log`, so each one goes out once, and cancelled dates are kept in `class_cancellations`. Both tables are in `schema.sql`.

To pause all parent emails, set `PARENT_EMAILS=off` on your host.

## Payments (Stripe)

Parents can buy a lesson pack (`lessonPack.credits`, default 10) from the parent portal with Stripe Checkout. A paid checkout is recorded with `record_admin_payment` (provider `stripe`), which adds the credits, earns free skips and emails `ADMIN_NOTIFICATION_EMAIL`. Repeat notifications for the same checkout session are ignored. No database change is needed.

1. In the Stripe Dashboard, copy the secret key from Developers > API keys and set it as `STRIPE_SECRET_KEY` on your host. Use the `sk_test_...` key while testing; test card `4242 4242 4242 4242` with any future date and CVC.
2. In Developers > Webhooks, add the endpoint `<SITE_URL>/stripe/webhook` with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
3. Prices come from `business.config.json` (`lessonPack.priceMinorUnits` and `oneToOne.lessons[].priceMinorUnits`, in pence/cents of `currency`). `LESSON_PACK_PRICE_PENCE` and `ONE_TO_ONE_<minutes>_PRICE_PENCE` override them. The public pages read the same values, so they stay in sync.
4. To go live, switch the Dashboard to live mode, repeat steps 1 and 2 with the live key, and use the live webhook's own signing secret.

The "Buy lessons" and "Pay for a 1-1 lesson" buttons only appear when `STRIPE_SECRET_KEY` is set. A 1-1 payment is recorded on the student with 0 credits and a "1-1 lesson (...)" note, so it doesn't change group class credits or free skips. The webhook is a backup for the success-page redirect, for example if the parent closes the tab before it loads.
