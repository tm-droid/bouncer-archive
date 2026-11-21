// The archive's rules, pure so they can be tested without Appwrite or a disk.
//
// One file per match, `m/<cricbuzzId>.json`, grows as its commentary rows are written and is
// marked `final` once the match has ended and settled. Then its detail row, scorecard, `mc-` context
// and `wpe-` evaluation log are added, and it joins the month's index. Rows that arrive for a match
// after that (a held delivery the rewrite backlog drained late) are still added.

import { classifyStatus } from "./matchstate.js";

export const SCHEMA_VERSION = 1;
export const SIZE_LIMIT_BYTES = 900 * 1024 * 1024;

// A finished match still gets rows: the rewrite backlog drains held deliveries, and the finalising
// run writes the summary and the `wpe-` log. Six hours covers both.
export const SETTLE_MS = 6 * 3_600_000;
// A match whose rows stopped and that no list or detail row ever called finished (it fell off the
// 20-row recent list between runs, or was abandoned). A Test's overnight gap is ~16 h and a rest
// day is 24 h, so four days is past any live match. It must stay well under the 14-day prune.
export const STALE_MS = 4 * 86_400_000;

export const MATCH_ID = /^\d{1,12}$/;

// Appwrite's billing cycle, which no API key can read (`.claude/rules/archive-data.md`). Read from
// the Console on 2026-10-14: `billingCurrentInvoiceDate` 2026-10-14T00:00Z, `billingNextInvoiceDate`
// 2026-11-13T00:00Z, a 30-day period from the switch to Free. Check it against the Console when a
// cycle ends: the end-of-cycle prune spends what it believes is left of this window.
export const CYCLE_ANCHOR_MS = Date.UTC(2026, 9, 14);
export const CYCLE_DAYS = 30;

/** The billing cycle holding `ms`: `{start, end}` as ISO strings. */
export function cycleOf(ms) {
  const length = CYCLE_DAYS * 86_400_000;
  const start = CYCLE_ANCHOR_MS + Math.floor((ms - CYCLE_ANCHOR_MS) / length) * length;
  return { start: new Date(start).toISOString(), end: new Date(start + length).toISOString() };
}

/**
 * How many of `rows` were created at or after `startIso`: commentary rows are created by one write
 * each, so this counts that share of the cycle's writes.
 */
export const countSince = (rows, startIso) => rows.filter((r) => (r.created_at ?? "") >= startIso).length;

// The columns kept from a `match-commentary` row, under their table names, so the app maps an
// archived row with the same function as a live one.
const ROW_FIELDS = ["innings", "ball", "sort_key", "commentary", "ai_generated", "event", "runs", "extra", "provider", "created_at"];

/**
 * A commentary row as archived, or null for one that must not be published.
 *
 * A `provider` of `cricbuzz` or `cricbuzz:<reason>` is a row that holds Cricbuzz's own text,
 * unrewritten (`commentaryOrigin` in match-sync). None has been written since 2026-09-27, but the
 * table still held older ones, and the archive is public.
 */
export function archivedRow(row) {
  if (!row || typeof row.commentary !== "string" || !row.commentary.trim()) return null;
  if (String(row.provider ?? "").startsWith("cricbuzz")) return null;
  const out = { id: rowKey(row.$id) };
  for (const f of ROW_FIELDS) if (row[f] !== undefined && row[f] !== null) out[f] = row[f];
  return out;
}

// An archived row's id: the first 16 characters of its Appwrite id. A full id is 36 hex
// characters, and about 0.3% of them fit GitHub's "Databricks token" pattern (`d`, three of a-f, 32
// hex). Push protection then refused every `gh-pages` push from 2026-11-04 to 2026-11-21. Each
// failed run re-read every row since, about 25k rows a run. Sixteen characters fit no 32-hex token
// pattern and are still unique within a match. The app never reads the id.
export const ROW_KEY_LENGTH = 16;
export const rowKey = (id) => String(id ?? "").slice(0, ROW_KEY_LENGTH);

/**
 * Rows merged by id, in feed order (`sort_key`, then id so the order is stable). Ids are reduced
 * to `rowKey` on both sides, so a file archived with full ids is rewritten without them, and a
 * re-read row merges into its old full-id copy.
 */
export function mergeRows(existing, incoming) {
  const byId = new Map();
  for (const r of [...existing, ...incoming]) {
    const id = rowKey(r.id);
    byId.set(id, { ...r, id });
  }
  return [...byId.values()].sort((a, b) => (a.sort_key ?? 0) - (b.sort_key ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A run refuses to read Appwrite when the site's last publish is older than this. The site holds
// the read watermark, so a run whose push fails re-reads everything since the last good push.
// Twelve hours allows about four runs of that before the job fails cheaply, still emailing the
// owner. A deliberate catch-up (`ARCHIVE_CATCH_UP=1`, the workflow's `catch_up` input) skips the
// check.
export const STALE_PUBLISH_MS = 12 * 3_600_000;

/** Why a run must not read, or null when it may: `manifest` is the site's, null on a new site. */
export function stalePublish(manifest, now, catchUp) {
  if (catchUp || !manifest?.updated) return null;
  const age = now - Date.parse(manifest.updated);
  if (!(age > STALE_PUBLISH_MS)) return null;
  return (
    `last publish ${manifest.updated} is ${(age / 3_600_000).toFixed(1)} h old: earlier pushes failed, ` +
    `and reading now would re-read every row since. Fix the publish, then run the workflow with catch_up.`
  );
}

export const isTerminal = (status) => classifyStatus(status) === "TERMINAL";

/**
 * Whether a pending match is finished and settled.
 *
 * `lastRowMs` is its newest commentary row (null for a match with none), `endedSeenMs` when a list
 * or detail row first called it finished (null if none has).
 */
export function isSettled({ lastRowMs, endedSeenMs }, now) {
  const quietFor = lastRowMs == null ? Infinity : now - lastRowMs;
  if (endedSeenMs != null) return quietFor >= SETTLE_MS && now - endedSeenMs >= SETTLE_MS;
  return lastRowMs != null && quietFor >= STALE_MS;
}

const isoDate = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);

/**
 * The month index row: `[id, date, format, gender, team1, team2, result, series, venue]`.
 *
 * `meta` is the match's entry from a match list (absent when it was never seen on one), `context`
 * its `mc-` file, `detail` its live payload. Each field takes the first source that has it. With
 * none of the first two, the date is the first delivery's (`firstRowMs`).
 */
export function indexRow(id, { meta, context, detail, firstRowMs = null }) {
  const teams = meta?.teams?.map((t) => t?.name) ?? context?.teams?.map((t) => t?.name) ?? [detail?.team1Name, detail?.team2Name];
  return [
    id,
    isoDate(Number(meta?.startDate)) ?? isoDate(Number(context?.startMs)) ?? isoDate(firstRowMs),
    meta?.matchFormat ?? context?.format ?? null,
    context?.gender ?? null,
    teams[0] ?? null,
    teams[1] ?? null,
    meta?.status ?? detail?.status ?? null,
    meta?.seriesName ?? null,
    context?.venue?.name ?? null,
  ];
}

export const monthOf = (row) => (row[1] ? row[1].slice(0, 7) : "unknown");

/** Index rows merged by id, newest first. */
export function mergeIndex(existing, rows) {
  const byId = new Map(existing.map((r) => [r[0], r]));
  for (const r of rows) byId.set(r[0], r);
  return [...byId.values()].sort((a, b) => String(b[1] ?? "").localeCompare(String(a[1] ?? "")) || String(b[0]).localeCompare(String(a[0])));
}

/** `{year: {month: count}}` over every month file. */
export function yearsOf(months) {
  const years = {};
  for (const [month, rows] of Object.entries(months)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const [y, m] = month.split("-");
    (years[y] ??= {})[m] = rows.length;
  }
  return years;
}

/** A JSON column that should hold JSON; the parsed value, or the string when it does not parse. */
export function parsedColumn(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
