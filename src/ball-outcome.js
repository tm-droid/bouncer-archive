// What one delivery was worth, read from the OUTCOME CLAUSE of Cricbuzz's commentary line, then the
// line is thrown away by the caller.
//
// VENDORED from `match-sync/src/cricbuzz.js` (`parseBallOutcome` and its patterns) and `llm.js`
// (`outcomeClause`): this directory is published on its own to the public repo, where match-sync is
// not, and cricbuzz.js drags in cheerio and the LLM chain. `test/balls.test.js` compares this copy
// with the original on a fixed set of lines whenever match-sync is beside it, so a one-sided edit
// fails the build here. Edit match-sync's first, then this.

const BALL_OUTCOME = /^[^,]+,\s*([^,]+)/;
const TRAILING_PUNCTUATION = /[.!]+$/;
const RUNS_OFF_BAT = /^(\d{1,3}) runs?$/i;
const NO_RUN = /^no run$/i;
const OUTCOME_FOUR = /^four$/i;
const OUTCOME_SIX = /^six$/i;
const OUTCOME_WICKET = /^(?:out\b|that'?s out\b)/i;
const EXTRA_KIND = /^(?:(\d{1,3})\s*)?(wd|wides?|nb|no.?balls?|lb|leg ?byes?|byes?|b)$/i;
const EXTRA_FOLLOW = /^[^,]+,\s*[^,]+,\s*(?:(\d{1,3}) runs?|(four|six))\b/i;
const KIND_WIDE = /^(?:wd|wides?)$/i;
const KIND_NOBALL = /^(?:nb|no.?balls?)$/i;
const KIND_LEGBYE = /^(?:lb|leg ?byes?)$/i;
const KIND_BYE = /^(?:byes?|b)$/i;
const EXTRA_KINDS = [
  [KIND_WIDE, "WIDE"],
  [KIND_NOBALL, "NOBALL"],
  [KIND_LEGBYE, "LEGBYE"],
  [KIND_BYE, "BYE"],
];

function outcomeClause(text) {
  const m = String(text || "").match(BALL_OUTCOME);
  return m ? m[1].trim().replace(TRAILING_PUNCTUATION, "") : "";
}

function extraKindOf(word) {
  for (const [re, kind] of EXTRA_KINDS) if (re.test(word)) return kind;
  return null;
}

function followRunsOf(text) {
  const m = String(text).match(EXTRA_FOLLOW);
  if (!m) return null;
  if (m[1]) return Number(m[1]);
  return /^four$/i.test(m[2]) ? 4 : 6;
}

function extraRunsOf(kind, inline, text) {
  if (inline) return Number(inline);
  const penalty = kind === "WIDE" || kind === "NOBALL" ? 1 : 0;
  const follow = followRunsOf(text);
  if (follow === null) return penalty || 1;
  return penalty + follow;
}

/** `{ runs, kind }`: TOTAL runs off the delivery (extras included) and WIDE/NOBALL/BYE/LEGBYE or null. */
export function parseBallOutcome(text) {
  const clause = outcomeClause(text);
  if (!clause) return { runs: null, kind: null };
  if (NO_RUN.test(clause)) return { runs: 0, kind: null };
  const offBat = clause.match(RUNS_OFF_BAT);
  if (offBat) return { runs: Number(offBat[1]), kind: null };
  if (OUTCOME_FOUR.test(clause)) return { runs: 4, kind: null };
  if (OUTCOME_SIX.test(clause)) return { runs: 6, kind: null };
  if (OUTCOME_WICKET.test(clause)) return { runs: 0, kind: null };
  const extra = clause.match(EXTRA_KIND);
  if (!extra) return { runs: null, kind: null };
  const kind = extraKindOf(extra[2]);
  if (!kind) return { runs: null, kind: null };
  return { runs: extraRunsOf(kind, extra[1], text), kind };
}
