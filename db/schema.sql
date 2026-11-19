-- =====================================================================
--  XIM HRM Timetable — database schema (Supabase / Postgres)
--
--  Reference documentation of the live schema. Student enrolment rows
--  are deliberately NOT included here: the roster maps roll numbers to
--  individual elective choices, and this repository is public.
--
--  Every table has Row Level Security enabled. The browser talks to this
--  database with the public anon key, so RLS — not the key — is what
--  protects the data.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Helper: is the caller signed in with a college Google account?
-- ---------------------------------------------------------------------
create or replace function public.is_xim_email()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') ilike '%xim.edu.in'
$$;


-- ---------------------------------------------------------------------
-- Timetable: one row per term. id = term row (1 = Term IV, 5 = Term V)
--
--  staging  <- written by the Apps Script every few hours
--  csv      <- promoted from staging only when an approver publishes
-- ---------------------------------------------------------------------
create table if not exists public.timetable_csv (
  id          int primary key,
  csv         text,
  updated_at  timestamptz default now(),
  approved_at timestamptz,
  approved_by text
);
alter table public.timetable_csv enable row level security;

-- the schedule itself is public, so the app works before sign-in
create policy "timetable_public_read" on public.timetable_csv
  for select using (true);


create table if not exists public.timetable_staging (
  id        int primary key,
  csv       text,
  pushed_at timestamptz default now()
);
alter table public.timetable_staging enable row level security;

-- unapproved data is visible only to signed-in college accounts
create policy "staging_college_read" on public.timetable_staging
  for select to authenticated using (public.is_xim_email());


-- ---------------------------------------------------------------------
-- Roster. Identity (name, section) is stable; courses change each term.
-- Each student can read ONLY their own row.
-- ---------------------------------------------------------------------
create table if not exists public.enrollment (
  roll    text primary key,
  name    text not null,
  courses text[] not null,          -- legacy Term IV list
  section text                      -- 'A' (UH25001-061) or 'B' (UH25062-125)
);
alter table public.enrollment enable row level security;

create policy "enrollment_read_own" on public.enrollment
  for select to authenticated
  using (
    public.is_xim_email()
    and roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''), '@', 1))
  );


create table if not exists public.enrollment_terms (
  roll    text not null,
  term    int  not null,
  courses text[] not null,
  primary key (roll, term)
);
alter table public.enrollment_terms enable row level security;

create policy "enrollment_terms_read_own" on public.enrollment_terms
  for select to authenticated
  using (
    public.is_xim_email()
    and roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''), '@', 1))
  );


-- ---------------------------------------------------------------------
-- Per-student settings and attendance, scoped per term so Term IV and
-- Term V never overwrite each other. Owner-only, read and write.
-- ---------------------------------------------------------------------
create table if not exists public.user_prefs (
  user_id    uuid not null references auth.users(id) on delete cascade,
  term       int  not null default 4,
  email      text not null,
  section    text not null check (section in ('A','B')),
  courses    text[] not null,
  attendance jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, term)
);
alter table public.user_prefs enable row level security;

create policy "prefs_select_own" on public.user_prefs
  for select using (auth.uid() = user_id);

create policy "prefs_insert_own" on public.user_prefs
  for insert with check (
    auth.uid() = user_id
    and public.is_xim_email()
    and email = (auth.jwt() ->> 'email')
  );

create policy "prefs_update_own" on public.user_prefs
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id and public.is_xim_email());


-- ---------------------------------------------------------------------
-- Approvers: the roll numbers allowed to publish a schedule change.
-- ---------------------------------------------------------------------
create table if not exists public.approvers (
  roll     text primary key,
  added_at timestamptz default now()
);
alter table public.approvers enable row level security;

create policy "approvers_read" on public.approvers
  for select to authenticated using (public.is_xim_email());


-- ---------------------------------------------------------------------
-- Manual overrides: changes announced before the official sheet catches
-- up. Readable by everyone (including signed-out students, so day-of
-- changes always reach them); writable only by approvers.
-- ---------------------------------------------------------------------
create table if not exists public.overrides (
  id         uuid primary key default gen_random_uuid(),
  for_date   date not null,
  section    text,                       -- null = both sections
  course     text,                       -- null = not course-specific
  kind       text not null default 'move',  -- move | cancel | add | note
  text       text not null,
  slot       int,
  created_by text not null,
  created_at timestamptz default now(),
  active     boolean not null default true
);
alter table public.overrides enable row level security;

create index if not exists overrides_active_date
  on public.overrides (for_date) where active;

create policy "overrides_public_read" on public.overrides
  for select to anon, authenticated using (true);

create policy "overrides_insert" on public.overrides
  for insert to authenticated
  with check (
    public.is_xim_email()
    and exists (select 1 from public.approvers a
                where a.roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)))
  );

create policy "overrides_update" on public.overrides
  for update to authenticated
  using (
    exists (select 1 from public.approvers a
            where a.roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)))
  );


-- ---------------------------------------------------------------------
-- Write paths. Both are SECURITY DEFINER, so each guards itself.
-- ---------------------------------------------------------------------

-- Called by the Apps Script. Guarded by a shared secret that is NOT in
-- this repository — it lives in Supabase and in the Apps Script project's
-- Script Properties. Replace the placeholder when provisioning a new
-- environment, and never commit the real value.
create or replace function public.push_staging(p_secret text, p_csv text, p_row int default 1)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_secret <> '<PUSH_SECRET — set per environment, never commit>' then
    raise exception 'invalid secret';
  end if;
  insert into public.timetable_staging (id, csv, pushed_at)
  values (p_row, p_csv, now())
  on conflict (id) do update set csv = excluded.csv, pushed_at = now();
end; $$;
revoke all on function public.push_staging(text,text,int) from public;
grant execute on function public.push_staging(text,text,int) to anon, authenticated;


-- Called from the app by an approver. Identity comes from the caller's
-- JWT, never from a parameter, so it cannot be spoofed client-side.
create or replace function public.approve_staging(p_row int default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_roll text := upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1));
begin
  if not public.is_xim_email() then
    raise exception 'college account required';
  end if;
  if not exists (select 1 from public.approvers where roll = v_roll) then
    raise exception 'not an approver';
  end if;
  insert into public.timetable_csv (id, csv, approved_at, approved_by)
  select p_row, s.csv, now(), v_roll
    from public.timetable_staging s where s.id = p_row
  on conflict (id) do update
    set csv = excluded.csv, approved_at = now(), approved_by = excluded.approved_by;
end; $$;
revoke all on function public.approve_staging(int) from public;
grant execute on function public.approve_staging(int) to authenticated;
