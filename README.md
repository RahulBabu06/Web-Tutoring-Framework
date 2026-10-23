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

Open http://localhost:4000. You now have the public site, and booking requests are saved on the server.

To log in to the admin area, add these two lines to `.env`, restart (`Ctrl+C`, then `npm start`) and go to http://localhost:4000/admin:

```sh
ADMIN_PASSWORD=choose-a-password
ADMIN_SESSION_SECRET=paste-the-output-of-the-command-below
```

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### What works without any accounts

| You've set up | What works |
| --- | --- |
| Nothing | Public pages, booking form. Requests are saved to `data/booking-requests.jsonl` |
| + admin password | Admin login and the **Bookings** page listing those requests |
| + [Supabase](docs/SETUP.md#2-supabase-database-and-parent-accounts) (free) | Students, registers, credits and free skips, payments, refunds, parent portal |
| + [Gmail API](docs/SETUP.md#3-gmail-api-emails) | Booking requests emailed to you, automatic parent emails |
| + [Stripe](docs/SETUP.md#4-stripe-online-payments) | Parents pay for lesson packs and 1-to-1 lessons online |

Step-by-step instructions for each are in [docs/SETUP.md](docs/SETUP.md).

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

## Customise your site

- **Business details, classes, prices and rules:** `business.config.json` (above). Restart after editing.
- **Page wording:** the public pages are EJS templates in `views/site/` (`home.ejs`, `lessons.ejs`, `book-now.ejs`, `contact.ejs`, `thank-you.ejs`, `cookies.ejs`). Edit the text between the tags; leave the `<%= ... %>` parts, which fill in values from the config.
- **Header and footer:** `views/partials/site-header.ejs` and `views/partials/site-footer.ejs`.
- **Logo and photos:** put image files in `public/` (for example `public/logo.png`) and they're served from the site root (`/logo.png`). To use a logo instead of the text name, replace the `brand-wordmark` span in `site-header.ejs` with `<img src="/logo.png" alt="<%= business.name %>">`.
- **Colours and fonts:** `public/styles.css`.
- **Cookie policy:** review `views/site/cookies.ejs` so it matches how you run the site.

## Integrations

Each integration is switched on by its environment variables. When one is missing, the app logs a warning at startup and carries on, and the affected pages say what's missing:

| Integration | Variables | Without it |
| --- | --- | --- |
| Admin login | `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` | `/admin` explains which settings are missing |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY` | Admin pages show "Database service is not configured yet"; parent sign-up and login are unavailable |
| Gmail API | `GMAIL_USER`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` | Booking requests are only saved to the admin **Bookings** page; no parent emails |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | No "Buy" buttons for parents; you can still record payments in admin |

See [docs/SETUP.md](docs/SETUP.md) for setting each one up, plus deploying.

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
supabase/               schema.sql and seed.sql
docs/SETUP.md           Step-by-step setup for admin, Supabase, Gmail, Stripe and deploying
scripts/                Gmail OAuth helper and the syntax check
```

## Scripts

- `npm start`: run the server (`PORT`, default 4000).
- `npm run check`: syntax-check every JavaScript file.
- `npm test`: run tests with the built-in Node test runner.
- `npm run gmail:auth`: one-off helper to get a Gmail API refresh token.

## Deploying

Any Node.js host works (Render, Railway, Fly.io, a VPS). See [docs/SETUP.md](docs/SETUP.md#5-deploying).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests are welcome in [Issues](https://github.com/RahulBabu06/Web-tutoring-framework/issues).

## License

[MIT](LICENSE)
