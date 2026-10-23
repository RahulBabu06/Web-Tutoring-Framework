# Setup guide

Do these in order. After each step, restart the site (`Ctrl+C`, then `npm start`). The site works after every step; each one switches on more features. All settings go in your `.env` file (copied from `.env.example`). On a host, set them as environment variables instead.

1. [Admin login](#1-admin-login) (2 minutes)
2. [Supabase: database and parent accounts](#2-supabase-database-and-parent-accounts) (10 minutes, free)
3. [Gmail API: emails](#3-gmail-api-emails) (20 minutes, free)
4. [Stripe: online payments](#4-stripe-online-payments) (15 minutes)
5. [Deploying](#5-deploying)

Before starting, put your own details in `business.config.json` (see the [README](../README.md#configure-your-business)).

## 1. Admin login

1. Generate a session secret:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. In `.env`, set:

   ```sh
   ADMIN_PASSWORD=choose-a-long-password
   ADMIN_SESSION_SECRET=the-value-printed-above
   ```

3. Restart and log in at http://localhost:4000/admin.

The secret must be at least 32 characters and different from the password; if it isn't, the login page says so. Admin sessions last 8 hours. To sign out every admin session (for example after losing a device), change `ADMIN_SESSION_SECRET` and restart.

Without the next steps, admin has one working page: **Bookings**, listing requests sent from the booking form.

## 2. Supabase: database and parent accounts

Supabase stores students, registers, credits, payments, refunds and parent accounts.

1. Create a free project at https://supabase.com/dashboard/projects. Pick a region near you and save the database password somewhere safe (the site doesn't need it).
2. Open **SQL Editor**, paste all of [`supabase/schema.sql`](../supabase/schema.sql) and click **Run**. It's safe to run again later when you update the framework.
3. Optional: run [`supabase/seed.sql`](../supabase/seed.sql) the same way to add three demo students, so you can try registers straight away. It matches the default `business.config.json`; delete the demo students when you're done (the query is at the bottom of the file).
4. Open **Project Settings > API Keys** and copy into `.env`:

   ```sh
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY=the anon / publishable key
   SUPABASE_SECRET_KEY=a secret key (sb_secret_...) or the legacy service_role key
   ```

5. Open **Authentication > URL Configuration**. Set **Site URL** to your `SITE_URL` (`http://localhost:4000` while testing) and add these to **Redirect URLs**:
   - `<SITE_URL>/parents/login` (sign-up confirmation links)
   - `<SITE_URL>/parents/reset-password` (password reset links)
6. Restart. The admin pages now show your students, and parents can sign up at `/parents/register`.

Supabase emails new parents a confirmation link before they can log in. Its built-in mailer only sends a few emails an hour; for real use, add your own SMTP server under **Authentication > Emails > SMTP Settings**.

**How parents get access:** a parent signs up, then asks to link their child by name. You approve the request under **Parent links** in admin. After that they can see attendance and payments, request refunds and pay online.

**Keep secret:** `SUPABASE_SECRET_KEY` gives full access to your data. Never put it in the browser, a screenshot or git. `SUPABASE_ANON_KEY` is public by design.

## 3. Gmail API: emails

The site sends email through a Gmail (or Google Workspace) account using the Gmail API with only the "send email" permission, so it can't read your inbox. You need this for:

- booking requests emailed to you (without it, check admin **Bookings**),
- refund-request and payment notifications to you (`ADMIN_NOTIFICATION_EMAIL`, defaults to `GMAIL_USER`),
- automatic parent emails (below).

One-time setup, signed in as the Gmail account the site will send from:

1. Go to https://console.cloud.google.com and create a project (e.g. "My tutoring website").
2. **APIs & Services > Library**: search for **Gmail API** and click **Enable**.
3. **Google Auth Platform** (OAuth consent screen): choose **External**, fill in the app name and your email, and save.
4. Under **Audience**, click **Publish app** so the status is **In production**. If you leave it in **Testing**, Google expires the token after 7 days and emails stop. You don't need Google's verification to use your own account.
5. Under **Clients**, create an OAuth client of type **Desktop app**. Copy the client ID and client secret.
6. On your computer, in this folder, run:

   ```sh
   GMAIL_OAUTH_CLIENT_ID="..." GMAIL_OAUTH_CLIENT_SECRET="..." npm run gmail:auth
   ```

   Open the link it prints and sign in as the sending account. Google warns "Google hasn't verified this app": click **Advanced > Go to ... (unsafe)** (it's your own app), then allow sending email. The terminal prints a refresh token.
7. In `.env`, set:

   ```sh
   GMAIL_USER=you@gmail.com
   GMAIL_OAUTH_CLIENT_ID=...
   GMAIL_OAUTH_CLIENT_SECRET=...
   GMAIL_OAUTH_REFRESH_TOKEN=the token from step 6
   ```

8. Restart, then send yourself a test booking from `/book-now`.

If you change the Google account's password or remove the app at https://myaccount.google.com/permissions, repeat step 6 and update the refresh token.

### Parent emails

Once Gmail is set up, parents are emailed automatically. Emails go to the parent email on the student record and to every approved parent-portal account linked to the student (each address once):

- **Payment receipt:** when a paid payment adds lessons, from Stripe or recorded in admin.
- **Attendance:** after a group class register is saved: present, free skip, charged or waived, with credits and free skips left. Saving the same register again only re-sends to students whose entry changed.
- **Low credits:** once when credits drop to `attendance.lowCreditThreshold` (default 2) or fewer. Sent again only after a new payment.
- **Class reminder:** before each group class, sent between `reminders.dayBeforeFromHour` (default 18:00) the day before and `reminders.sameDayUntilHour` (default 12:00) on the day, in your `timeZone`. Not sent for cancelled dates.
- **Class cancelled:** when you cancel a date on a class register page, and "back on" if you undo it.

Reminders are checked every 15 minutes while the server runs. Every email is recorded in the `parent_email_log` table so each goes out once. To pause all parent emails, set `PARENT_EMAILS=off`.

## 4. Stripe: online payments

With Stripe, parents can buy a lesson pack (`lessonPack` in `business.config.json`) or pay for a 1-to-1 lesson from the parent portal. A completed checkout adds the credits (and any free skips earned), emails a receipt and notifies you. 1-to-1 payments are recorded with 0 credits, so they don't change group class credits. Prices come from `business.config.json`, so the public pages and checkout always agree.

Stripe needs Supabase (step 2). Use test mode first.

1. Create an account at https://dashboard.stripe.com and switch on **Test mode**.
2. **Developers > API keys**: copy the secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
3. Tell the site when payments complete (a webhook). Pick one:
   - **Testing on your computer:** install the [Stripe CLI](https://docs.stripe.com/stripe-cli), run `stripe login`, then keep this running in a second terminal:

     ```sh
     stripe listen --forward-to localhost:4000/stripe/webhook --events checkout.session.completed,checkout.session.async_payment_succeeded
     ```

     It prints a signing secret (`whsec_...`). Put it in `STRIPE_WEBHOOK_SECRET`.
   - **On your live site:** **Developers > Webhooks > Add endpoint**, URL `<SITE_URL>/stripe/webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Restart. Log in as a parent with an approved linked child; the **Buy** buttons now appear. Pay with test card `4242 4242 4242 4242`, any future expiry date and any CVC.
5. To go live, turn off test mode, repeat steps 2 and 3 with the live secret key and a live webhook endpoint, and restart.

The webhook is a backup for the page parents return to after paying (for example if they close the tab early). A payment is only recorded once, however many times Stripe notifies the site.

## 5. Deploying

Any Node.js 20+ host works (Render, Railway, Fly.io, a VPS):

1. Push your copy of this repo to GitHub (your `.env` is ignored by git; keep it that way).
2. Create a web service from the repo with build command `npm install` and start command `npm start`. The site listens on `PORT`, which most hosts set for you.
3. Add every value from your `.env` as an environment variable on the host, and set `SITE_URL` to your public address (e.g. `https://www.your-site.com`).
4. Update the Supabase Site URL and Redirect URLs (step 2.5) and the Stripe webhook (step 4.3) to use that address.

**Saved files:** booking requests (`booking-requests.jsonl` and their statuses in `booking-request-status.json`), signed-out admin sessions and admin backups are written to `DATA_DIR` (default `./data`). Many hosts wipe local files on each deploy, so either attach a persistent disk and point `DATA_DIR` at it, or set up Gmail so booking requests reach your inbox.

**What the admin backup covers:** the Backup page saves students, attendance and payments only. Parent accounts, parent-child links, refund requests, class cancellations and email logs stay in Supabase, so turn on Supabase's database backups (or run `pg_dump`) as well. Booking requests live in `DATA_DIR` and your settings in `business.config.json`, so copy those too.

## Troubleshooting

- **"Database service is not configured yet":** one of `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_SECRET_KEY` is missing. Check `.env` and restart.
- **A message about missing tables or functions in admin:** run `supabase/schema.sql` again in the SQL Editor.
- **Parent confirmation or reset links go to the wrong site:** check `SITE_URL` and the Supabase URL Configuration (step 2.5).
- **No emails:** the startup log says "Gmail API credentials (GMAIL_OAUTH_*) are not set" when Gmail isn't configured. If they're set but sending fails, the error is logged; usually the refresh token expired (step 3.4 or 3.6).
- **Payments not showing up:** check the webhook signing secret matches the `stripe listen` session or the endpoint you created, and that the events are subscribed.
- **"This form must be submitted from this website":** forms only work from `SITE_URL` or the address you opened the site with. Use the same address in your browser as in `SITE_URL`.
