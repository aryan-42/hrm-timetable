# HRM Timetable

A live, personalised class timetable for the MBA-HRM (2025–27) batch at XIM University.
One link, sign in with a college Google account, and the app shows only that student's
section and electives — with attendance tracking, exam schedules and calendar export.

**Not an official XIM University application.** It mirrors the official class schedule;
where the two differ, the official sheet and faculty are the final word.

🔗 **Live:** https://hrm-t5-schedule.netlify.app

---

## What it does

- **Zero-tap onboarding** — signing in reads the roll number from the college email
  address and loads that student's section and courses from the official roster.
  No forms to fill.
- **Today / Week / Term / Me** — an "up next" countdown, the current week, the full
  term with key dates, and a profile tab.
- **Attendance tracking** — tap a past class to mark it missed; the app computes the
  percentage and how many more sessions can be missed against the 80% rule.
  *Personal records, not the official register.*
- **Exam schedules** — mid-term and end-term, filtered to each student's own papers,
  with time, venue and invigilating faculty.
- **Multi-term** — Term IV and Term V both configured; the app picks the active term
  by date. Preferences and attendance are stored per term so they never collide.
- **Automatic publishing** — a change in the sheet reaches the batch on the next
  sync, with no human step. A sanity check holds the update for an approver only
  when the parsed sheet looks broken.
- **Push notifications** — students are pushed the changes that affect their own
  courses and section. *iPhone: needs iOS 16.4+ and the app installed to the home
  screen.*
- **Manual overrides** — for changes announced before the sheet is updated.
- **Installable PWA** — works offline and opens fullscreen from the home screen.
- **Calendar export** — `.ics` of the student's own classes, exams and holidays.

## How it works

```
Official class schedule (Google Sheets, college-owned, one file per term)
        │
        │  Apps Script on a college account, every few hours.
        │  Skips entirely when the sheet hasn't changed.
        │  Strips struck-through (cancelled) classes before export.
        ▼
   timetable_staging ──┬── sanity check passes ──────────────▶ timetable_csv (live)
        │              │                                             │
        │              └── looks broken ─▶ held for approver         │
        │                                                            ▼
        │                                        notify-changes (Edge Function)
        │                                        diffs old vs new, web-pushes
        │                                        only the affected students
        │
   Supabase ── enrollment / enrollment_terms   roll → name, section, courses
             ── user_prefs                     per-student, per-term settings
             ── overrides                      manual, approver-posted
        │
        │  the app polls every 10 minutes and on open
        ▼
   index.html   (one static file, hosted on Netlify)
```

There is no server to run and no build step. The whole app is a single HTML file.

### Why the Apps Script is the way it is

The registrar maintains the schedule by hand, and cancels a class by **striking it
through** rather than deleting it. Plain CSV export loses that formatting, so a
cancelled class would still appear as live. The script reads the sheet's rich text and
drops struck-through runs before building the CSV — but only for cells that actually
contain a strikethrough, so dates and ordinary cells pass through untouched.

Updates publish automatically, but `push_staging` validates the parsed sheet first
and holds anything that looks structurally wrong. The check exists because of a real
failure: a v5.0 version of this script ran every cell through rich-text extraction
and blanked the date column on all 83 rows, producing 152 phantom changes. Only
losses are suspicious — the registrar adding classes is routine — so the gates are
a drop in date cells below 80% of the previous version, a drop in class tokens below
70%, or a CSV too short to be a real export.

A held update still appears in the approver's review panel, exactly as before.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app — HTML, CSS and JS in one file |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA shell, offline support, install icons |
| `timetable-data-bridge.gs` | Apps Script: reads the sheets, strips strikethrough, pushes to staging |
| `netlify.toml` | Hosting config, security headers, cache policy |
| `db/schema.sql` | Database schema and RLS policies (reference; no student data) |
| `supabase/functions/notify-changes/` | Edge Function: diffs a published change and web-pushes affected students |

## Deploying

Netlify auto-deploys on every push to `main`. No build command; publish directory `.`.
To preview locally, open `index.html` directly or run `python3 -m http.server`.

### Apps Script setup

1. On the **college account**, go to script.google.com → New project → paste
   `timetable-data-bridge.gs`
2. Services (+) → add **Drive API** (identifier `Drive`)
3. Project Settings → **Script Properties** → add `PUSH_SECRET`
   (the value is deliberately not in this repository)
4. Run `forcePush` once and authorise
5. Triggers → `pushStaging`, time-driven, every 4 hours

`pushStaging` skips any term whose sheet is unmodified, so most runs finish in a
second. `forcePush` ignores that check — use it after editing the script.

### Notification setup

1. **Secret** — Edge Functions → Secrets → add `VAPID_PRIVATE`: the 43-character
   base64url private key, on its own with no quotes, braces or JSON. The public
   half lives in `index.html` as `VAPID_PUBLIC` and is meant to be public; the
   function recovers the key's x and y coordinates from it, so the secret only
   ever has to carry the private scalar.
2. **Trigger** — Database → Webhooks → create a hook on `publish_log`, event
   `INSERT`, type *Supabase Edge Functions*, function `notify-changes`, and use
   "Add auth header with service key". Supabase supplies the key itself, so it
   never has to be stored anywhere.

The function is idempotent: it processes every published-but-unnotified row and
stamps `notified_at` as it goes. A failed send therefore retries on the next
publish instead of being lost, and a duplicate webhook delivery sends nothing twice.

## Configuration

The Supabase project URL and anon key sit at the top of the `<script>` in `index.html`.
The anon key is safe to publish: every table has Row Level Security, so the key grants
nothing on its own. The Apps Script push secret is **not** in this repository.

Term dates, sheet IDs and course catalogues live in the `TERMS` and `COURSE_INFO`
constants in `index.html`, and in `TERMS` in the Apps Script.

## Data and privacy

Only roll number, name, section and course codes are stored — no contact details.
A student can read only their own enrolment row and only their own preferences.
The schedule is read-only to students; publishing a change requires an approver.

---

Built by Aryan Singh (UH25076) for the MBA-HRM 2025–27 batch.
