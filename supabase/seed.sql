-- Optional demo data for a fresh project. Run it in the SQL Editor after schema.sql.
-- preferred_class must match an option from business.config.json: "<name>, <time>" for a
-- group class, or the oneToOne.label. The values below match the default config.
-- Safe to re-run: rows are only inserted when a student with the same name doesn't exist yet.

with demo_students(name, parent_name, parent_email, preferred_class, credits, notes) as (
    values
        ('Ada Example', 'Grace Example', 'parent.ada@example.com', 'Wednesday group class, 6:45 PM - 7:45 PM', 10, 'Demo student'),
        ('Ben Example', 'Chris Example', 'parent.ben@example.com', 'Wednesday group class, 6:45 PM - 7:45 PM', 2, 'Demo student, low on credits'),
        ('Cara Example', 'Dana Example', 'parent.cara@example.com', '1-to-1 lessons', 0, 'Demo 1-to-1 student')
)
insert into public.admin_students (name, parent_name, parent_email, preferred_class, credits, notes)
select d.name, d.parent_name, d.parent_email, d.preferred_class, d.credits, d.notes
from demo_students d
where not exists (select 1 from public.admin_students s where s.name = d.name);

-- To remove the demo data later:
-- delete from public.admin_students where notes like 'Demo%';
