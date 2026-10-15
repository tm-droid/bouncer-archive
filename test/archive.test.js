import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SETTLE_MS,
  STALE_MS,
  archivedRow,
  countSince,
  cycleOf,
  indexRow,
  isSettled,
  mergeIndex,
  mergeRows,
  monthOf,
  yearsOf,
} from "../src/archive.js";
import { appwrite } from "../src/appwrite.js";

const row = (id, sortKey, extra = {}) => ({
  $id: id,
  $createdAt: "2026-10-13T13:03:15.734+00:00",
  match_id: "170697",
  innings: 1,
  ball: "0.1",
  sort_key: sortKey,
  commentary: "Fernando to Farhan, no run",
  ai_generated: false,
  event: "NONE",
  runs: 0,
  extra: null,
  provider: "template",
  created_at: "2026-10-13T13:03:15.684Z",
  ...extra,
});

test("an archived row keeps the table's column names and drops Appwrite's own fields", () => {
  const out = archivedRow(row("a", 1));
  assert.deepEqual(Object.keys(out).sort(), ["ai_generated", "ball", "commentary", "created_at", "event", "id", "innings", "provider", "runs", "sort_key"]);
  assert.equal(out.id, "a");
});

test("a row holding Cricbuzz's own text is never archived: the site is public", () => {
  assert.equal(archivedRow(row("a", 1, { provider: "cricbuzz" })), null);
  assert.equal(archivedRow(row("a", 1, { provider: "cricbuzz:verification_failed" })), null);
  assert.notEqual(archivedRow(row("a", 1, { provider: "gemini-flash-lite-2+cricinfo" })), null);
  assert.equal(archivedRow(row("a", 1, { commentary: "  " })), null);
});

test("rows merge by id and come out in sort_key order", () => {
  const merged = mergeRows([archivedRow(row("b", 2))], [archivedRow(row("a", 1)), archivedRow(row("b", 2, { commentary: "newer" }))]);
  assert.deepEqual(merged.map((r) => r.id), ["a", "b"]);
  assert.equal(merged[1].commentary, "newer");
});

test("a finished match waits until its rows have been quiet for the settle time", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(isSettled({ lastRowMs: now - SETTLE_MS + 1, endedSeenMs: now - SETTLE_MS }, now), false);
  assert.equal(isSettled({ lastRowMs: now - SETTLE_MS, endedSeenMs: now - SETTLE_MS }, now), true);
  // Seen finished just now: the finalising run's summary and wpe- log may not be written yet.
  assert.equal(isSettled({ lastRowMs: now - SETTLE_MS * 2, endedSeenMs: now }, now), false);
  // A finished match with no commentary at all.
  assert.equal(isSettled({ lastRowMs: null, endedSeenMs: now - SETTLE_MS }, now), true);
});

test("a match nothing called finished is final only once its rows stop for days, not overnight", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  assert.equal(isSettled({ lastRowMs: now - 16 * 3_600_000, endedSeenMs: null }, now), false);
  assert.equal(isSettled({ lastRowMs: now - STALE_MS, endedSeenMs: null }, now), true);
  assert.equal(isSettled({ lastRowMs: null, endedSeenMs: null }, now), false);
  // Well inside the 14-day prune, which is what deletes the rows.
  assert.ok(STALE_MS + SETTLE_MS < 14 * 86_400_000 / 2);
});

test("the index row takes each field from the list entry first, then the context, then the detail", () => {
  const meta = {
    id: "170697", status: "Sri Lanka won by 8 wkts", state: "Complete", matchFormat: "T20",
    seriesName: "Sri Lanka tour of Pakistan, 2026", startDate: "1791896400000",
    teams: [{ name: "Pakistan" }, { name: "Sri Lanka" }],
  };
  const context = { gender: "male", venue: { name: "Rawalpindi Cricket Stadium" }, format: "T20", startMs: 1791896400000 };
  const r = indexRow("170697", { meta, context, detail: null });
  assert.deepEqual(r, ["170697", "2026-10-13", "T20", "male", "Pakistan", "Sri Lanka", "Sri Lanka won by 8 wkts", "Sri Lanka tour of Pakistan, 2026", "Rawalpindi Cricket Stadium"]);
  assert.equal(monthOf(r), "2026-10");

  const partial = indexRow("1", { meta: null, context: null, detail: { team1Name: "PAK", team2Name: "SL", status: "Sri Lanka won" } });
  assert.deepEqual(partial, ["1", null, null, null, "PAK", "SL", "Sri Lanka won", null, null]);
  assert.equal(monthOf(partial), "unknown");
  assert.equal(indexRow("1", { meta: null, context: null, detail: null, firstRowMs: 1790741167558 })[1], "2026-09-30");
});

test("the month index merges by id, newest first, and years count each month", () => {
  const rows = mergeIndex([["1", "2026-10-01"], ["2", "2026-10-03"]], [["1", "2026-10-02"], ["3", "2026-10-05"]]);
  assert.deepEqual(rows.map((r) => r[0]), ["3", "2", "1"]);
  assert.equal(rows.find((r) => r[0] === "1")[1], "2026-10-02");
  assert.deepEqual(yearsOf({ "2026-10": rows, "2026-09": [["4"]], unknown: [["5"]] }), { 2026: { 10: 3, "09": 1 } });
});

test("rows are read by cursor until a short page", async () => {
  const calls = [];
  const pages = [Array.from({ length: 1000 }, (_, i) => ({ $id: `r${i}` })), [{ $id: "last" }]];
  const fetchFn = async (url) => {
    calls.push(decodeURIComponent(url));
    return { ok: true, status: 200, json: async () => ({ rows: pages[calls.length - 1] }) };
  };
  const db = appwrite({ endpoint: "https://x/v1", project: "p", key: "k", fetchFn });
  const ids = [];
  for await (const r of db.rows("match-commentary", [{ method: "orderAsc", attribute: "$createdAt" }])) ids.push(r.$id);
  assert.equal(ids.length, 1001);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /"cursorAfter","values":\["r999"\]/);
});

test("a missing row or file is null, any other failure throws", async () => {
  const db404 = appwrite({ endpoint: "https://x/v1", project: "p", key: "k", fetchFn: async () => ({ ok: false, status: 404 }) });
  assert.equal(await db404.getRow("match-scorecard", "1"), null);
  const db500 = appwrite({ endpoint: "https://x/v1", project: "p", key: "k", fetchFn: async () => ({ ok: false, status: 500, text: async () => "boom" }) });
  await assert.rejects(db500.file("mc-1"), /HTTP 500/);
});

// The classifier is a copy of match-sync's, because this tool also runs from the public repo,
// where match-sync is not. In this repo the two must be identical.
test("the vendored match-state classifier is match-sync's, byte for byte", (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const original = path.resolve(here, "../../../functions/match-sync/src/matchstate.js");
  if (!fs.existsSync(original)) return t.skip("match-sync is not beside this copy (the public repo)");
  assert.equal(fs.readFileSync(path.resolve(here, "../src/matchstate.js"), "utf8"), fs.readFileSync(original, "utf8"));
});

test("the billing cycle is the Console's 30-day period from 2026-10-14", () => {
  assert.deepEqual(cycleOf(Date.parse("2026-10-15T01:00:00Z")), { start: "2026-10-14T00:00:00.000Z", end: "2026-11-13T00:00:00.000Z" });
  // The instant the Console's next invoice date arrives belongs to the next cycle.
  assert.equal(cycleOf(Date.parse("2026-11-13T00:00:00Z")).start, "2026-11-13T00:00:00.000Z");
  assert.equal(cycleOf(Date.parse("2026-11-12T23:59:59Z")).start, "2026-10-14T00:00:00.000Z");
});

test("a cycle counts only rows created inside it", () => {
  const rows = [{ created_at: "2026-10-13T23:59:59.999Z" }, { created_at: "2026-10-14T00:00:00.000Z" }, { created_at: "2026-10-20T10:00:00Z" }, {}];
  assert.equal(countSince(rows, "2026-10-14T00:00:00.000Z"), 2);
});
