# Contributing

Thanks for helping improve Web Tutoring Framework.

## Getting started

1. Fork and clone the repo, then run `npm install` (Node.js 20 or newer).
2. Copy `.env.example` to `.env`. You don't need any accounts to run the public site; set `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` to try the admin pages.
3. `npm start`, then open http://localhost:4000.

For database work, create a free Supabase project and run `supabase/schema.sql` (see [supabase/README.md](supabase/README.md)). Use Stripe test keys only.

## Making changes

- Keep the layout: `src/config` (settings), `src/integrations` (Supabase, Stripe, Gmail clients), `src/middleware`, `src/services` (business logic), `src/routes` (Express routers), `views/` (EJS), `public/` (static files), `supabase/` (SQL).
- Business-specific values belong in `business.config.json` or environment variables, not in code or templates.
- Every integration must keep working when it isn't configured: check its `isConfigured` flag and show a setup message instead of failing.
- Credit changes go through Postgres functions (`record_admin_payment`, `save_attendance_register`, ...) so they stay transactional. Don't write absolute credit values from Node.
- The Content Security Policy only allows scripts from the site itself: no inline `<script>` blocks or `onclick=` attributes. Put browser code in `public/`.
- If you change `supabase/schema.sql`, keep it safe to re-run on an existing database (`if not exists`, `create or replace`).

## Before opening a pull request

- `npm run check` (syntax-checks every JavaScript file) and `npm test`.
- Start the app and click through the pages you touched.
- Never commit `.env`, keys, OAuth tokens, credential JSON files or backups from `data/`.
- Describe what changed and why in the PR. Small, focused PRs are easiest to review.

## Reporting security issues

Please don't open a public issue for security problems. Contact the maintainer through GitHub instead.
