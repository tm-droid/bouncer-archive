// The pure half of the Cricbuzz scorecard backfill (`backfill-cricbuzz.mjs`): what to look for on
// Cricbuzz's flight payloads and how a match file is built from them. No network and no disk, and
// no import of match-sync (this directory is published on its own to the public repo, where
// match-sync is not): the parsers' output arrives as arguments.
//
// Only structured facts leave this file. No commentary, no match report, no page HTML.

import { MATCH_ID, SCHEMA_VERSION, indexRow, isTerminal } from "./archive.js";

export const AFGHANISTAN_TEAM_ID = 96;
/** Cricbuzz's own `matchFormat` values for the three senior formats (a T20I is "T20"). */
export const FORMATS = new Set(["TEST", "ODI", "T20"]);
/** The only franchise league on Cricbuzz's archive for Afghanistan. */
export const LEAGUE_SERIES = /afghanistan premier league|shpageeza/i;

const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (visit(node) === false) return;
  for (const k of Object.keys(node)) walk(node[k], visit);
};

/** `[{id, name, section}]` from a `/cricket-scorecard-archives/{year}` page's payloads. */
export function seriesOfArchive(payloads) {
  const out = new Map();
  for (const p of payloads) {
    walk(p, (n) => {
      for (const section of ["internationalData", "leagueData"]) {
        const groups = n[section]?.seriesMapProto;
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          for (const s of g?.series ?? []) {
            const id = String(s?.id ?? "");
            if (MATCH_ID.test(id) && s?.name) out.set(id, { id, name: String(s.name), section });
          }
        }
      }
    });
  }
  return [...out.values()];
}

/** `matchInfo` objects from a `/cricket-series/{id}/{slug}/matches` page's payloads. */
export function matchesOfSeries(payloads) {
  const out = new Map();
  for (const p of payloads) {
    walk(p, (n) => {
      if (!Array.isArray(n.matchDetails)) return;
      for (const g of n.matchDetails) {
        for (const m of g?.matchDetailsMap?.match ?? []) {
          const mi = m?.matchInfo;
          if (mi && MATCH_ID.test(String(mi.matchId))) out.set(String(mi.matchId), mi);
        }
      }
      return false;
    });
  }
  return [...out.values()];
}

/** Afghanistan's senior men's side (team id 96), in a format the archive keeps. */
export const isAfghanistanMatch = (mi) =>
  FORMATS.has(mi?.matchFormat) && [mi?.team1?.teamId, mi?.team2?.teamId].some((t) => Number(t) === AFGHANISTAN_TEAM_ID);

/** A match in a league series, whoever plays (the franchises are not team 96). */
export const isLeagueMatch = (mi, seriesName) => LEAGUE_SERIES.test(seriesName ?? "") && FORMATS.has(mi?.matchFormat);

const person = (p) => (p?.name ? { id: p.id != null ? String(p.id) : null, name: String(p.name), country: p.country ?? null } : null);

/**
 * The match header of a live page (`/live-cricket-scores/{id}`): the object with the match's
 * description, series, teams and officials. Null when the page has none.
 */
export function matchHeaderOf(payloads) {
  // The page carries the header twice: a bare one (teams, no officials) and the full one. Take the
  // one with officials or a player of the match when there is one.
  let first = null;
  let full = null;
  for (const p of payloads) {
    walk(p, (n) => {
      if (full) return false;
      if (n.matchId !== undefined && n.matchDescription !== undefined && n.team1 && n.team2) {
        first ??= n;
        if (n.umpire1 || n.referee || n.playersOfTheMatch?.length) full = n;
        return false;
      }
    });
  }
  return full ?? first;
}

/**
 * Officials, player of the match and the squads, as names and ids only.
 *
 * `squads` is Cricbuzz's player list for the match, which can include the bench: a `substitute`
 * flag marks some of them, the playing XI is not marked. It is kept as the squad it is.
 */
export function officialsOf(header) {
  if (!header) return null;
  const squad = (t) =>
    (t?.playerDetails ?? [])
      .filter((p) => p?.name)
      .map((p) => ({
        id: p.id != null ? String(p.id) : null,
        name: String(p.fullName ?? p.name),
        role: p.role ?? null,
        captain: p.captain === true,
        keeper: p.keeper === true,
        substitute: p.substitute === true,
      }));
  return {
    umpires: [header.umpire1, header.umpire2].map(person).filter(Boolean),
    thirdUmpire: person(header.umpire3),
    referee: person(header.referee),
    playersOfTheMatch: (header.playersOfTheMatch ?? []).filter((p) => p?.name).map((p) => ({ id: p.id != null ? String(p.id) : null, name: String(p.fullName ?? p.name) })),
    squads: {
      [String(header.team1?.id ?? "team1")]: squad(header.team1),
      [String(header.team2?.id ?? "team2")]: squad(header.team2),
    },
  };
}

/**
 * Problems with a parsed scorecard: an innings whose total is not its batters' runs plus extras.
 * An empty list is a card that adds up. A card with no innings has nothing to check.
 */
export function cardProblems(scorecard) {
  const problems = [];
  (scorecard?.innings ?? []).forEach((inn, i) => {
    const runs = (inn.batsmen ?? []).reduce((n, b) => n + (Number.parseInt(b.runs, 10) || 0), 0);
    const extras = Number.parseInt(String(inn.extras ?? "").trim(), 10) || 0;
    const total = Number.parseInt(String(inn.score ?? "").trim(), 10);
    if (!Number.isFinite(total)) problems.push(`innings ${i + 1}: no total`);
    else if (runs + extras !== total) problems.push(`innings ${i + 1}: ${runs} + ${extras} extras != ${total}`);
  });
  return problems;
}

const numberString = (v) => (v === null || v === undefined || v === "" ? null : String(v));

/**
 * The entry a match list holds for this match (`ArchivedMatch.meta`): the shape `archive.mjs`
 * stores, so the app reads a backfilled match like a followed one.
 *
 * `header` is the live page's match header, `info` the series page's `matchInfo` (either may be
 * missing; the header wins), `detail` the parsed live detail, whose status is the result.
 */
export function metaOf({ id, header, info, detail }) {
  const series = header?.series ?? {};
  const t1 = header?.team1 ?? info?.team1 ?? {};
  const t2 = header?.team2 ?? info?.team2 ?? {};
  const idOf = (t) => numberString(t.id ?? t.teamId);
  const nameOf = (t) => t.name ?? t.teamName ?? null;
  // The live detail's score line is keyed by the team's short code on some pages and its full name
  // on others.
  const scoreOf = (t, slot) => {
    const d = detail ?? {};
    const keyed = [d.team1Id, d.team2Id].map(String);
    const mine = keyed.indexOf(idOf(t) ?? "?");
    const n = mine >= 0 ? mine + 1 : slot;
    return { score: d[`team${n}Score`] ?? null, overs: d[`team${n}Overs`] ?? null };
  };
  return {
    id: String(id),
    title: `${nameOf(t1)} vs ${nameOf(t2)}`,
    status: detail?.status ?? null,
    state: header?.state ?? info?.state ?? null,
    matchFormat: header?.matchFormat ?? info?.matchFormat ?? null,
    seriesId: numberString(series.id ?? info?.seriesId),
    seriesName: series.name ?? info?.seriesName ?? null,
    matchDesc: header?.matchDescription ?? info?.matchDesc ?? null,
    startDate: numberString(header?.matchStartTimestamp ?? info?.startDate),
    teams: [t1, t2].map((t, i) => ({
      teamId: idOf(t),
      name: nameOf(t),
      ...scoreOf(t, i + 1),
      isBatting: false,
    })),
  };
}

/** Whether the match is over: its status text or its list state says so. */
export const isFinished = (meta) => isTerminal(meta?.status) || /^(complete|abandon)/i.test(String(meta?.state ?? ""));

/**
 * The match file for `m/<id>.json`. `rows` is empty: this unit is scorecards only, and Cricbuzz's
 * commentary text is never archived.
 */
export function matchFile({ id, nowMs, meta, detail, scorecard, officials, venue, toss, dayNight }) {
  const file = {
    v: SCHEMA_VERSION,
    id: String(id),
    final: 1,
    finalisedAt: new Date(nowMs).toISOString(),
    rows: [],
    meta,
    detail: detail ?? null,
    scorecard: scorecard ?? null,
    source: "cricbuzz-backfill",
  };
  const info = { venue: venue ?? null, toss: toss ?? null, dayNight: dayNight ?? null, ...(officials ?? {}) };
  if (Object.values(info).some((v) => v !== null && v !== undefined)) file.info = info;
  return file;
}

/** The month-index row of a backfilled match (the men's side only: every source here is men's). */
export function backfillIndexRow(meta, venue) {
  const row = indexRow(meta.id, { meta, context: { gender: "male", venue }, detail: null });
  return row;
}
