/**
 * XIM TIMETABLE — STAGING PUSH BRIDGE (v8)
 *
 * Reads the official class schedules, strips struck-through (cancelled) classes,
 * and pushes each term to its Supabase staging row. Nothing reaches students
 * until an approver publishes it in the app.
 *
 * v8 fixes the repeated DEADLINE_EXCEEDED / drive.files.copy failures:
 *   - skips all work when a sheet hasn't been modified since the last push
 *   - retries the flaky Drive copy with backoff instead of dying
 *   - refuses to run twice at once (LockService)
 *   - always cleans up temp copies, including orphans left by earlier crashes
 *
 * SETUP
 * 1. script.google.com on the COLLEGE account -> paste this file
 * 2. Services (+) -> add "Drive API" (identifier: Drive)
 * 3. Project Settings -> Script Properties -> add PUSH_SECRET
 * 4. Triggers -> pushStaging -> time-driven -> EVERY 4 HOURS (hourly is unnecessary;
 *    the schedule changes a few times a term and students still poll every 10 min)
 */

const TERMS = [
  { term: 4, row: 1, fileId: "1o766BFepifra3xqzfin-6neuo4HBNRy6" }, // Term IV
  { term: 5, row: 5, fileId: "1AepdHDxX9lCATxaQwrv9_Hv7v6nKYSzq" }, // Term V
];

const SUPABASE_RPC  = "https://atfkuxvjrypsdxxmsmnm.supabase.co/rest/v1/rpc/push_staging";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0Zmt1eHZqcnlwc2R4eG1zbW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDExMDUsImV4cCI6MjA5NjY3NzEwNX0.SNFiiI3qKxxPiUwMh2Vb_ksMcdKp4x7GZEg-zUXctvk";
const PUSH_SECRET = PropertiesService.getScriptProperties().getProperty("PUSH_SECRET");

const TMP_PREFIX = "tt-tmp-";

/* ---------------- entry point ---------------- */
function pushStaging() {
  if (!PUSH_SECRET) throw new Error(
    'PUSH_SECRET not set. Project Settings -> Script Properties -> add key "PUSH_SECRET".');

  // never let two runs overlap — that was one source of the INTERNAL errors
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log("another run is in progress; skipping");
    return;
  }
  try {
    cleanupOrphans_();                       // remove temp copies left by crashed runs
    const props = PropertiesService.getScriptProperties();
    const errors = [];

    TERMS.forEach(function (t) {
      try {
        // Skip entirely if the sheet has not changed since we last pushed it.
        // This is what stops the hourly Drive-copy churn.
        const modified = String(Drive.Files.get(t.fileId).modifiedDate ||
                                Drive.Files.get(t.fileId).modifiedTime || "");
        const key = "lastMod_" + t.term;
        if (modified && props.getProperty(key) === modified) {
          Logger.log("Term " + t.term + ": unchanged, skipped");
          return;
        }
        pushOneTerm_(t);
        if (modified) props.setProperty(key, modified);
      } catch (e) {
        errors.push("Term " + t.term + ": " + e.message);
        Logger.log("Term " + t.term + " FAILED: " + e.message);
      }
    });

    if (errors.length) throw new Error(errors.join(" | "));
  } finally {
    lock.releaseLock();
  }
}

/** Force a push even when nothing changed (use after editing this script). */
function forcePush() {
  PropertiesService.getScriptProperties().deleteProperty("lastMod_4");
  PropertiesService.getScriptProperties().deleteProperty("lastMod_5");
  pushStaging();
}

/* ---------------- one term ---------------- */
function pushOneTerm_(t) {
  const tmpId = copyWithRetry_(t.fileId);
  let csv;
  try {
    const sheet = SpreadsheetApp.openById(tmpId).getSheets()[0];
    csv = toCSV_(cleanedDisplayValues_(sheet));
  } finally {
    try { Drive.Files.remove(tmpId); } catch (e) { Logger.log("temp cleanup failed: " + e.message); }
  }

  const res = UrlFetchApp.fetch(SUPABASE_RPC, {
    method: "post", contentType: "application/json",
    headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON },
    payload: JSON.stringify({ p_secret: PUSH_SECRET, p_csv: csv, p_row: t.row }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300)
    throw new Error("push failed (" + res.getResponseCode() + "): " + res.getContentText());

  Logger.log("Term " + t.term + " -> row " + t.row + ": " + csv.length + " chars");
}

/** drive.files.copy is intermittently flaky; retry rather than fail the whole run. */
function copyWithRetry_(fileId) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tmp = Drive.Files.copy(
        { title: TMP_PREFIX + Date.now(), name: TMP_PREFIX + Date.now(),
          mimeType: "application/vnd.google-apps.spreadsheet" },
        fileId
      );
      return tmp.id;
    } catch (e) {
      lastErr = e;
      Logger.log("copy attempt " + attempt + " failed: " + e.message);
      Utilities.sleep(attempt * 3000);       // 3s, 6s backoff
    }
  }
  throw new Error("drive copy failed after 3 attempts: " + lastErr.message);
}

/** Delete temp copies left behind by runs that timed out. */
function cleanupOrphans_() {
  try {
    const files = DriveApp.searchFiles('title contains "' + TMP_PREFIX + '" and trashed = false');
    let n = 0;
    while (files.hasNext() && n < 25) { files.next().setTrashed(true); n++; }
    if (n) Logger.log("cleaned up " + n + " orphaned temp file(s)");
  } catch (e) { Logger.log("orphan cleanup skipped: " + e.message); }
}

/* ---------------- strikethrough-aware read ---------------- */
/** Only cells that actually contain struck-through text are rebuilt;
    everything else (dates, plain classes, notes) passes through untouched. */
function cleanedDisplayValues_(sheet) {
  const rng = sheet.getDataRange();
  const plain = rng.getDisplayValues();
  const rich  = rng.getRichTextValues();
  const out = [];
  for (let r = 0; r < plain.length; r++) {
    const row = [];
    for (let c = 0; c < plain[r].length; c++) {
      let text = plain[r][c];
      try {
        const cell = rich[r] && rich[r][c];
        const runs = cell && cell.getRuns ? cell.getRuns() : null;
        const hasStrike = runs && runs.some(function (run) {
          const st = run.getTextStyle();
          return st && st.isStrikethrough();
        });
        if (hasStrike) {
          text = runs
            .filter(function (run) {
              const st = run.getTextStyle();
              return !(st && st.isStrikethrough());
            })
            .map(function (run) { return run.getText(); })
            .join("")
            .replace(/\s*\/\s*\/\s*/g, " / ")
            .replace(/^\s*\/\s*/, "")
            .replace(/\s*\/\s*$/, "")
            .replace(/[ \t]+/g, " ")
            .trim();
        }
      } catch (e) { /* fall back to the plain value */ }
      row.push(text);
    }
    out.push(row);
  }
  return out;
}

function toCSV_(vals) {
  return vals.map(function (r) {
    return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(",");
  }).join("\n");
}
