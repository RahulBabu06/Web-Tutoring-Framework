# Web Tutoring Framework

An open-source website and management app for small tutoring businesses: public marketing pages and a booking form, an admin area for students, registers, lesson credits, payments and refunds, and a parent portal where families see their child's lessons and pay online.

It runs as a single Node.js server (Express + EJS). Supabase, Stripe and Gmail are optional: a basic site boots with none of them.

## Features

- **Public site**: home, lessons, booking, contact, thank-you and cookie pages, generated from `business.config.json`.
- **Booking requests** emailed to you (Gmail API).
- **Admin** (`/admin`): students, a register per group class (present / absent, free skips, waived charges), class cancellations with parent emails, payments, refund and parent-link requests, JSON backups and restore.
- **Lesson credits and free skips**: each class attended uses a credit; absences use a free skip first. Allowances are configurable.
- **Parent portal** (`/parents`): sign up, link a child, see attendance and payments, request refunds, buy lesson packs or 1-to-1 lessons with Stripe Checkout.
- **Automatic parent emails**: receipts, attendance outcomes, low-credit warnings, class reminders and cancellations.

## Quick start

Requires Node.js 20 or newer.

```sh
git clone https://github.com/RahulBabu06/Web-tutoring-framework.git
cd Web-tutoring-framework
npm install
cp .env.example .env
npm start
```

Open http://localhost:4000. To try the admin pages, set `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` (32+ random characters) in `.env`, restart, and go to http://localhost:4000/admin.

## Configure your business

Edit `business.config.json` (or point `BUSINESS_CONFIG` at your own copy):

| Key | What it controls |
| --- | --- |
| `name`, `shortName`, `tagline`, `description`, `tutorName` | Branding on every page and email |
| `siteUrl` | Public URL used in emails, Stripe and Supabase links (`SITE_URL` overrides it) |
| `contact` | Email, phone, address and `socialLinks` (`[{ "label": "...", "url": "..." }]`) shown in the footer and contact page |
| `locale`, `currency`, `timeZone` | Money and date formatting, Stripe currency, and the clock used for registers and reminders |
| `levels` | Choices for the "Level" field on the booking form |
| `groupClasses` | Any number of weekly classes: `id` (used in URLs, keep it stable), `name`, `day` (`monday`...`sunday`), `time`, `description` |
| `oneToOne` | Turn 1-to-1 lessons on/off, their `label`, bookable `timeSlots`, and `lessons` (length in `minutes`, `label`, `priceMinorUnits`) |
| `lessonPack` | Credits in a pack and its price in minor units (pence/cents) |
| `attendance` | `initialFreeSkips`, `freeSkipsPerPaidBlock`, `paidCreditsPerBlock`, `maxFreeSkipsHeld`, `lowCreditThreshold` |
| `reminders` | When class reminders go out: from `dayBeforeFromHour` the day before until `sameDayUntilHour` on the day |

A student's class is stored as text (`"<name>, <time>"` for a group class, or the 1-to-1 label). If you rename a class or change its time, update existing students' "Preferred class" in admin.

Secrets and per-deploy settings go in `.env` (see [.env.example](.env.example)). Everything in `.env` can also be set as normal environment variables on your host.

## Integrations

Each integration is switched on by its environment variables and checked with an `isConfigured` flag. When one is missing, the app logs a warning and carries on:

| Integration | Variables | Without it |
| --- | --- | --- |
| Admin login | `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | `/admin` shows a "not configured" login page |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY` | Admin pages show a setup message; parent sign-up/login is unavailable |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Parents don't see "Buy" buttons; payments can still be recorded manually in admin |
| Gmail API | `GMAIL_USER`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` | Booking requests are accepted but not emailed; parent emails are skipped |

Setup steps for all three are in [supabase/README.md](supabase/README.md).

## Project layout

```
app.js                  Entry point (imports src/server.js)
business.config.json    Your business settings
src/
  server.js             Starts the HTTP server and the parent reminder timer
  app.js                Builds the Express app, view helpers and wires services to routes
  config/               env.js (environment + business config), classes.js (class options, statuses)
  integrations/         Supabase, Stripe and Gmail clients
  middleware/           Auth, CSRF/security headers, rate limits, sessions, errors
  services/             Students, attendance, payments, refunds, parents, emails, booking, backups
  routes/               Public pages, booking, admin and parent portal routers
views/                  EJS templates (site/ for public pages, partials/, admin and parent pages)
public/                 CSS, fonts and browser scripts
supabase/               schema.sql, seed.sql and setup guide
scripts/                Gmail OAuth helper and the syntax check
```

## Scripts

- `npm start`: run the server (`PORT`, default 4000).
- `npm run check`: syntax-check every JavaScript file.
- `npm test`: run tests with the built-in Node test runner.
- `npm run gmail:auth`: one-off helper to get a Gmail API refresh token.

## Deploying

Any Node.js host works (Render, Railway, Fly.io, a VPS). Set the environment variables from `.env.example` on the host, use `npm start` as the start command, and set `SITE_URL` to your public URL. Local backups are written to `DATA_DIR` (default `./data`); use a persistent disk if you rely on them.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests are welcome in [Issues](https://github.com/RahulBabu06/Web-tutoring-framework/issues).

## License

[MIT](LICENSE)
