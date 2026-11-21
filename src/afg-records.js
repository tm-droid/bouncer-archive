/**
 * Team and head-to-head records for the sides Cricsheet withholds (Afghanistan), built from the
 * archive's own scorecards. The files are written in the Cricsheet site's schemas
 * (`appwrite/tools/history/src/stats.js`: `s/team/<key>.json`, `s/h2h/<a>__<b>.json`) so the app
 * reads them with the code it already has (`.claude/rules/archive-data.md`).
 */

import { indexRow } from "./archive.js";
import { pairKey, slug, teamKey } from "../../history/src/keys.js";

const AFGHANISTAN_TEAM_ID = "96";
const FORMAT_KEYS = { TEST: "Test", ODI: "ODI", T20: "T20I" };
const RESULT_SLOT = { W: 1, L: 2, T: 3, D: 4, N: 5 };

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isAfghanistan = (team) => String(team?.teamId) === AFGHANISTAN_TEAM_ID || norm(team?.name) === "afghanistan";

/**
 * One archived match as a record row, or null when it is not one a record counts: not a men's
 * Test/ODI/T20, no Afghanistan side and no league, or no ball bowled (Cricsheet leaves those out
 * too). `kind` is `international` when Afghanistan played, otherwise a league match (the Afghanistan
 * Premier League), which is filed under the league key `T20`.
 */
export function recordMatch(file) {
  const meta = file?.meta;
  const teams = meta?.teams;
  if (!meta || !Array.isArray(teams) || teams.length !== 2) return null;
  const format = FORMAT_KEYS[String(meta.matchFormat).toUpperCase()];
  if (!format) return null;
  const international = teams.some(isAfghanistan);
  if (!international && file.source !== "cricbuzz-backfill") return null;
  if (teams.some((t) => /women/i.test(t?.name ?? ""))) return null;
  if (!(file.scorecard?.innings?.length > 0)) return null;
  const date = indexRow(file.id, { meta, context: null, detail: file.detail })[1];
  if (!date) return null;
  return {
    id: String(file.id),
    date,
    international,
    format: international ? format : "T20",
    teams: teams.map((t) => ({ id: String(t.teamId), name: String(t.name) })),
    result: resultFor(meta.status ?? file.detail?.status, teams, file.scorecard.innings.length, format),
  };
}

function resultFor(status, teams, innings, format) {
  const s = String(status ?? "").trim();
  if ((s === "" || s === "$undefined") && innings === 2 && format !== "Test") {
    return resultFromScores(teams) ?? { unresolved: s };
  }
  return resultOf(s, teams);
}

/**
 * `{winner: 0|1}`, `{r: "tie"|"draw"|"no result"}`, or `{unresolved: status}` when a winner is named
 * that is neither side. A tie settled by a super over is a tie, as Cricsheet files it.
 */
export function resultOf(status, teams) {
  const s = String(status ?? "");
  if (/\bti(ed|e)\b/i.test(s)) return { r: "tie" };
  if (/\bdrawn?\b/i.test(s)) return { r: "draw" };
  if (/no result|abandon/i.test(s)) return { r: "no result" };
  const won = /^(.+?)\s+won\b/i.exec(s);
  if (won) {
    const who = norm(won[1]);
    const hits = [0, 1].filter((i) => sameSide(who, norm(teams[i].name)));
    if (hits.length === 1) return { winner: hits[0] };
  }
  return { unresolved: s };
}

/** "eng" and "hk" for "england" and "hong kong": the full name, a prefix of it, or its initials. */
function sameSide(who, name) {
  if (!who) return false;
  const initials = name.split(" ").map((w) => w[0]).join("");
  return who === name || (who.length >= 3 && name.startsWith(who)) || who === initials;
}

/**
 * A card whose status text Cricbuzz did not render (the literal "$undefined", or none): the side
 * with more runs won a completed limited-overs match of two innings; a level score stays unresolved.
 */
function resultFromScores(teams) {
  const runs = teams.map((t) => Number(/^\d+/.exec(String(t.score ?? ""))?.[0]));
  if (runs.some(Number.isNaN) || runs[0] === runs[1]) return null;
  return { winner: runs[0] > runs[1] ? 0 : 1 };
}

const newTally = () => [0, 0, 0, 0, 0, 0];

function tally(t, res) {
  t[0] += 1;
  t[RESULT_SLOT[res]] += 1;
}

/** The newest spelling of each Cricbuzz team id that is not shouted ("IRELAND" is a scraper artefact). */
function displayNames(rows) {
  const names = new Map();
  for (const row of rows) {
    for (const t of row.teams) {
      const shouted = t.name === t.name.toUpperCase() && t.name.length > 3;
      if (!names.has(t.id) || (!shouted && names.get(t.id).shouted)) names.set(t.id, { name: t.name, shouted });
    }
  }
  return (id) => names.get(id).name;
}

/** Every file as `Map<path, object>`, match lists newest first. */
export function buildRecords(files) {
  const rows = [];
  const unresolved = [];
  for (const file of files) {
    const row = recordMatch(file);
    if (!row) continue;
    if (row.result.unresolved !== undefined) unresolved.push({ id: row.id, status: row.result.unresolved });
    else rows.push(row);
  }
  const display = displayNames(rows);
  const teams = new Map();
  const pairs = new Map();

  for (const row of rows) {
    const names = row.teams.map((t) => display(t.id));
    const w = row.result.winner ?? -1;
    const fk = row.format;
    for (const side of [0, 1]) {
      // An opponent in an international is a side Cricsheet records; a file from only its Afghanistan
      // matches would be a partial record under the same key.
      if (row.international && row.teams[side].id !== AFGHANISTAN_TEAM_ID) continue;
      const key = teamKey(names[side], "male");
      let team = teams.get(key);
      if (!team) teams.set(key, (team = { t: names[side], g: "male", f: {}, y: {}, m: [] }));
      const res = w >= 0 ? (w === side ? "W" : "L") : row.result.r === "tie" ? "T" : row.result.r === "draw" ? "D" : "N";
      tally((team.f[fk] ??= newTally()), res);
      tally((team.y[row.date.slice(0, 4)] ??= newTally()), res);
      team.m.push([row.id, row.date, fk, names[1 - side], res]);
    }
    const pk = pairKey(names[0], names[1], "male");
    let pair = pairs.get(pk);
    if (!pair) pairs.set(pk, (pair = { t: [...names].sort((a, b) => slug(a).localeCompare(slug(b))), g: "male", f: {}, m: [] }));
    const winnerSide = w >= 0 ? pair.t.indexOf(names[w]) : -1;
    const pf = (pair.f[fk] ??= newTally());
    pf[0] += 1;
    if (winnerSide === 0) pf[1] += 1;
    else if (winnerSide === 1) pf[2] += 1;
    else if (row.result.r === "tie") pf[3] += 1;
    else if (row.result.r === "draw") pf[4] += 1;
    else pf[5] += 1;
    pair.m.push([row.id, row.date, fk, winnerSide, row.result.r ?? null]);
  }

  const byDateDesc = (a, b) => String(b[1]).localeCompare(String(a[1])) || String(b[0]).localeCompare(String(a[0]));
  const out = new Map();
  for (const [key, team] of teams) {
    team.m.sort(byDateDesc);
    out.set(`s/team/${key}.json`, team);
  }
  for (const [key, pair] of pairs) {
    pair.m.sort(byDateDesc);
    out.set(`s/h2h/${key}.json`, pair);
  }
  return { files: out, matches: rows.length, unresolved };
}
