/**
 * XIM TERM-IV TIMETABLE — STAGING PUSH BRIDGE (v5.1)
 * Runs on YOUR COLLEGE ACCOUNT. Reads the official schedule, strips
 * struck-through (cancelled) text, and pushes to a STAGING row in Supabase.
 * Nothing reaches students until an approver taps "Publish" in the app.
 *
 * SETUP (~5 min):
 * 1. script.google.com (college account) → New project → paste this file
 * 2. Left sidebar → Services (+) → add "Drive API" (identifier: Drive)
 * 3. Run ▶ pushStaging once → authorize → log should say "✓ pushed to staging"
 * 4. Triggers (clock icon) → Add: pushStaging · Time-driven · Hourly
 *
 * Flow: college edits sheet → hourly push to STAGING → approver reviews the
 * diff in the app and publishes → students see the new version.
 */

const SOURCE_FILE_ID = "1o766BFepifra3xqzfin-6neuo4HBNRy6";
const SUPABASE_RPC  = "https://atfkuxvjrypsdxxmsmnm.supabase.co/rest/v1/rpc/push_staging";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0Zmt1eHZqcnlwc2R4eG1zbW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDExMDUsImV4cCI6MjA5NjY3NzEwNX0.SNFiiI3qKxxPiUwMh2Vb_ksMcdKp4x7GZEg-zUXctvk";
// The push secret is NOT stored in this repo. Set it once per Apps Script project:
//   Project Settings -> Script Properties -> add key "PUSH_SECRET" with your secret value.
const PUSH_SECRET = PropertiesService.getScriptProperties().getProperty("PUSH_SECRET");

/* read official xlsx as a temp Google Sheet, return the first sheet object + temp id */
function openSource_() {
  const tmp = Drive.Files.copy(
    { title: "tt-tmp", name: "tt-tmp", mimeType: "application/vnd.google-apps.spreadsheet" },
    SOURCE_FILE_ID
  );
  return { sheet: SpreadsheetApp.openById(tmp.id).getSheets()[0], tmpId: tmp.id };
}

/* Build cleaned values: ONLY touch cells that actually contain struck-through
   text. Every other cell (dates, plain classes, notes) is passed through with
   its exact display value, untouched. This guarantees we never damage good data
   while removing cancelled classes.
   "LSS_A10 / [strike]OSD_B8[/strike] / INRS_B19" -> "LSS_A10 / INRS_B19" */
function cleanedDisplayValues_(sheet) {
  const rng = sheet.getDataRange();
  const rich = rng.getRichTextValues();
  const plain = rng.getDisplayValues();   // authoritative text, incl. formatted dates
  const out = [];
  for (let r = 0; r < plain.length; r++) {
    const row = [];
    for (let c = 0; c < plain[r].length; c++) {
      const display = plain[r][c];        // default: use the display value as-is
      let text = display;
      try {
        const cell = rich[r] && rich[r][c];
        const runs = cell && cell.getRuns ? cell.getRuns() : null;
        // Does this cell contain ANY struck-through run? If not, leave it alone.
        const hasStrike = runs && runs.some(run => {
          const st = run.getTextStyle();
          return st && st.isStrikethrough();
        });
        if (hasStrike) {
          // Only now do we rebuild the cell from its non-struck runs.
          const kept = runs
            .filter(run => {
              const st = run.getTextStyle();
              return !(st && st.isStrikethrough());
            })
            .map(run => run.getText())
            .join("");
          text = kept
            .replace(/\s*\/\s*\/\s*/g, " / ")  // collapse " /  / " left by a removed middle item
            .replace(/^\s*\/\s*/, "")           // drop a leading "/ " left by a removed first item
            .replace(/\s*\/\s*$/, "")           // drop a trailing " /" left by a removed last item
            .replace(/[ \t]+/g, " ")
            .trim();
        }
      } catch (e) { text = display; }     // any hiccup -> safe original value
      row.push(text);
    }
    out.push(row);
  }
  return out;
}

function toCSV_(vals) {
  return vals.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
}

function pushStaging() {
  if (!PUSH_SECRET) throw new Error(
    'PUSH_SECRET not set. Project Settings -> Script Properties -> add key "PUSH_SECRET".');
  const { sheet, tmpId } = openSource_();
  let csv;
  try {
    csv = toCSV_(cleanedDisplayValues_(sheet));
  } finally {
    Drive.Files.remove(tmpId);
  }
  const res = UrlFetchApp.fetch(SUPABASE_RPC, {
    method: "post", contentType: "application/json",
    headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON },
    payload: JSON.stringify({ p_secret: PUSH_SECRET, p_csv: csv }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300)
    throw new Error("Push failed (" + res.getResponseCode() + "): " + res.getContentText());
  Logger.log("✓ pushed to staging — " + csv.length + " chars at " + new Date());
}
