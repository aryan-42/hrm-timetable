# XIM Term-IV Timetable

A live, personalised class timetable for the MBA-HRM (2025–27) batch at XIM University.
Students open one link, sign in with their college Google account, and see only their own
section and electives — with attendance tracking, exam schedules, and calendar export.

**Not an official XIM University application.** It mirrors the official class schedule;
where the two differ, the official sheet and faculty are the final word.

---

## What it does

- **Zero-tap onboarding** — signing in reads the roll number from the college email and
  loads that student's section and 5 courses from the official enrolment roster.
- **Today / Week / Term / Me** — an "up next" countdown, week view, full term with key
  dates, and a profile tab.
- **Attendance tracker** — tap a past class to mark it missed; the app computes
  attendance % and how many more sessions can be missed against the 80% rule.
  *(Personal records, not the official register.)*
- **Exam schedules** — mid-term and end-term, filtered to each student's own papers,
  with time, venue and faculty.
- **Calendar export** — `.ics` of the student's classes, exams and holidays.
- **Human-approved updates** — schedule changes are staged, reviewed by an approver,
  then published to the batch.
- **Manual overrides** — for changes announced before the sheet is updated.

## Architecture

```
Official class schedule (Google Sheets, college-owned)
        │  hourly, Apps Script on a college account
        │  strips struck-through (cancelled) classes
        ▼
   timetable_staging ──── approver reviews the diff ───▶ timetable_csv (live)
        │
   Supabase ── enrollment (roll → name, section, courses)
             ── user_prefs (per-student prefs + attendance)
             ── overrides  (manual, approver-posted)
        ▼
   index.html  (single static file, hosted on Netlify)
```

No server to run. The site polls Supabase every 10 minutes; the sheet is pushed hourly.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire app — HTML, CSS and JS in one file |
| `timetable-data-bridge.gs` | Apps Script: reads the sheet, strips strikethrough, pushes to staging |
| `netlify.toml` | Hosting config, security headers, cache policy |

## Deploying

Netlify auto-deploys on every push to `main`. To preview locally, open `index.html`
directly or run `python3 -m http.server`.

### Apps Script setup
1. On the **college account**, go to script.google.com → New project → paste `timetable-data-bridge.gs`
2. Services (+) → add **Drive API** (identifier `Drive`)
3. **Project Settings → Script Properties →** add key `PUSH_SECRET` with the secret value
   (kept out of this repo on purpose — ask the maintainer)
4. Run `pushStaging` once and authorise
5. Triggers → `pushStaging`, time-driven, hourly

## Configuration

The Supabase URL and anon key sit at the top of the `<script>` in `index.html`.
The anon key is safe to publish — every table is protected by Row Level Security.
The Apps Script push secret is **not** in this repo; it lives only on the college account.

## Data & privacy

Only roll number, name, section and course codes are stored — no contact details.
Enrolment rows are readable only by the student they belong to. Attendance is private
to each student. The schedule is read-only to students; only an approver can publish
changes.

---

Built by Aryan Singh (UH25076) for the MBA-HRM 2025–27 batch.
