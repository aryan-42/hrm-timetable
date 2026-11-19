# Changelog

## v8.4
- **Fixed:** approving a held update published it without notifying anyone.
  `approve_staging` wrote straight to the live table, and the notifier is driven
  by `publish_log`, so an approved change reached the batch in silence. It now
  records the publish like any other, and the notifier covers approved updates
  as well as automatic ones.
- Notifications vibrate and stay on screen until dismissed. Web Push has no
  custom-sound option on Android Chrome — the tone comes from the system
  notification channel for the site — so the payload now sets `silent: false`
  and a vibration pattern rather than pretending to control the sound.

## v8.3
- **Changes now go live automatically.** The Apps Script push publishes straight to
  the batch instead of waiting for an approver. A sanity check runs first and holds
  the update only when the parsed sheet looks structurally broken — dates
  disappearing, most classes vanishing, or a truncated export. Growth is never
  blocked; only losses are treated as suspicious. Every push is recorded in
  `publish_log` with the decision and the reason.
- **Push notifications.** When a published change touches a student's own course
  *and* section, they get a push — matched per student, so nobody is told about
  courses they don't take. Opt in from the Me tab.
  On iPhone this needs iOS 16.4+ and the app installed to the home screen;
  the Me tab says so rather than offering a button that can't work.
- Approval remains available for held updates, and the review panel is unchanged.

## v8.2
- Overrides manager in the Me tab: approvers see every active manual override in one
  place and can remove stale ones. Previously an override for a past date stayed
  active in the database but dropped out of the app's view, so it could never be
  cleared — it just kept applying.
- Override text is HTML-escaped on render

## v8.1
- Installable PWA: manifest, offline service worker, home-screen icons
- "Term begins in N days" state instead of a bare empty day before term starts
- Faculty initials in class codes spelled out (`DTHR_SB2` → Prof. Sanjay Bhattacharya)

## v8.0
- Term tab key dates collapse to the next three, so the schedule isn't pushed below the fold

## v7.7
- **Fixed:** classes written as `TAMA_A1/ ECRM_B1` lost the first course — the parser split
  on whitespace only, so the trailing slash broke the token. Affected TAMA and ECRM,
  i.e. most of the batch.

## v7.6
- Course list rebuilds from the timetable grid when a term's sheet lists courses without
  the code in brackets; palette widened to 10 so all 9 Term V courses stay distinct

## v7.3 – v7.5
- Term V live from 8 Sep; exams keyed by date so remaining Term IV end-terms stay visible
- Preferences and attendance moved per-term in the database — Term IV courses were
  being loaded against the Term V schedule, leaving students with an empty timetable

## v7.0 – v7.2
- Multi-term support: both terms configured, active term chosen by date
- Parser distinguishes section letters from faculty initials — a course is section-split
  only when both `_A` and `_B` forms appear, so `DTHR_A7` reads as faculty, not Section A
- Term V enrolment loaded (121 students × 4 courses)

## v6.7
- End-term exam schedule; exam rows and calendar events labelled Mid-Term / End-Term

## v6.5 – v6.6
- Exams show start time only (no assumed durations), 12-hour format

## v6.4
- Official mid-term exam schedule, filtered per student, with venue and faculty

## v6.3
- Change notifications respect section as well as course; no toast for changes that
  don't affect the viewer

## v6.2
- **Fixed:** the approver's review panel was filtered to the approver's own courses
  while publishing applied every change — other courses shipped unreviewed

## v6.0 – v6.1
- Manual override layer for changes announced before the sheet is updated
- Overrides made publicly readable so they reach students who haven't signed in

## v5.0 – v5.5
- Staging and human approval workflow
- Apps Script strips struck-through (cancelled) classes using rich text
- Confirmed multi-day exam and immersion spans; switched to the new source spreadsheet

## v4.0 – v4.1
- Roster-driven onboarding: section and courses loaded from the college email address

## v3.0
- Rebuilt around tabs (Today / Week / Term / Me), attendance tracking, change alerts

## v2.0
- College Google sign-in; preferences synced to the student's account

## v1.0
- First version: live sheet sync, per-student filtering, calendar export
