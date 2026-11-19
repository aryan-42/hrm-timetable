# Changelog

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
