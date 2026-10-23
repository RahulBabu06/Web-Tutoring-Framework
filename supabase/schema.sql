create extension if not exists pgcrypto;

create table if not exists public.admin_students (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    parent_name text,
    parent_email text,
    phone text,
    preferred_class text,
    credits integer not null default 0,
    status text not null default 'active' check (status in ('active', 'inactive')),
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

alter table public.admin_students
add column if not exists credits integer not null default 0;

update public.admin_students
set credits = substring(notes from 'Imported credits:[[:space:]]*(-?[0-9]+)')::integer
where credits = 0
and notes ~* 'Imported credits:[[:space:]]*-?[0-9]+';

update public.admin_students
set notes = nullif(btrim(regexp_replace(coalesce(notes, ''), '(^|\n)Imported (batch|credits|old ID):[^\n]*(\n|$)', E'\n', 'gi')), '')
where notes ~* '(^|\n)Imported (batch|credits|old ID):';

create table if not exists public.admin_attendance (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.admin_students(id) on delete cascade,
    class_date date not null,
    status text not null check (status in ('present', 'absent')),
    credit_delta integer not null default 0,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (student_id, class_date)
);

alter table public.admin_attendance
add column if not exists charge_type text check (charge_type in ('attended', 'free_skip', 'charged', 'waived'));

create index if not exists admin_attendance_class_date_idx
on public.admin_attendance(class_date);

create table if not exists public.admin_payments (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references public.admin_students(id) on delete cascade,
    amount_pence integer not null default 0 check (amount_pence >= 0),
    currency text not null default 'GBP',
    status text not null default 'paid' check (status in ('pending', 'paid', 'failed', 'refunded', 'cancelled')),
    provider text not null default 'manual',
    payment_method text not null default 'manual',
    provider_payment_id text,
    provider_checkout_session_id text,
    credits_purchased integer not null default 0,
    paid_at timestamptz,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint admin_payments_provider_payment_id_key unique (provider, provider_payment_id),
    constraint admin_payments_provider_checkout_session_id_key unique (provider, provider_checkout_session_id)
);

create index if not exists admin_payments_student_id_idx
on public.admin_payments(student_id);

create index if not exists admin_payments_paid_at_idx
on public.admin_payments(paid_at desc);

create table if not exists public.parent_profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    full_name text not null,
    phone text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.parent_student_links (
    id uuid primary key default gen_random_uuid(),
    parent_id uuid not null references public.parent_profiles(id) on delete cascade,
    student_id uuid references public.admin_students(id) on delete set null,
    requested_child_name text not null,
    relationship text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    notes text,
    reviewed_notes text,
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.attendance_refund_requests (
    id uuid primary key default gen_random_uuid(),
    attendance_id uuid not null references public.admin_attendance(id) on delete cascade,
    student_id uuid not null references public.admin_students(id) on delete cascade,
    parent_id uuid not null references public.parent_profiles(id) on delete cascade,
    reason text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
    admin_notes text,
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists attendance_refund_requests_pending_idx
on public.attendance_refund_requests(attendance_id)
where status = 'pending';

create index if not exists attendance_refund_requests_parent_id_idx
on public.attendance_refund_requests(parent_id);

create unique index if not exists parent_student_links_parent_student_idx
on public.parent_student_links(parent_id, student_id)
where student_id is not null;

-- One pending request per parent and child name. Duplicates from earlier concurrent submits are
-- removed (keeping the oldest) so the index can be built.
delete from public.parent_student_links link
using public.parent_student_links earlier
where link.status = 'pending'
  and earlier.status = 'pending'
  and link.parent_id = earlier.parent_id
  and lower(btrim(link.requested_child_name)) = lower(btrim(earlier.requested_child_name))
  and (earlier.created_at, earlier.id) < (link.created_at, link.id);

create unique index if not exists parent_student_links_pending_child_name_idx
on public.parent_student_links(parent_id, lower(btrim(requested_child_name)))
where status = 'pending';

create index if not exists parent_student_links_parent_id_idx
on public.parent_student_links(parent_id);

create index if not exists parent_student_links_student_id_idx
on public.parent_student_links(student_id);

create index if not exists parent_student_links_status_idx
on public.parent_student_links(status, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists set_admin_students_updated_at on public.admin_students;

create trigger set_admin_students_updated_at
before update on public.admin_students
for each row
execute function public.set_updated_at();

drop trigger if exists set_admin_attendance_updated_at on public.admin_attendance;

create trigger set_admin_attendance_updated_at
before update on public.admin_attendance
for each row
execute function public.set_updated_at();

drop trigger if exists set_admin_payments_updated_at on public.admin_payments;

create trigger set_admin_payments_updated_at
before update on public.admin_payments
for each row
execute function public.set_updated_at();

drop trigger if exists set_parent_profiles_updated_at on public.parent_profiles;

create trigger set_parent_profiles_updated_at
before update on public.parent_profiles
for each row
execute function public.set_updated_at();

drop trigger if exists set_attendance_refund_requests_updated_at on public.attendance_refund_requests;

create trigger set_attendance_refund_requests_updated_at
before update on public.attendance_refund_requests
for each row
execute function public.set_updated_at();

drop trigger if exists set_parent_student_links_updated_at on public.parent_student_links;

create trigger set_parent_student_links_updated_at
before update on public.parent_student_links
for each row
execute function public.set_updated_at();

-- Matches maxPendingChildLinkRequests in app.js. The per-parent lock makes concurrent inserts
-- count each other's rows; app.js maps errcode WT001 to the "too many pending" message.
create or replace function public.enforce_pending_child_link_cap()
returns trigger
language plpgsql
as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('parent_student_links_pending:' || new.parent_id::text, 0));

    if (
        select count(*)
        from public.parent_student_links
        where parent_id = new.parent_id
          and status = 'pending'
    ) >= 5 then
        raise exception 'Too many pending child link requests' using errcode = 'WT001';
    end if;

    return new;
end;
$$;

drop trigger if exists enforce_pending_child_link_cap on public.parent_student_links;

create trigger enforce_pending_child_link_cap
before insert on public.parent_student_links
for each row
when (new.status = 'pending')
execute function public.enforce_pending_child_link_cap();

create or replace function public.record_admin_payment(
    p_student_id uuid,
    p_amount_pence integer,
    p_currency text default 'GBP',
    p_status text default 'paid',
    p_provider text default 'manual',
    p_payment_method text default 'manual',
    p_provider_payment_id text default null,
    p_provider_checkout_session_id text default null,
    p_credits_purchased integer default 0,
    p_paid_at timestamptz default now(),
    p_notes text default null
)
returns public.admin_payments
language plpgsql
security definer
set search_path = public
as $$
declare
    saved_payment public.admin_payments;
begin
    if nullif(p_provider_payment_id, '') is not null then
        insert into public.admin_payments (
            student_id,
            amount_pence,
            currency,
            status,
            provider,
            payment_method,
            provider_payment_id,
            provider_checkout_session_id,
            credits_purchased,
            paid_at,
            notes
        )
        values (
            p_student_id,
            p_amount_pence,
            upper(coalesce(nullif(p_currency, ''), 'GBP')),
            p_status,
            coalesce(nullif(p_provider, ''), 'manual'),
            coalesce(nullif(p_payment_method, ''), 'manual'),
            nullif(p_provider_payment_id, ''),
            nullif(p_provider_checkout_session_id, ''),
            p_credits_purchased,
            p_paid_at,
            nullif(p_notes, '')
        )
        on conflict (provider, provider_payment_id) do nothing
        returning * into saved_payment;
    elsif nullif(p_provider_checkout_session_id, '') is not null then
        insert into public.admin_payments (
            student_id,
            amount_pence,
            currency,
            status,
            provider,
            payment_method,
            provider_payment_id,
            provider_checkout_session_id,
            credits_purchased,
            paid_at,
            notes
        )
        values (
            p_student_id,
            p_amount_pence,
            upper(coalesce(nullif(p_currency, ''), 'GBP')),
            p_status,
            coalesce(nullif(p_provider, ''), 'manual'),
            coalesce(nullif(p_payment_method, ''), 'manual'),
            nullif(p_provider_payment_id, ''),
            nullif(p_provider_checkout_session_id, ''),
            p_credits_purchased,
            p_paid_at,
            nullif(p_notes, '')
        )
        on conflict (provider, provider_checkout_session_id) do nothing
        returning * into saved_payment;
    else
        insert into public.admin_payments (
            student_id,
            amount_pence,
            currency,
            status,
            provider,
            payment_method,
            provider_payment_id,
            provider_checkout_session_id,
            credits_purchased,
            paid_at,
            notes
        )
        values (
            p_student_id,
            p_amount_pence,
            upper(coalesce(nullif(p_currency, ''), 'GBP')),
            p_status,
            coalesce(nullif(p_provider, ''), 'manual'),
            coalesce(nullif(p_payment_method, ''), 'manual'),
            nullif(p_provider_payment_id, ''),
            nullif(p_provider_checkout_session_id, ''),
            p_credits_purchased,
            p_paid_at,
            nullif(p_notes, '')
        )
        returning * into saved_payment;
    end if;

    if saved_payment.id is null and nullif(p_provider_payment_id, '') is not null then
        select *
        into saved_payment
        from public.admin_payments
        where provider = coalesce(nullif(p_provider, ''), 'manual')
        and provider_payment_id = p_provider_payment_id
        limit 1;

        return saved_payment;
    end if;

    if saved_payment.id is null and nullif(p_provider_checkout_session_id, '') is not null then
        select *
        into saved_payment
        from public.admin_payments
        where provider = coalesce(nullif(p_provider, ''), 'manual')
        and provider_checkout_session_id = p_provider_checkout_session_id
        limit 1;

        return saved_payment;
    end if;

    if saved_payment.status = 'paid' and saved_payment.credits_purchased <> 0 then
        update public.admin_students
        set credits = credits + saved_payment.credits_purchased
        where id = saved_payment.student_id;
    end if;

    return saved_payment;
end;
$$;

alter table public.admin_students enable row level security;
alter table public.admin_attendance enable row level security;
alter table public.admin_payments enable row level security;
alter table public.parent_profiles enable row level security;
alter table public.parent_student_links enable row level security;
alter table public.attendance_refund_requests enable row level security;

revoke all on table public.admin_students from anon, authenticated;
revoke all on table public.admin_attendance from anon, authenticated;
revoke all on table public.admin_payments from anon, authenticated;
revoke all on table public.parent_profiles from anon, authenticated;
revoke all on table public.parent_student_links from anon, authenticated;
revoke all on table public.attendance_refund_requests from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.admin_students to service_role;
grant select, insert, update, delete on table public.admin_attendance to service_role;
grant select, insert, update, delete on table public.admin_payments to service_role;
grant select, insert, update, delete on table public.parent_profiles to service_role;
grant select, insert, update, delete on table public.parent_student_links to service_role;
grant select, insert, update, delete on table public.attendance_refund_requests to service_role;
revoke execute on function public.record_admin_payment(uuid, integer, text, text, text, text, text, text, integer, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.record_admin_payment(uuid, integer, text, text, text, text, text, text, integer, timestamptz, text) to service_role;

-- Credit changes are applied as deltas inside one transaction with the attendance change,
-- so concurrent payments, refunds and register saves never overwrite each other.
create or replace function public.save_attendance_register(p_class_date date, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    entry jsonb;
    v_student_id uuid;
    v_attendance_id uuid;
    v_old_delta integer;
    v_new_delta integer;
    v_credits integer;
    v_result jsonb := '[]'::jsonb;
begin
    for entry in
        select value
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
        order by value->>'student_id'
    loop
        v_student_id := (entry->>'student_id')::uuid;
        v_new_delta := coalesce((entry->>'credit_delta')::integer, 0);

        insert into public.admin_attendance (student_id, class_date, status, credit_delta)
        values (v_student_id, p_class_date, entry->>'status', 0)
        on conflict (student_id, class_date) do nothing;

        select a.id, a.credit_delta
        into v_attendance_id, v_old_delta
        from public.admin_attendance a
        where a.student_id = v_student_id
        and a.class_date = p_class_date
        for update;

        update public.admin_attendance
        set status = entry->>'status',
            credit_delta = v_new_delta,
            charge_type = entry->>'charge_type',
            notes = entry->>'notes'
        where id = v_attendance_id;

        if v_new_delta <> v_old_delta then
            update public.admin_students
            set credits = credits + (v_new_delta - v_old_delta)
            where id = v_student_id
            returning credits into v_credits;
        else
            select s.credits into v_credits from public.admin_students s where s.id = v_student_id;
        end if;

        v_result := v_result || jsonb_build_array(jsonb_build_object(
            'student_id', v_student_id,
            'credits', v_credits,
            'credit_difference', v_new_delta - v_old_delta
        ));
    end loop;

    return v_result;
end;
$$;

-- Returns the credits given back: 0 when the absence is no longer charged (already refunded or waived).
create or replace function public.refund_charged_absence(p_attendance_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_student_id uuid;
    v_delta integer;
begin
    select a.student_id, a.credit_delta
    into v_student_id, v_delta
    from public.admin_attendance a
    where a.id = p_attendance_id
    and a.status = 'absent'
    and a.credit_delta < 0
    for update;

    if not found then
        return 0;
    end if;

    update public.admin_attendance
    set credit_delta = 0,
        charge_type = 'waived'
    where id = p_attendance_id;

    update public.admin_students
    set credits = credits - v_delta
    where id = v_student_id;

    return -v_delta;
end;
$$;

-- Claims a pending refund request and refunds its absence in the same transaction.
create or replace function public.approve_refund_request(p_request_id uuid, p_admin_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_attendance_id uuid;
begin
    update public.attendance_refund_requests
    set status = 'approved',
        admin_notes = nullif(p_admin_notes, ''),
        reviewed_at = now()
    where id = p_request_id
    and status = 'pending'
    returning attendance_id into v_attendance_id;

    if not found then
        return jsonb_build_object('claimed', false, 'credits_restored', 0);
    end if;

    return jsonb_build_object('claimed', true, 'credits_restored', public.refund_charged_absence(v_attendance_id));
end;
$$;

revoke execute on function public.save_attendance_register(date, jsonb) from public, anon, authenticated;
revoke execute on function public.refund_charged_absence(uuid) from public, anon, authenticated;
revoke execute on function public.approve_refund_request(uuid, text) from public, anon, authenticated;
grant execute on function public.save_attendance_register(date, jsonb) to service_role;
grant execute on function public.refund_charged_absence(uuid) to service_role;
grant execute on function public.approve_refund_request(uuid, text) to service_role;

-- One row per cancelled group class date. class_id is the groupClasses[].id from business.config.json.
create table if not exists public.class_cancellations (
    id uuid primary key default gen_random_uuid(),
    class_id text not null,
    class_date date not null,
    reason text,
    created_at timestamptz not null default now(),
    constraint class_cancellations_class_id_class_date_key unique (class_id, class_date)
);

create table if not exists public.parent_email_log (
    id uuid primary key default gen_random_uuid(),
    dedupe_key text not null unique,
    kind text not null,
    student_id uuid references public.admin_students(id) on delete cascade,
    recipient text not null,
    sent_at timestamptz not null default now()
);

-- Lets restoring a class find its cancellation emails (dedupe_key like 'cancelled:<class id>:<date>:%') by prefix.
create index if not exists parent_email_log_dedupe_key_pattern_idx
    on public.parent_email_log (dedupe_key text_pattern_ops);

alter table public.class_cancellations enable row level security;
alter table public.parent_email_log enable row level security;
revoke all on table public.class_cancellations from anon, authenticated;
revoke all on table public.parent_email_log from anon, authenticated;
grant select, insert, update, delete on table public.class_cancellations to service_role;
grant select, insert, update, delete on table public.parent_email_log to service_role;


-- Imports a backup in one transaction, so a failed import changes nothing.
-- With p_replace, rows that are not in the backup are removed. If any would be and
-- p_allow_removals is not set, nothing is changed and the removal counts are returned.
create or replace function public.import_admin_backup(
    p_students jsonb,
    p_attendance jsonb default '[]'::jsonb,
    p_payments jsonb default '[]'::jsonb,
    p_replace boolean default false,
    p_allow_removals boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    removed_students integer := 0;
    removed_attendance integer := 0;
    removed_payments integer := 0;
    imported_students integer := 0;
    imported_attendance integer := 0;
    imported_payments integer := 0;
begin
    if jsonb_typeof(p_students) is distinct from 'array'
        or jsonb_typeof(p_attendance) is distinct from 'array'
        or jsonb_typeof(p_payments) is distinct from 'array' then
        raise exception 'import_admin_backup expects JSON arrays';
    end if;

    if p_replace then
        select count(*) into removed_students
        from public.admin_students s
        where not exists (
            select 1 from jsonb_to_recordset(p_students) as r(id uuid) where r.id = s.id
        );

        select count(*) into removed_attendance
        from public.admin_attendance a
        where not exists (
            select 1 from jsonb_to_recordset(p_attendance) as r(student_id uuid, class_date date)
            where r.student_id = a.student_id and r.class_date = a.class_date
        );

        select count(*) into removed_payments
        from public.admin_payments p
        where not exists (
            select 1 from jsonb_to_recordset(p_payments) as r(id uuid) where r.id = p.id
        );

        if (removed_students + removed_attendance + removed_payments) > 0 and not p_allow_removals then
            return jsonb_build_object(
                'status', 'confirmation_required',
                'removed_students', removed_students,
                'removed_attendance', removed_attendance,
                'removed_payments', removed_payments
            );
        end if;

        delete from public.admin_students s
        where not exists (
            select 1 from jsonb_to_recordset(p_students) as r(id uuid) where r.id = s.id
        );

        delete from public.admin_attendance a
        where not exists (
            select 1 from jsonb_to_recordset(p_attendance) as r(student_id uuid, class_date date)
            where r.student_id = a.student_id and r.class_date = a.class_date
        );

        delete from public.admin_payments p
        where not exists (
            select 1 from jsonb_to_recordset(p_payments) as r(id uuid) where r.id = p.id
        );
    end if;

    insert into public.admin_students (id, name, parent_name, parent_email, phone, preferred_class, credits, status, notes)
    select coalesce(r.id, gen_random_uuid()), r.name, r.parent_name, r.parent_email, r.phone, r.preferred_class,
        coalesce(r.credits, 0), coalesce(r.status, 'active'), r.notes
    from jsonb_to_recordset(p_students) as r(
        id uuid, name text, parent_name text, parent_email text, phone text,
        preferred_class text, credits integer, status text, notes text
    )
    on conflict (id) do update set
        name = excluded.name,
        parent_name = excluded.parent_name,
        parent_email = excluded.parent_email,
        phone = excluded.phone,
        preferred_class = excluded.preferred_class,
        credits = excluded.credits,
        status = excluded.status,
        notes = excluded.notes;
    get diagnostics imported_students = row_count;

    insert into public.admin_attendance (student_id, class_date, status, credit_delta, charge_type, notes)
    select r.student_id, r.class_date, r.status, coalesce(r.credit_delta, 0), r.charge_type, r.notes
    from jsonb_to_recordset(p_attendance) as r(
        student_id uuid, class_date date, status text, credit_delta integer, charge_type text, notes text
    )
    on conflict (student_id, class_date) do update set
        status = excluded.status,
        credit_delta = excluded.credit_delta,
        charge_type = excluded.charge_type,
        notes = excluded.notes;
    get diagnostics imported_attendance = row_count;

    insert into public.admin_payments (
        id, student_id, amount_pence, currency, status, provider, payment_method,
        provider_payment_id, provider_checkout_session_id, credits_purchased, paid_at, notes
    )
    select coalesce(r.id, gen_random_uuid()), r.student_id, coalesce(r.amount_pence, 0), coalesce(r.currency, 'GBP'),
        coalesce(r.status, 'paid'), coalesce(r.provider, 'manual'), coalesce(r.payment_method, 'manual'),
        r.provider_payment_id, r.provider_checkout_session_id, coalesce(r.credits_purchased, 0), r.paid_at, r.notes
    from jsonb_to_recordset(p_payments) as r(
        id uuid, student_id uuid, amount_pence integer, currency text, status text, provider text, payment_method text,
        provider_payment_id text, provider_checkout_session_id text, credits_purchased integer, paid_at timestamptz, notes text
    )
    on conflict (id) do update set
        student_id = excluded.student_id,
        amount_pence = excluded.amount_pence,
        currency = excluded.currency,
        status = excluded.status,
        provider = excluded.provider,
        payment_method = excluded.payment_method,
        provider_payment_id = excluded.provider_payment_id,
        provider_checkout_session_id = excluded.provider_checkout_session_id,
        credits_purchased = excluded.credits_purchased,
        paid_at = excluded.paid_at,
        notes = excluded.notes;
    get diagnostics imported_payments = row_count;

    return jsonb_build_object(
        'status', 'imported',
        'imported_students', imported_students,
        'imported_attendance', imported_attendance,
        'imported_payments', imported_payments,
        'removed_students', removed_students,
        'removed_attendance', removed_attendance,
        'removed_payments', removed_payments
    );
end;
$$;

revoke execute on function public.import_admin_backup(jsonb, jsonb, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.import_admin_backup(jsonb, jsonb, jsonb, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
