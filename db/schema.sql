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
-- Called from the Apps Script on the college account. Writes the parsed sheet
-- to staging, then decides for itself whether it is safe to publish.
--
-- Normal registrar edits publish immediately. A structurally broken diff is
-- held for an approver instead. Only LOSSES are treated as suspicious: adding
-- classes is routine, a sheet that suddenly loses its dates is not. This gate
-- exists because a v5.0 Apps Script bug once blanked the date column on every
-- row and produced 152 phantom changes.
create or replace function public.push_staging(p_secret text, p_csv text, p_row int default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old text;
  v_old_dates int := 0; v_new_dates int := 0;
  v_old_tok   int := 0; v_new_tok   int := 0;
  v_reason text := null;
  v_mode   text;
begin
  if p_secret <> '<PUSH_SECRET — set per environment, never commit>' then
    raise exception 'invalid secret';
  end if;

  insert into public.timetable_staging (id, csv, pushed_at)
  values (p_row, p_csv, now())
  on conflict (id) do update set csv = excluded.csv, pushed_at = now();

  select csv into v_old from public.timetable_csv where id = p_row;

  v_new_dates := (select count(*) from regexp_matches(coalesce(p_csv,''), '[0-9]{1,2}-[A-Za-z]{3}-[0-9]{2}', 'g'));
  v_new_tok   := (select count(*) from regexp_matches(coalesce(p_csv,''), '[A-Z]{2,8}_[A-Za-z&]*[0-9]+', 'g'));
  v_old_dates := (select count(*) from regexp_matches(coalesce(v_old,''), '[0-9]{1,2}-[A-Za-z]{3}-[0-9]{2}', 'g'));
  v_old_tok   := (select count(*) from regexp_matches(coalesce(v_old,''), '[A-Z]{2,8}_[A-Za-z&]*[0-9]+', 'g'));

  if p_csv is null or length(p_csv) < 500 then
    v_reason := format('CSV too short (%s chars) — export probably failed', coalesce(length(p_csv),0));
  elsif v_old_dates > 0 and v_new_dates < ceil(v_old_dates * 0.8) then
    v_reason := format('date cells dropped %s -> %s', v_old_dates, v_new_dates);
  elsif v_old_tok > 0 and v_new_tok < ceil(v_old_tok * 0.7) then
    v_reason := format('class tokens dropped %s -> %s', v_old_tok, v_new_tok);
  end if;

  if v_reason is null then
    insert into public.timetable_csv (id, csv, approved_at, approved_by)
    values (p_row, p_csv, now(), 'auto')
    on conflict (id) do update
      set csv = excluded.csv, approved_at = now(), approved_by = 'auto';
    v_mode := 'auto';
  else
    v_mode := 'held';
  end if;

  insert into public.publish_log (term, mode, reason, date_cells, class_tokens, csv_before, csv_after)
  values (p_row, v_mode, v_reason, v_new_dates, v_new_tok,
          case when v_mode = 'auto' then v_old  else null end,
          case when v_mode = 'auto' then p_csv else null end);

  return jsonb_build_object('mode', v_mode, 'reason', v_reason, 'term', p_row,
    'date_cells', v_new_dates, 'class_tokens', v_new_tok,
    'changed', (v_old is distinct from p_csv));
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



-- ---------------------------------------------------------------------------
-- Auto-publish audit trail. One row per Apps Script push, recording whether it
-- went live or was held and why. csv_before/csv_after are kept for published
-- rows so the notifier can diff them; notified_at stamps when pushes went out.
-- ---------------------------------------------------------------------------
create table if not exists public.publish_log (
  id           bigserial primary key,
  term         integer not null,
  mode         text    not null check (mode in ('auto','held','manual')),
  reason       text,
  date_cells   integer,
  class_tokens integer,
  csv_before   text,
  csv_after    text,
  notified_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists publish_log_created_idx on public.publish_log (created_at desc);
alter table public.publish_log enable row level security;

create policy publish_log_read_approver on public.publish_log
  for select to authenticated
  using (exists (select 1 from public.approvers a
                 where a.roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1))));


-- ---------------------------------------------------------------------------
-- Web Push subscriptions. One row per browser/device; a student may only ever
-- see or change their own. The notify-changes Edge Function reads these with
-- the service role.
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  roll       text not null,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count integer not null default 0
);
create index if not exists push_subs_roll_idx on public.push_subscriptions (roll);
alter table public.push_subscriptions enable row level security;

create policy push_subs_own on public.push_subscriptions
  for all to authenticated
  using      (roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)))
  with check (roll = upper(split_part(coalesce(auth.jwt() ->> 'email',''),'@',1)));
