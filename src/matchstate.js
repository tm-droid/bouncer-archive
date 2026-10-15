/**
 * Coarse match state from Cricbuzz's own status prose.
 *
 * A port of `MatchStatusClassifier.kt`, pattern for pattern. The device and this function both
 * have to decide which tab a match belongs on — the device because it scrapes the same pages for
 * the UI, this function because a Cricbuzz list page carries the site-wide ticker as well as its
 * own tab's matches, so the page alone does not answer the question. A narrower list here puts a
 * finished match on Live, or drops a fixture from Upcoming entirely.
 *
 * Two rules, both load-bearing and both inherited from the Kotlin original:
 *
 *  1. **Precedence, not position.** Every rule is evaluated and the highest-precedence signal
 *     wins wherever it appears, so "Match drawn, England 2nd innings 340/6" is TERMINAL rather
 *     than IN_PROGRESS.
 *  2. **Word boundaries.** Every pattern is anchored, so "tea" cannot fire inside "team" and
 *     "draw" cannot fire inside "drawing".
 *
 * `MatchStatusParityTest` compares all three lists against the Kotlin ones element for element,
 * and the TERMINAL list against `cricbuzz.js`'s third copy. A mirrored rule that nothing compares
 * is not a pinned rule.
 */

const TERMINAL_PATTERNS = [
  "\\bwon\\s+by\\b",
  "\\bwon\\s+the\\s+(match|series|game)\\b",
  "\\bbeat\\b",
  "\\bdrawn\\b",
  "\\bdraw\\b",
  "\\btied\\b",
  "\\bno\\s+result\\b",
  "\\babandon(ed)?\\b",
  "\\bcomplete[d]?\\b",
  "\\bwins\\b",
  "\\bwin\\s+by\\b",
  "\\bconcede[ds]?\\b",
  "\\bforfeit(ed)?\\b",
  "\\belected\\s+not\\s+to\\s+bat\\b",
];

const IN_PROGRESS_PATTERNS = [
  "\\blive\\b",
  "\\bin\\s+progress\\b",
  "\\binn?in?gs\\b",
  "\\bneed(s|ed|ing)?\\b",
  "\\brequire(s|d)?\\b",
  "\\bchas(e|ing)\\b",
  "\\btarget\\b",
  "\\bopted\\s+to\\b",
  "\\belected\\s+to\\b",
  "\\bchose\\s+to\\b",
  "\\btoss\\b",
  "\\bbatting\\b",
  "\\bbowling\\b",
  "\\bstumps\\b",
  "\\brain\\b",
  "\\bbad\\s+light\\b",
  "\\blunch\\b",
  "\\btea\\b",
  "\\bdrinks\\b",
  "\\btimeout\\b",
  "\\bstrategic\\b",
  "\\bbreak\\b",
  "\\bsession\\b",
  "\\bday\\s+\\d",
  "\\bovers?\\s+remaining\\b",
  "\\bplay\\s+(resumed|suspended|stopped|in\\s+progress)\\b",
];

const PRE_MATCH_PATTERNS = [
  "\\bpreview\\b",
  "\\bupcoming\\b",
  "\\bscheduled\\b",
  "\\bstarts?\\s+at\\b",
  "\\bmatch\\s+starts\\b",
  "\\byet\\s+to\\s+(begin|start)\\b",
  "\\bnot\\s+started\\b",
  "\\btbc\\b",
  "\\btba\\b",
];

const compile = (patterns) => patterns.map((p) => new RegExp(p, "i"));

const TERMINAL_RE = compile(TERMINAL_PATTERNS);
const IN_PROGRESS_RE = compile(IN_PROGRESS_PATTERNS);
const PRE_MATCH_RE = compile(PRE_MATCH_PATTERNS);

/**
 * "TERMINAL" | "IN_PROGRESS" | "PRE_MATCH", or null when nothing matches.
 *
 * Null is a real answer and must not be folded into a concrete state here: an unrecognised
 * phrasing is how a wording change becomes invisible. Callers decide what it means for them — the
 * Live tab treats it as live, which is where an unknown match should surface rather than vanishing
 * from every tab.
 */
export function classifyStatus(status) {
  if (status === null || status === undefined) return null;
  const text = String(status).trim();
  if (!text) return null;
  if (TERMINAL_RE.some((re) => re.test(text))) return "TERMINAL";
  if (IN_PROGRESS_RE.some((re) => re.test(text))) return "IN_PROGRESS";
  if (PRE_MATCH_RE.some((re) => re.test(text))) return "PRE_MATCH";
  return null;
}
