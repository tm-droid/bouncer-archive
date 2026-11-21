// The pure half of the ball-by-ball backfill (`backfill-balls.mjs`): Cricbuzz commentary items in,
// the history site's delivery arrays out. No network and no disk.
//
// NO COMMENTARY TEXT SURVIVES. `recordOf` reads `commText` once, for the runs, the extra's kind and
// the kind of dismissal, and returns numbers and short codes. Nothing downstream ever sees the text.
//
// Delivery shape (`.claude/rules/history-data.md`): [over, ball, batter, bowler, nonStriker,
// batRuns, extraRuns, extrasBits, wickets?]. batter/bowler/nonStriker index the match's people list
// `p` = [[name, cricbuzzPlayerId], ...] (-1 = unknown). `over` is 0-based; `ball` is the scorer's
// label, so a wide keeps the number of the ball it replaces. A wicket is [kind, outIdx].
// Bits: 1 wide, 2 no-ball, 4 bye, 8 leg-bye, 16 penalty, 32 non-boundary.

import { parseBallOutcome } from "./ball-outcome.js";

export const BITS = { WIDE: 1, NOBALL: 2, BYE: 4, LEGBYE: 8, PENALTY: 16, NON_BOUNDARY: 32 };

/** The host said 403/429. Callers stop the whole run and save state. */
export class CricbuzzBlockedError extends Error {
  constructor(status, url = "") {
    super(`Cricbuzz answered ${status}${url ? ` for ${url}` : ""}`);
    this.name = "CricbuzzBlockedError";
    this.status = status;
    this.blocked = true;
  }
}

export const commentaryUrl = (matchId, inningsId, ts) =>
  `https://www.cricbuzz.com/api/mcenter/commentary-pagination/${matchId}/${inningsId}/${ts}`;

// Dismissal kind, read from the line's own words. Order matters: "c & b" before "caught".
const DISMISSALS = [
  [/\bc ?& ?b\b|caught and bowled|caught & bowled/i, "caught and bowled"],
  [/\bstumped\b|\bst\b/i, "stumped"],
  [/\brun ?out\b/i, "run out"],
  [/\blbw\b|leg before/i, "lbw"],
  [/\bhit.?wicket\b/i, "hit wicket"],
  [/\bcaught\b/i, "caught"],
  [/\bbowled\b/i, "bowled"],
  [/\bretired\b/i, "retired out"],
  [/\bobstruct/i, "obstructing the field"],
  [/\bhandled\b/i, "handled the ball"],
  [/\btimed out\b/i, "timed out"],
];
const dismissalOf = (text) => DISMISSALS.find(([re]) => re.test(text))?.[1] ?? "wicket";

const tenths = (bm) => Math.round(Number(bm) * 10);

/**
 * One commentary item as a structured record, or null when it is not a delivery (an over separator,
 * a bowler-change note, the end-of-match report: none has a `ballMetric`).
 *
 * Record: {ts, t (over*10+ball), ev (bit 1 four, 2 six, 4 wicket), bat ["", striker's name from the line], bowl [id,name],
 * runs (total off the ball, null = unreadable), kind (WIDE|NOBALL|BYE|LEGBYE|null), wk (dismissal
 * kind or null)}.
 */
export function recordOf(item, parseOutcome = parseBallOutcome) {
  if (!item || item.commType === "over-separator" || item.ballMetric == null) return null;
  const t = tenths(item.ballMetric);
  if (!Number.isFinite(t) || t % 10 === 0 || t < 1) return null;
  const events = Array.isArray(item.event) ? item.event : [];
  // Cricbuzz marks the outcome up (`<b>FOUR</b>`); the parser reads plain text.
  const text = String(item.commText ?? "").replace(/<[^>]*>/g, "");
  const wicket = events.includes("wicket");
  let { runs, kind } = parseOutcome(text);
  // A wicket line reads "out ... Run Out!! 1 run completed": the outcome clause is "out", which the
  // parser scores 0, but the batters ran. (A line with no "completed" is a plain dismissal, 0.)
  if (wicket && !kind) {
    const done = text.match(/\b(\d{1,2}) runs? completed\b/i);
    if (done) runs = Number(done[1]);
  }
  // "FOUR plunges forward..." has no comma after the outcome, so the clause reads as prose; the
  // event still says it was a boundary (20236 1.4).
  if (runs === null && !wicket) runs = events.includes("four") ? 4 : events.includes("six") ? 6 : null;
  const ev = (events.includes("four") ? 1 : 0) | (events.includes("six") ? 2 : 0) | (wicket ? 4 : 0);
  const who = (d) => [d?.playerId ? String(d.playerId) : "", String(d?.playerName ?? "")];
  // The STRIKER is the name in the line's own "Bowler to Batter," lead. `batsmanDetails` is the
  // batter at the crease AFTER the ball (the other one after an odd run or an over's last ball, and
  // empty on a wicket), so it is not who faced it: measured on 17685-17687, where reading it
  // misattributed 5-10 runs per batter. The id is resolved later against the scorecard's batsmen.
  const lead = text.match(/^\s*.+?\s+to\s+(.+?),/);
  // "no ball, leg byes, 1 run": the runs past the no-ball's penalty are leg byes, not the batter's.
  // The total comes from the over summary (`reconcile`); the line is the only place the split is said.
  const nbx = kind === "NOBALL" ? text.match(/\bno.?balls?,\s*(leg ?byes?|byes?)\b/i)?.[1] : null;
  return {
    ...(nbx ? { nbx: /^leg/i.test(nbx) ? "LEGBYE" : "BYE" } : {}),
    ts: Number(item.timestamp),
    t,
    ev,
    bat: ["", lead ? lead[1].trim() : ""],
    nx: item.batsmanDetails?.playerId ? String(item.batsmanDetails.playerId) : "",
    bowl: who(item.bowlerDetails),
    runs,
    kind,
    wk: wicket ? dismissalOf(text) : null,
  };
}

const keyOf = (r) => `${r.ts}:${r.t}`;

/**
 * Walks one innings backwards from the newest item. `st` is the innings' persisted state and is
 * mutated in place: `{cursor, recs, cp, done}`. One `fetchPage(cursor)` per loop turn returns the raw
 * items older than `cursor`, newest first. Stops (done) on an empty page, a page with nothing new,
 * or a cursor that did not move; stops (not done) when `canRequest()` says the budget is spent.
 * A throw from `fetchPage` (a block) propagates with `st` already holding everything fetched so far.
 *
 * PAGING SEMANTICS (measured on 17685-17687): the endpoint is one match-wide commentary stream, newest
 * first, and `inningsId` in the URL only picks where the stream starts. Walking an innings back past
 * its first ball runs straight on into the OTHER innings (older), so every item is filtered on its own
 * `inningsId` (`innings`), and a non-empty page with none of ours ends the walk. The cursor is
 * exclusive (items strictly older), and `timestamp` is unique per item, so it is the dedupe key
 * (over.ball is not: a wide and the ball bowled again share a label).
 * `st.cp[n]` = runs on the board after `n` overs, from the over separators, for diagnostics only.
 * `st.os[n]` = that separator's over summary ("0 W N1 1"), Cricbuzz's own scoring codes, for `reconcile`.
 */
export async function crawlInnings({ fetchPage, st, innings = null, canRequest = () => true, parseOutcome = parseBallOutcome }) {
  const seen = new Set((st.recs ?? []).map(keyOf));
  st.recs ??= [];
  while (!st.done) {
    if (!canRequest()) return "budget";
    const items = await fetchPage(st.cursor);
    const stamps = (items ?? []).map((i) => Number(i?.timestamp)).filter(Number.isFinite);
    if (stamps.length === 0) {
      st.done = 1;
      return "empty";
    }
    const ours = innings == null ? items : items.filter((i) => i?.inningsId == null || Number(i.inningsId) === Number(innings));
    if (ours.length === 0) {
      st.done = 1;
      return "foreign";
    }
    let fresh = 0;
    for (const item of ours) {
      if (item?.commType === "over-separator") {
        const n = Number(item.overSeparator?.overNumber);
        const score = Number.parseInt(String(item.overSeparator?.batTeamObj?.teamScore ?? ""), 10);
        if (Number.isFinite(n) && Number.isFinite(score)) (st.cp ??= {})[n] = score;
        const summary = String(item.overSeparator?.overSummary ?? "").trim();
        if (Number.isFinite(n) && summary) (st.os ??= {})[n] = summary;
        continue;
      }
      const r = recordOf(item, parseOutcome);
      if (!r || seen.has(keyOf(r))) continue;
      seen.add(keyOf(r));
      st.recs.push(r);
      fresh++;
    }
    const oldest = Math.min(...stamps);
    if (oldest >= st.cursor) {
      st.done = 1;
      return "stuck";
    }
    st.cursor = oldest;
    if (fresh === 0 && ours.every((i) => i?.ballMetric == null)) {
      // A page of nothing but separators and notes: keep walking (the cursor moved). A page whose
      // balls were all seen already is a repeat, and the only way out is to stop.
      continue;
    }
    if (fresh === 0) {
      st.done = 1;
      return "duplicate";
    }
  }
  return "done";
}

/**
 * Records without the superseded copies of a legal ball: two legal deliveries never share a label,
 * so two lines with one label and one outcome are the same ball posted twice, and the newer is the
 * correction (47211 32.1 first named the wrong bowler; 18005 posted its whole first over twice,
 * minutes apart). Wides and no-balls share labels by rule and are never dropped, and lines with
 * different outcomes are kept for the totals check to judge.
 */
export function dropReposts(recs) {
  const legal = (r) => r.kind !== "WIDE" && r.kind !== "NOBALL";
  const newest = new Map();
  for (const r of recs) {
    if (!legal(r)) continue;
    const k = `${r.t}:${r.runs}:${r.kind ?? ""}`;
    if (!newest.has(k) || newest.get(k).ts < r.ts) newest.set(k, r);
  }
  const out = recs.filter((r) => !legal(r) || newest.get(`${r.t}:${r.runs}:${r.kind ?? ""}`) === r);
  return out.length === recs.length ? recs : out;
}

// Cricbuzz's over-summary codes. A number is the delivery's TOTAL, an extra's penalty included
// ("Wd3" = 3, "N1" = 2, "NB1" = 2); "P" is 5 penalty runs and not a ball. Every summary in the
// four innings measured (103852, 109351, 148415, 16933; 275 overs) adds up to its `overRuns`.
const OVER_TOKENS = [
  [/^(\d)$/, (m) => ({ runs: Number(m[1]), kind: null })],
  [/^W(\d)?$/, (m) => ({ runs: Number(m[1] ?? 0), kind: null, w: 1 })],
  [/^Wd(\d)?$/, (m) => ({ runs: Number(m[1] ?? 1), kind: "WIDE" })],
  [/^NB?(\d)?$/, (m) => ({ runs: 1 + Number(m[1] ?? 0), kind: "NOBALL" })],
  [/^L(\d)$/, (m) => ({ runs: Number(m[1]), kind: "LEGBYE" })],
  [/^B(\d)$/, (m) => ({ runs: Number(m[1]), kind: "BYE" })],
  [/^P$/, () => ({ runs: 5, pen: 1 })],
];

/** One over-summary code as `{runs, kind, w?, pen?}`, or null when it is not one. */
export function overToken(code) {
  for (const [re, of] of OVER_TOKENS) {
    const m = String(code).match(re);
    if (m) return of(m);
  }
  return null;
}

const fits = (r, k) => r.runs === null || (r.runs === k.runs && (r.kind ?? null) === k.kind);

/**
 * The innings' records corrected by each over's summary (`os`, from `crawlInnings`). The commentary
 * line is free text and the summary is the scorer's: where a line cannot be read ("New baller gets
 * the wicket!!") or reads short ("no ball, leg byes, 1 run" parses as 1 where the summary says N1),
 * the summary's total and kind win. Its "P" becomes penalty extras on the next ball. A summary is used
 * only when its total equals the board's change over that over (`cp`, the separators' scores).
 *
 * Alignment, per over: as many balls as codes pairs them in order, each pair agreeing on its label
 * or its runs. FEWER balls than codes (Cricbuzz's stream drops a line, measured on 16933) pairs every
 * ball with a code of the same label and runs, and each code left over becomes a rebuilt ball
 * (`syn`), bowled by the over's bowler, its striker settled in `deliveriesOf`. Anything else (more
 * balls than codes, a code it cannot read, no pairing) leaves the over as the lines had it.
 */
export function reconcile(recs, os, cp = null) {
  if (!os) return recs;
  const byOver = new Map();
  for (const r of recs) {
    const o = Math.floor(r.t / 10);
    if (!byOver.has(o)) byOver.set(o, []);
    byOver.get(o).push(r);
  }
  const replaced = new Map();
  const added = [];
  for (const [n, summary] of Object.entries(os)) {
    const o = Number(n) - 1;
    const mine = (byOver.get(o) ?? []).sort((a, b) => a.ts - b.ts);
    const codes = String(summary).split(/\s+/).map(overToken);
    if (mine.length === 0 || codes.some((c) => !c)) continue;
    // Some separators carry a placeholder ("0 0 0 0 0 0", overRuns 0) while the board moved 6
    // (47211 overs 45-46), so a summary counts only when the board's own change says the same.
    const board = cp?.[n] - (Number(n) === 1 ? 0 : cp?.[Number(n) - 1]);
    if (codes.reduce((s, c) => s + c.runs, 0) !== board) continue;
    // "P" is either penalty runs between balls (148415 "P 0 Wd ...") or a ball whose only runs are
    // the penalty (46490 "1 2 1 P 4 W": the ball hit the keeper's helmet). The reading whose ball
    // count is the over's line count wins; between balls first.
    const ballsOf = (pIsBall) => {
      const out = [];
      let legal = 0;
      let pen = 0;
      for (const raw of codes) {
        const c = raw.pen && pIsBall ? { runs: 0, kind: null, pen: raw.runs } : raw;
        if (c.pen && !pIsBall) {
          pen += c.runs;
          continue;
        }
        out.push({ ...c, label: o * 10 + legal + 1, pen: (c.pen ?? 0) + pen });
        pen = 0;
        if (c.kind !== "WIDE" && c.kind !== "NOBALL") legal++;
      }
      if (pen && out.length) out.at(-1).pen += pen;
      return out;
    };
    const between = ballsOf(false);
    const asBall = codes.some((c) => c.pen) ? ballsOf(true) : between;
    const balls = mine.length !== between.length && mine.length === asBall.length ? asBall : between;
    let pairs = null;
    if (mine.length === balls.length) {
      if (mine.every((r, k) => r.t === balls[k].label || fits(r, balls[k]))) pairs = mine.map((r, k) => [r, k]);
    } else if (mine.length < balls.length) {
      pairs = [];
      let k = 0;
      for (const r of mine) {
        while (k < balls.length && !(r.t === balls[k].label && fits(r, balls[k]))) k++;
        if (k === balls.length) break;
        pairs.push([r, k++]);
      }
      if (pairs.length !== mine.length) pairs = null;
    }
    if (!pairs) continue;
    const used = new Set();
    for (const [r, k] of pairs) {
      const c = balls[k];
      used.add(k);
      replaced.set(r, { ...r, runs: c.runs, kind: c.kind, ...(c.pen ? { pen: c.pen } : {}) });
    }
    const bowl = mine[0].bowl;
    balls.forEach((c, k) => {
      if (used.has(k)) return;
      // Ordered between its neighbours: after the paired ball before it, else before the first.
      const before = pairs.filter(([, j]) => j < k).at(-1)?.[0];
      const ts = before ? before.ts + (k + 1) / 1000 : mine[0].ts - (balls.length - k) / 1000;
      const ev = (c.runs === 4 && !c.kind ? 1 : 0) | (c.runs === 6 && !c.kind ? 2 : 0) | (c.w ? 4 : 0);
      added.push({ ts, t: c.label, ev, bat: ["", ""], nx: "", bowl, runs: c.runs, kind: c.kind, wk: c.w ? "wicket" : null, syn: 1, ...(c.pen ? { pen: c.pen } : {}) });
    });
  }
  if (replaced.size === 0 && added.length === 0) return recs;
  return [...recs.map((r) => replaced.get(r) ?? r), ...added];
}

const normName = (n) =>
  String(n ?? "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const profileId = (url) => String(url ?? "").match(/\/profiles\/(\d+)/)?.[1] ?? "";

// Commentary on some (mostly associate) matches gives initials: "J Mohammed" for the scorecard's
// "Jason Mohammed" (measured on 18284/18286), "S Thompson" for "Stuart Thompson" (16940).
const initialled = (rn) => {
  const t = rn.split(" ");
  if (t.length < 2) return [];
  const last = t.at(-1);
  const ini = t.slice(0, -1).map((w) => w[0]);
  return [`${ini.join("")} ${last}`, `${ini.join(" ")} ${last}`, `${ini[0]} ${last}`];
};

/** The scorecard's batsmen as [{id, name, balls}], ids from their profile links. */
const rosterOf = (card) =>
  (card?.batsmen ?? []).map((b) => ({
    id: profileId(b.profileUrl),
    name: String(b.name ?? "").replace(/\s*\([^)]*\)/g, "").trim(),
    balls: Number.parseInt(String(b.balls ?? ""), 10) || 0,
  }));

/**
 * A commentary name ("Shahzad", "Asghar Stanikzai", "J Mohammed") -> the roster batsman: the exact name,
 * else the one name it prefixes or suffixes or abbreviates to initials. When several fit ("Shahzad" in a
 * side with two), `hintId` breaks the tie: the previous ball's `nx`, the batter Cricbuzz put at the
 * crease after it. `voted` (normalized name -> id, from `votedIds`) comes before the fuzzy rules: it
 * settles nicknames and short forms no name rule can ("Andy Balbirnie" for "Andrew Balbirnie").
 */
function resolveBatter(pair, roster, hintId = "", voted = null) {
  if (pair[0] || !pair[1] || !roster?.length) return pair;
  const n = normName(pair[1]);
  const exact = roster.filter((r) => normName(r.name) === n);
  const id = voted?.get(n);
  const byId = exact.length === 0 && id ? roster.filter((r) => r.id === id) : [];
  const pool =
    exact.length > 0
      ? exact
      : byId.length === 1
        ? byId
        : roster.filter((r) => {
            const rn = normName(r.name);
            return (
              rn.endsWith(` ${n}`) || n.endsWith(` ${rn}`) || rn.startsWith(`${n} `) || n.startsWith(`${rn} `) ||
              initialled(rn).includes(n)
            );
          });
  const hit = pool.length === 1 ? pool[0] : (pool.find((r) => hintId && r.id === hintId) ?? null);
  return hit ? [hit.id, hit.name] : pair;
}

/**
 * Commentary name -> player id, voted from the balls after which the striker cannot have changed (no
 * wicket, even runs, not an over's last ball): there `nx`, the batter on strike after the ball, is the
 * one who faced it. `batsmanDetails` gives the profile name ("Andrew Balbirnie") where the lead says
 * "Andy Balbirnie" (measured on 19316), so the id, not its name, is what joins them. A name needs two
 * votes and a two-thirds majority; a misread ball or a lead the parser got wrong cannot carry it.
 */
function votedIds(recs) {
  const tally = new Map();
  for (const r of recs) {
    if (!r.nx || !r.bat[1] || r.wk || r.runs === null || r.runs % 2 !== 0 || r.t % 10 >= 6) continue;
    const n = normName(r.bat[1]);
    if (!tally.has(n)) tally.set(n, new Map());
    const c = tally.get(n);
    c.set(r.nx, (c.get(r.nx) ?? 0) + 1);
  }
  const out = new Map();
  for (const [n, c] of tally) {
    const total = [...c.values()].reduce((a, b) => a + b, 0);
    const [id, top] = [...c].sort((a, b) => b[1] - a[1])[0];
    if (top >= 2 && top * 3 >= total * 2) out.set(n, id);
  }
  return out;
}

/**
 * The one commentary name nothing resolves, joined to the one scorecard batter who faced a ball and
 * has none: they are the same player. Settles a nickname the vote cannot ("Andy Balbirnie", 4 balls
 * and no dot ball he kept strike on, 21647). Two names or two batters left over: no join. Adds to
 * `voted` in place.
 */
function leftoverJoin(sorted, roster, voted) {
  if (!roster?.length) return;
  const unresolved = new Set();
  const used = new Set();
  let hint = "";
  for (const r of sorted) {
    if (!r.syn) {
      const [id, name] = resolveBatter(r.bat, roster, hint, voted);
      if (id) used.add(id);
      else if (name) unresolved.add(normName(name));
    }
    hint = r.nx ?? "";
  }
  const idle = roster.filter((b) => b.id && b.balls > 0 && !used.has(b.id));
  if (unresolved.size === 1 && idle.length === 1) voted.set([...unresolved][0], idle[0].id);
}

/**
 * Records of one innings as `{p, b, extras...}`: deliveries in bowling order, people appended to the
 * shared `people` (a Map "id|name" -> index). The non-striker is inferred from who faced before,
 * because Cricbuzz names only the striker and bowler per ball.
 */
export function deliveriesOf(recs, people, roster = null) {
  const idx = (pair) => {
    if (!pair[0] && !pair[1]) return -1;
    const k = `${pair[0]}|${pair[1]}`;
    if (!people.has(k)) people.set(k, people.size);
    return people.get(k);
  };
  const sorted = [...recs].sort((a, b) => a.ts - b.ts || a.t - b.t);
  const voted = votedIds(sorted);
  leftoverJoin(sorted, roster, voted);
  const out = [];
  let last = -1;
  let partner = -1;
  let lastWicket = false;
  let hint = "";
  for (const r of sorted) {
    // A rebuilt ball (`reconcile`) has no line to name its striker: it is the batter Cricbuzz put on
    // strike after the ball before it.
    const rebuilt = () => {
      const hit = roster?.find((x) => x.id === hint);
      return hit ? [hit.id, hit.name] : [hint, ""];
    };
    const s = idx(r.syn ? rebuilt() : resolveBatter(r.bat, roster, hint, voted));
    if (last !== -1 && s !== last) {
      if (s === partner) partner = last;
      else if (!lastWicket) partner = last;
    }
    let extra = 0;
    let bat = 0;
    let bits = 0;
    const total = r.runs ?? 0;
    if (r.kind === "WIDE") [extra, bits] = [total, BITS.WIDE];
    else if (r.kind === "NOBALL" && r.nbx) [extra, bits] = [total, BITS.NOBALL | BITS[r.nbx]];
    else if (r.kind === "NOBALL") [extra, bat, bits] = [Math.min(1, total), Math.max(0, total - 1), BITS.NOBALL];
    else if (r.kind === "BYE") [extra, bits] = [total, BITS.BYE];
    else if (r.kind === "LEGBYE") [extra, bits] = [total, BITS.LEGBYE];
    else bat = total;
    // A 4 or 6 the batter ran is not a boundary.
    if ((bat === 4 && !(r.ev & 1)) || (bat === 6 && !(r.ev & 2))) bits |= BITS.NON_BOUNDARY;
    if (r.pen) [extra, bits] = [extra + r.pen, bits | BITS.PENALTY];
    const d = [Math.floor(r.t / 10), r.t % 10, s, idx(r.bowl), partner, bat, extra, bits];
    if (r.wk) d.push([r.wk, s]);
    out.push({ d, unreadable: r.runs === null });
    last = s;
    lastWicket = Boolean(r.wk);
    hint = r.nx ?? "";
  }
  // Leading balls before a second batter appeared: the first different striker was the partner.
  const firstOther = out.find((o) => o.d[2] !== out[0]?.d[2])?.d[2];
  if (firstOther !== undefined) for (const o of out) if (o.d[4] === -1 && o.d[2] !== firstOther) o.d[4] = firstOther;
  return out;
}

const firstInt = (v) => {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};
/** "19.2" or Cricbuzz's "19.2 Ov" -> 116 legal balls. */
export function ballsOfOvers(overs) {
  const m = String(overs ?? "").trim().match(/^(\d+)(?:\.(\d))?(?:\s*Ov)?$/i);
  return m ? Number(m[1]) * 6 + Number(m[2] ?? 0) : null;
}

/**
 * Per-batter runs off the bat must equal the scorecard's `batsmen[].runs`. Joined on the Cricbuzz
 * player id (the scorecard's profileUrl), else on the name without "(c)" / "(wk)". `people` is the
 * shared list [[name, id], ...]. Returns problem strings.
 */
export function batterProblems(deliveries, card, people) {
  const batsmen = card?.batsmen;
  if (!Array.isArray(batsmen) || batsmen.length === 0 || !people) return [];
  // One player can sit under several people entries (the same id as a bowler "Nabi" and a batter
  // "Mohammad Nabi"), so runs are summed per player key: the id, else the normalized name.
  const keyOfPerson = (p) => (p?.[1] ? `id:${p[1]}` : `n:${normName(p?.[0])}`);
  const got = new Map();
  for (const { d } of deliveries) if (d[2] >= 0) got.set(keyOfPerson(people[d[2]]), (got.get(keyOfPerson(people[d[2]])) ?? 0) + d[5]);
  const out = [];
  const matched = new Set();
  for (const b of batsmen) {
    const want = firstInt(b.runs);
    if (want === null) continue;
    const id = profileId(b.profileUrl);
    const key = id ? `id:${id}` : `n:${normName(b.name)}`;
    matched.add(key);
    // A batter known only by name (no id on a ball) still counts under the id's player.
    const byName = id ? (got.get(`n:${normName(b.name)}`) ?? 0) : 0;
    if (byName) matched.add(`n:${normName(b.name)}`);
    const have = (got.get(key) ?? 0) + byName;
    if (have !== want) out.push(`${normName(b.name)} ${have} != ${want}`);
  }
  for (const [key, runs] of got) if (runs > 0 && !matched.has(key)) out.push(`${key.slice(key.indexOf(":") + 1)} ${runs} not on the scorecard`);
  return out.length ? [`batter runs differ: ${out.slice(0, 4).join(", ")}${out.length > 4 ? ` (+${out.length - 4})` : ""}`] : [];
}

/**
 * WHERE a failing innings is wrong, for the run log: balls whose label never appears in an over
 * (up to the highest label seen, in the last over) (Cricbuzz's stream omits some), and overs whose runs differ from the over
 * separators' score checkpoints (`cp[n]` = runs after n overs).
 */
function whereWrong(deliveries, cp) {
  const labels = new Set(deliveries.map(({ d }) => `${d[0]}.${d[1]}`));
  const overs = new Set(deliveries.map(({ d }) => d[0]));
  const lastOver = Math.max(-1, ...overs);
  const missing = [];
  for (const o of [...overs].sort((a, b) => a - b)) {
    // The last over is only checked up to its highest label: it may be unfinished.
    const top = o < lastOver ? 6 : Math.max(...deliveries.filter(({ d }) => d[0] === o).map(({ d }) => d[1]));
    for (let b = 1; b <= top; b++) if (!labels.has(`${o}.${b}`)) missing.push(`${o}.${b}`);
  }
  const out = [];
  if (missing.length) out.push(`no commentary for ball ${missing.slice(0, 8).join(" ")}${missing.length > 8 ? " ..." : ""}`);
  const perOver = [];
  for (const { d } of deliveries) perOver[d[0]] = (perOver[d[0]] ?? 0) + d[5] + d[6];
  let cum = 0;
  let prevDiff = 0;
  const off = [];
  for (let n = 1; n <= perOver.length; n++) {
    cum += perOver[n - 1] ?? 0;
    if (cp?.[n] === undefined) continue;
    const diff = cum - cp[n];
    if (diff !== prevDiff) off.push(`over ${n}: ${diff - prevDiff > 0 ? "+" : ""}${diff - prevDiff}`);
    prevDiff = diff;
  }
  if (off.length) out.push(`runs vs board by over: ${off.slice(0, 6).join(", ")}`);
  return out;
}

/**
 * Whether an innings' deliveries add up to its scorecard line `{score, overs}` (and, with `ctx.people`,
 * its batsmen). Returns the list of problems; empty means complete. Legal balls = not a wide, not a
 * no-ball. `ctx = {people, cp}`; both optional.
 */
export function inningsProblems(deliveries, card, ctx = {}) {
  const problems = [];
  const unreadable = deliveries.filter((o) => o.unreadable).length;
  if (unreadable) problems.push(`${unreadable} deliveries with unreadable runs`);
  let runs = 0;
  let legal = 0;
  for (const { d } of deliveries) {
    runs += d[5] + d[6];
    if (!(d[7] & (BITS.WIDE | BITS.NOBALL))) legal++;
  }
  const total = firstInt(card?.score);
  if (total === null) problems.push("no scorecard total");
  else if (runs !== total) problems.push(`runs ${runs} != total ${total}`);
  const balls = ballsOfOvers(card?.overs);
  if (balls !== null && legal !== balls) problems.push(`legal balls ${legal} != overs ${card.overs}`);
  problems.push(...batterProblems(deliveries, card, ctx.people));
  if (problems.length) problems.push(...whereWrong(deliveries, ctx.cp));
  return problems;
}

const personOf = (k) => {
  const cut = k.indexOf("|");
  return [k.slice(cut + 1), k.slice(0, cut)];
};

/**
 * The `balls` block of a match file from every innings' records.
 * `inns` = [{id, recs}], `cards` = the scorecard's `innings` in the same order.
 * Returns `{balls, problems}`; `problems` is for the run log, the file only carries `partial: 1`.
 */
export function ballsBlock(inns, cards) {
  const people = new Map();
  const problems = [];
  const innings = inns.map(({ id, recs, cp, os }, i) => {
    const ds = deliveriesOf(reconcile(dropReposts(recs), os, cp), people, rosterOf(cards?.[i]));
    const bad = inningsProblems(ds, cards?.[i], { people: [...people.keys()].map(personOf), cp });
    const inn = { i: id, b: ds.map((o) => o.d) };
    if (bad.length) {
      inn.partial = 1;
      problems.push(`innings ${id}: ${bad.join("; ")}`);
    }
    return inn;
  });
  const p = [...people.keys()].map(personOf);
  return { balls: { v: 1, p, inn: innings }, problems };
}
