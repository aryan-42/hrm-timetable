// notify-changes
// ---------------------------------------------------------------------------
// Runs after the Apps Script auto-publishes a new version of the schedule.
// Diffs the published CSV against the one it replaced, works out which
// course/section pairs actually moved, and web-pushes only the students those
// changes affect.
//
// Idempotent on purpose: it processes every publish_log row that has not been
// notified yet and stamps notified_at as it goes, so a webhook retry, a cron
// tick and a manual invoke can all overlap without double-sending.
//
// The parsing below is a direct port of index.html — it must stay in step with
// it, or the diff will disagree with what students actually see.

import * as webpush from "jsr:@negrel/webpush@^0.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ---------- schedule parsing (ported from index.html) ---------- */

const TOKEN_RE = /^([A-Z]{2,8})_(?:([A-Za-z&]+?)_?)?(\d+)(?:_([A-Za-z&]+))?$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const SLOTS: Record<number, string> = {
  1: "8:00", 2: "9:45", 3: "11:30", 4: "1:50", 5: "2:30", 6: "4:15", 7: "6:00",
};

function parseCSV(t: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c !== "\r") cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function parseDate(s: string): Date | null {
  const m = (s || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (!m || !(m[2] in MONTHS)) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(y, MONTHS[m[2]], +m[1]));
}

// A course counts as section-split only when BOTH _A and _B forms appear.
// Otherwise a trailing letter group is faculty initials (DTHR_SB2), not a section.
function scanSplitCourses(text: string): Set<string> {
  const A: Record<string, 1> = {}, B: Record<string, 1> = {};
  for (const raw of text.split(/[\s,"\n/]+/)) {
    const m = raw.trim().replace(/^[/\s]+|[/.,\s]+$/g, "").match(TOKEN_RE);
    if (!m) continue;
    const c = m[1], mod = m[2];
    if (mod === "A") A[c] = 1;
    else if (mod === "B") B[c] = 1;
    else if (mod === "A&B") { A[c] = 1; B[c] = 1; }
  }
  return new Set(Object.keys(A).filter((c) => B[c]));
}

type Entry = { code: string; section: string | null; session: number };

function parseCell(cell: string, split: Set<string>): Entry[] {
  const out: Entry[] = [];
  for (const raw of (cell || "").split(/[\s\n/]+/)) {
    const tok = raw.trim().replace(/^[/\s]+|[/.,\s]+$/g, "");
    if (!tok) continue;
    const m = tok.match(TOKEN_RE);
    if (!m) continue;
    const code = m[1], mod = m[2] || null;
    let section: string | null = null;
    if (mod && (mod === "A" || mod === "B" || mod === "A&B") && split.has(code)) section = mod;
    out.push({ code, section, session: +m[3] });
  }
  return out;
}

type Snap = Record<string, { date: number; slot: number }>;

function snapshot(csv: string): Snap {
  const split = scanSplitCourses(csv);
  const rows = parseCSV(csv);
  const snap: Snap = {};
  for (const r of rows) {
    const dt = parseDate(r[0]);
    if (!dt) continue;
    const first = (r[2] || "").trim();
    // a whole-day holiday/exam banner occupies the first slot and parses to nothing
    if (first && !parseCell(first, split).length && !/^reserve$/i.test(first)) continue;
    for (const [ci, slot] of [[2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7]] as const) {
      const cell = (r[ci] || "").trim();
      if (!cell || /^reserve$/i.test(cell)) continue;
      for (const e of parseCell(cell, split)) {
        snap[`${e.code}|${e.section || ""}|${e.session}`] = { date: dt.getTime(), slot };
      }
    }
  }
  return snap;
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
const fmtSlot = (s: number) => SLOTS[s] ?? "?";

type Change = { course: string; section: string | null; text: string };

function diff(before: string, after: string): Change[] {
  const o = snapshot(before), n = snapshot(after);
  const out: Change[] = [];
  for (const k of Object.keys(n)) {
    const [course, section, sess] = k.split("|");
    const label = `${course} S${sess}`;
    if (!(k in o)) {
      out.push({ course, section: section || null,
        text: `Added: ${label} · ${fmtDate(n[k].date)} ${fmtSlot(n[k].slot)}` });
    } else if (o[k].date !== n[k].date || o[k].slot !== n[k].slot) {
      out.push({ course, section: section || null,
        text: `${label}: ${fmtDate(o[k].date)} ${fmtSlot(o[k].slot)} → ${fmtDate(n[k].date)} ${fmtSlot(n[k].slot)}` });
    }
  }
  for (const k of Object.keys(o)) {
    if (k in n) continue;
    const [course, section, sess] = k.split("|");
    out.push({ course, section: section || null,
      text: `Cancelled: ${course} S${sess} · was ${fmtDate(o[k].date)}` });
  }
  return out;
}

/* ---------- delivery ---------- */

const ROW_TO_TERM: Record<number, number> = { 1: 4, 5: 5 };

// Public half of the VAPID pair — identical to VAPID_PUBLIC in index.html.
const VAPID_PUBLIC =
  "BHOkwPZXBzEd6uqY9B8NU6sy47UIIFaOYa4sGgFkBG9sd6xqQ7RycXJLDFz_e-C6-AZqqONaeZFF4B0n7IVRx-s";

function b64uToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...bin].map((c) => c.charCodeAt(0)));
}
function bytesToB64u(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async () => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // The secret is just the 43-char private scalar (d), not a JSON blob —
  // pasting JSON into a dashboard field is too easy to truncate, and an
  // earlier attempt did exactly that. x and y are recovered from the public
  // key below, which is not secret and ships in index.html.
  const d = (Deno.env.get("VAPID_PRIVATE") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(d)) {
    return json({
      error: "VAPID_PRIVATE is missing or malformed",
      hint: "Expected the 43-character base64url private key on its own — no quotes, braces or JSON.",
      got: { length: d.length },
    }, 500);
  }

  const pubBytes = b64uToBytes(VAPID_PUBLIC);
  if (pubBytes.length !== 65 || pubBytes[0] !== 4) {
    return json({ error: "VAPID_PUBLIC is not an uncompressed P-256 point" }, 500);
  }
  const x = bytesToB64u(pubBytes.slice(1, 33));
  const y = bytesToB64u(pubBytes.slice(33, 65));

  let vapidKeys;
  try {
    vapidKeys = await webpush.importVapidKeys({
      publicKey:  { kty: "EC", crv: "P-256", x, y, key_ops: ["verify"], ext: true },
      privateKey: { kty: "EC", crv: "P-256", x, y, d, key_ops: ["sign"], ext: true },
    }, { extractable: false });
  } catch (e) {
    return json({ error: "VAPID keys could not be imported", detail: String(e) }, 500);
  }
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: "mailto:" + (Deno.env.get("CONTACT_EMAIL") ?? "aryn.snh@gmail.com"),
    vapidKeys,
  });

  const { data: pending, error } = await supa
    .from("publish_log")
    .select("id, term, mode, csv_before, csv_after")
    // Any row carrying both CSVs is a real publish, whether it went live
    // automatically or an approver released it. Held rows store no CSVs, so
    // they are excluded by the two not-null filters below rather than by mode.
    .is("notified_at", null)
    .not("csv_before", "is", null)
    .not("csv_after", "is", null)
    .order("id", { ascending: true })
    .limit(10);

  if (error) return json({ error: error.message }, 500);
  if (!pending?.length) return json({ processed: 0, note: "nothing pending" });

  const report: unknown[] = [];

  for (const row of pending) {
    const changes = diff(row.csv_before!, row.csv_after!);

    // Nothing a student would notice (whitespace, a header tweak) — close it out.
    if (!changes.length) {
      await supa.from("publish_log").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
      report.push({ log: row.id, changes: 0, sent: 0 });
      continue;
    }

    const term = ROW_TO_TERM[row.term] ?? row.term;
    const courses = [...new Set(changes.map((c) => c.course))];

    const { data: enrolled } = await supa
      .from("enrollment_terms")
      .select("roll, courses")
      .eq("term", term)
      .overlaps("courses", courses);

    const { data: sections } = await supa.from("enrollment").select("roll, section");
    const sectionOf = new Map((sections ?? []).map((s) => [s.roll, s.section]));

    // roll -> the change lines that student actually cares about
    const perStudent = new Map<string, string[]>();
    for (const st of enrolled ?? []) {
      const sec = sectionOf.get(st.roll) ?? null;
      const mine = changes.filter((c) =>
        st.courses.includes(c.course) &&
        (!c.section || c.section === "A&B" || c.section === sec)
      );
      if (mine.length) perStudent.set(st.roll, mine.map((m) => m.text));
    }

    let sent = 0, gone = 0, failed = 0;
    if (perStudent.size) {
      const { data: subs } = await supa
        .from("push_subscriptions")
        .select("endpoint, roll, p256dh, auth")
        .in("roll", [...perStudent.keys()]);

      for (const sub of subs ?? []) {
        const lines = perStudent.get(sub.roll)!;
        const payload = {
          title: lines.length === 1 ? "Timetable change" : `${lines.length} timetable changes`,
          body: lines.slice(0, 3).join("\n") + (lines.length > 3 ? `\n+${lines.length - 3} more` : ""),
          url: "/",
        };
        try {
          const subscriber = appServer.subscribe({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          });
          await subscriber.pushTextMessage(JSON.stringify(payload), {});
          sent++;
          await supa.from("push_subscriptions")
            .update({ last_ok_at: new Date().toISOString(), fail_count: 0 })
            .eq("endpoint", sub.endpoint);
        } catch (e) {
          const msg = String(e);
          // 404/410 mean the browser threw the subscription away — drop the row.
          if (msg.includes("404") || msg.includes("410")) {
            gone++;
            await supa.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          } else {
            failed++;
            console.error("push failed", sub.endpoint.slice(-12), msg);
          }
        }
      }
    }

    await supa.from("publish_log").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
    report.push({ log: row.id, term, mode: row.mode, changes: changes.length, students: perStudent.size, sent, gone, failed });
  }

  return json({ processed: pending.length, report });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
