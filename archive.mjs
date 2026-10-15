#!/usr/bin/env node
//
// Adds every match Bouncer has seen to the forever archive: the public site the app reads once a
// match's rows have left Appwrite (`.claude/rules/archive-data.md`).
//
// USAGE
//   APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node archive.mjs <siteDir>
//
// `siteDir` is a checkout of the site (the `gh-pages` branch), updated in place: unlike the
// Cricsheet site, the archive is never rebuilt, because its source is pruned from Appwrite.
//
// Each run reads the commentary rows written since the last one (a `$createdAt` watermark in
// `state.json`), adds them to their match files, and finalises the matches that have ended and
// settled. The first run, with no watermark, takes everything still in the table.

import fs from "node:fs";
import path from "node:path";
import { appwrite } from "./src/appwrite.js";
import {
  MATCH_ID,
  SCHEMA_VERSION,
  SETTLE_MS,
  SIZE_LIMIT_BYTES,
  archivedRow,
  countSince,
  cycleOf,
  indexRow,
  isSettled,
  isTerminal,
  mergeIndex,
  mergeRows,
  monthOf,
  parsedColumn,
  yearsOf,
} from "./src/archive.js";

// Rows written in the same instant as the watermark, or committed a moment out of order, are read
// again rather than missed; a re-read row is merged by id.
const WATERMARK_OVERLAP_MS = 5 * 60_000;
// One run's ceiling. A backlog bigger than this (the first run) carries over to the next.
const MAX_ROWS = Number(process.env.ARCHIVE_MAX_ROWS ?? 60_000);
// How long a match-list entry is remembered: past a Test, its rest days and the 4-day stale rule.
const SEEN_TTL_MS = 30 * 86_400_000;

const siteDir = process.argv[2];
const { APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY } = process.env;
if (!siteDir || !APPWRITE_ENDPOINT || !APPWRITE_PROJECT_ID || !APPWRITE_API_KEY) {
  console.error("usage: APPWRITE_ENDPOINT=… APPWRITE_PROJECT_ID=… APPWRITE_API_KEY=… node archive.mjs <siteDir>");
  process.exit(1);
}

const root = path.resolve(siteDir);
fs.mkdirSync(root, { recursive: true });
function fileFor(rel) {
  const file = path.resolve(root, rel);
  // Every path is built from a match id or a month, both checked; this is the backstop.
  if (!file.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}: ${rel}`);
  return file;
}
function readJson(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(rel), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
function writeJson(rel, value) {
  const file = fileFor(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
const matchPath = (id) => {
  if (!MATCH_ID.test(id)) throw new Error(`not a match id: ${id}`);
  return `m/${id}.json`;
};

const now = Date.now();
const db = appwrite({ endpoint: APPWRITE_ENDPOINT, project: APPWRITE_PROJECT_ID, key: APPWRITE_API_KEY });
const state = readJson("state.json", { v: SCHEMA_VERSION, watermark: null, pending: {} });

// 1. The match lists: who each match is, and which have finished. A match's entry is remembered
// from the first list it appears on (upcoming, usually), because the recent list holds 20 matches
// and a finished one can leave it before it is finalised.
const listed = new Map();
const ended = new Set();
for (const name of ["upcoming-matches", "live-matches", "recent-matches"]) {
  const file = await db.file(name);
  for (const m of file?.data?.matches ?? []) {
    const id = String(m?.id ?? "");
    if (!MATCH_ID.test(id)) continue;
    listed.set(id, m);
    if (name === "recent-matches" && (isTerminal(m.state) || isTerminal(m.status))) ended.add(id);
  }
}
state.seen ??= {};
for (const [id, meta] of listed) state.seen[id] = { meta, atMs: now };
for (const [id, { atMs }] of Object.entries(state.seen)) if (now - atMs > SEEN_TTL_MS) delete state.seen[id];

// 2. Commentary rows since the watermark, added to their match files.
const queries = [{ method: "orderAsc", attribute: "$createdAt" }];
if (state.watermark) {
  const from = new Date(Date.parse(state.watermark) - WATERMARK_OVERLAP_MS).toISOString();
  queries.unshift({ method: "greaterThanEqual", attribute: "$createdAt", values: [from] });
}
const incoming = new Map();
let read = 0;
let skipped = 0;
let watermark = state.watermark;
for await (const row of db.rows("match-commentary", queries, { max: MAX_ROWS })) {
  read++;
  if (!watermark || row.$createdAt > watermark) watermark = row.$createdAt;
  const id = String(row.match_id ?? "");
  const kept = MATCH_ID.test(id) ? archivedRow(row) : null;
  if (!kept) {
    skipped++;
    continue;
  }
  const entry = incoming.get(id) ?? { rows: [], lastMs: 0 };
  entry.rows.push(kept);
  entry.lastMs = Math.max(entry.lastMs, Date.parse(row.$createdAt));
  incoming.set(id, entry);
}

// A run that stopped at its ceiling has not seen every match's newest rows, so nothing is quiet yet.
const drained = read < MAX_ROWS;

// This billing cycle's commentary rows, which the end-of-cycle prune turns into a write estimate.
// Counted from the site itself when a cycle starts (or the count is new), then from each row a run
// adds. Rows the site already holds are not counted twice: a re-read row merges into its own id.
const cycle = cycleOf(now);
if (state.cycle?.start !== cycle.start) {
  let rows = 0;
  const dir = fileFor("m/x").replace(/x$/, "");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (f.endsWith(".json")) rows += countSince(readJson(`m/${f}`, { rows: [] }).rows, cycle.start);
  }
  state.cycle = { start: cycle.start, rows };
}

let added = 0;
for (const [id, { rows, lastMs }] of incoming) {
  const file = readJson(matchPath(id), { v: SCHEMA_VERSION, id, final: false, rows: [] });
  const before = file.rows.length;
  const known = new Set(file.rows.map((r) => r.id));
  state.cycle.rows += countSince(rows.filter((r) => !known.has(r.id)), cycle.start);
  file.rows = mergeRows(file.rows, rows);
  added += file.rows.length - before;
  writeJson(matchPath(id), file);
  if (file.final) continue;
  const p = (state.pending[id] ??= { lastRowMs: null, endedSeenMs: null, meta: null });
  p.lastRowMs = Math.max(p.lastRowMs ?? 0, lastMs);
}

// 3. Which pending matches have ended.
for (const id of ended) {
  if (readJson(matchPath(id), null)?.final) continue;
  const p = (state.pending[id] ??= { lastRowMs: null, endedSeenMs: null, meta: null });
  p.endedSeenMs ??= now;
}
for (const [id, p] of Object.entries(state.pending)) {
  p.meta = state.seen[id]?.meta ?? p.meta;
  // Fell off the recent list between runs: its own detail row says whether it is over. One read,
  // and only once its rows have gone quiet.
  if (drained && p.endedSeenMs == null && p.lastRowMs != null && now - p.lastRowMs >= SETTLE_MS) {
    const detail = parsedColumn((await db.getRow("match-live-detail", id))?.payload);
    if (isTerminal(detail?.status)) p.endedSeenMs = p.lastRowMs;
  }
}

// 4. Finalise: the rest of the match, then the index.
const months = {};
const monthFile = (month) => (months[month] ??= readJson(`idx/m/${month}.json`, []));
let finalised = 0;
for (const [id, p] of Object.entries(state.pending)) {
  if (!drained || !isSettled(p, now)) continue;
  const [detailRow, scorecardRow, context, evalLog] = await Promise.all([
    db.getRow("match-live-detail", id),
    db.getRow("match-scorecard", id),
    db.file(`mc-${id}`),
    db.file(`wpe-${id}`),
  ]);
  const detail = parsedColumn(detailRow?.payload);
  const file = readJson(matchPath(id), { v: SCHEMA_VERSION, id, final: false, rows: [] });
  Object.assign(file, {
    final: true,
    finalisedAt: new Date(now).toISOString(),
    meta: p.meta ?? null,
    detail: detail ?? null,
    scorecard: parsedColumn(scorecardRow?.scorecard),
    context: context ?? null,
    evalLog: evalLog ?? null,
  });
  if (!p.meta && !context) file.partial = 1;
  writeJson(matchPath(id), file);
  const row = indexRow(id, { meta: p.meta, context, detail, firstRowMs: file.rows[0]?.sort_key ?? null });
  const month = monthOf(row);
  months[month] = mergeIndex(monthFile(month), [row]);
  delete state.pending[id];
  finalised++;
}
for (const [month, rows] of Object.entries(months)) writeJson(`idx/m/${month}.json`, rows);

// 5. The site's own files, then the size guard.
state.watermark = watermark;
writeJson("state.json", state);
const allMonths = {};
const idxDir = fileFor("idx/m/x").replace(/x$/, "");
for (const f of fs.existsSync(idxDir) ? fs.readdirSync(idxDir) : []) {
  if (f.endsWith(".json")) allMonths[f.slice(0, -5)] = readJson(`idx/m/${f}`, []);
}
writeJson("idx/years.json", yearsOf(allMonths));

let bytes = 0;
let files = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      bytes += fs.statSync(p).size;
      files++;
    }
  }
})(root);
const matches = Object.values(allMonths).reduce((n, rows) => n + rows.length, 0);
// `watermark` and `cycle` are read by bouncer-api's end-of-cycle prune: it deletes only rows the
// archive has (created before the watermark, of a final match) and sizes itself from the count.
writeJson("manifest.json", {
  v: SCHEMA_VERSION,
  updated: new Date(now).toISOString(),
  matches,
  files,
  bytes,
  watermark,
  cycle: { start: cycle.start, end: cycle.end, commentaryRows: state.cycle.rows },
});
fs.writeFileSync(fileFor(".nojekyll"), "");
fs.writeFileSync(
  fileFor("README.md"),
  `# Bouncer match archive

Every match the Bouncer app has followed: its ball-by-ball commentary (written by Bouncer: rewritten
or generated from each delivery's facts, never a copy of another site's text), the final scorecard,
the match context and summary, and the win-probability log. Read by the app once a match's rows have
left its live database. Updated every three hours.

- \`idx/years.json\`: \`{year: {month: count}}\`
- \`idx/m/YYYY-MM.json\`: \`[id, date, format, gender, team1, team2, result, series, venue]\`, newest first
- \`m/<id>.json\`: one match; \`final\` once it has ended and settled
`
);

console.log(
  `read ${read} rows (${skipped} not archived), ${added} new across ${incoming.size} matches; ` +
    `finalised ${finalised}${drained ? "" : " (backlog not drained: finalising waits)"}; ${Object.keys(state.pending).length} pending; ` +
    `${matches} archived, ${files} files, ${(bytes / 1048576).toFixed(1)} MB; ` +
    `${state.cycle.rows} commentary rows this cycle (from ${cycle.start})`
);
if (bytes > SIZE_LIMIT_BYTES) {
  // GitHub Pages refuses a site over 1 GB. Publishing stops here; the next site is a new repo.
  console.error(`site is ${(bytes / 1048576).toFixed(0)} MB, over the ${SIZE_LIMIT_BYTES / 1048576} MB limit`);
  process.exit(1);
}
