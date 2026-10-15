# Bouncer match archive

Every match the Bouncer app has followed: its ball-by-ball commentary (written by Bouncer: rewritten
or generated from each delivery's facts, never a copy of another site's text), the final scorecard,
the match context and summary, and the win-probability log. Read by the app once a match's rows have
left its live database. Updated every three hours.

- `idx/years.json`: `{year: {month: count}}`
- `idx/m/YYYY-MM.json`: `[id, date, format, gender, team1, team2, result, series, venue]`, newest first
- `m/<id>.json`: one match; `final` once it has ended and settled
