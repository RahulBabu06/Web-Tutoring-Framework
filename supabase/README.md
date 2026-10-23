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

For the full setup (API keys, Auth URL settings, Gmail, Stripe and deploying), see [docs/SETUP.md](../docs/SETUP.md).
