# Hungry Dawgs Run Faster — 2026 NFL Confidence Pool

A confidence-pool board with a survivor side-game, league standings and a trash-talk
feed. Static site, no build step: Netlify serves the repo root as-is.

## Layout

```
index.html          Markup only -- no inline CSS, no inline JS, no data.
data/               Everything that isn't code.
  config.json         League settings + Firebase project config.
  teams.csv           32 franchises: name, ESPN abbr, NFL code, team colors.
  schedule.csv        All 272 regular-season games, weeks 1-18.
  weeks.csv           ESPN calendar boundaries per week.
  rules.json          Rules-page copy.
css/                Stylesheets, split by concern, loaded in cascade order.
img/                header-bg.jpg -- the scoreboard backdrop. Was a 249 KB base64
                    data URI inside the stylesheet; now a cacheable file.
js/
  app.js              Entry point: loads data, boots Firebase, wires the DOM.
  core/               Logic with no DOM knowledge (plus the Firestore layer).
  ui/                 Rendering. One module per page/panel.
```

`index.html` loads `js/app.js` as an ES module; everything else is reached through
imports. There is nothing to compile or bundle.

## Editing the data

Most changes are data edits, not code edits:

| To change… | Edit |
|---|---|
| A kickoff time, matchup, or the MNF game | `data/schedule.csv` |
| Team colors or logo codes | `data/teams.csv` |
| Week open/close dates | `data/weeks.csv` |
| Rules wording | `data/rules.json` |
| Survivor bonus, lock timing, reaction emojis | `data/config.json` |

`schedule.csv` columns are `week,away,home,kickoff_utc,is_mnf`. Team names must match
the `name` column in `teams.csv` exactly. Kickoffs are UTC ISO timestamps.

Spreads and results are **not** in these files — one league admin enters them in the
app, and they're stored in Firestore under `schedule/week{n}` so every league sees the
same numbers.

## Modules

**core/**

| Module | Responsibility |
|---|---|
| `data.js` | Loads and parses everything in `data/`. Must run before anything else. |
| `firebase.js` | Firebase init; reads/writes personal state at `users/{uid}`. |
| `state.js` | The `store` (persisted) and `ui` (view-only) state objects. |
| `teams.js` | Team lookups: abbreviation, logo URL, colors. |
| `theme.js` | Recolors the board to the user's favorite team. |
| `locks.js` | When a week opens for picks and when it locks. |
| `survivor.js` | Weekly locks, used teams, alive/eliminated. |
| `scoring.js` | Confidence scoring, MVP pick, perfect week, hot streak. |
| `schedule.js` | Seeds the board from `schedule.csv`; picks the active week. |
| `league.js` | All shared Firestore collections: leagues, members, spreads, results. |
| `persist.js` | `saveState()` — kept tiny, since most modules call it. |
| `session.js` | `loadState()` / `enterApp()` — boot and post-league-join re-entry. |

**ui/** — `router.js` (pages, week picker, top-level `render()`), `week.js`,
`standings.js`, `account.js`, `trashtalk.js`, `rules.js`, `admin.js`, and `dom.js`
(shared formatting helpers).

## Running locally

```bash
npx http-server . -p 8181 -c-1
```

Then open <http://localhost:8181>. It must be served over HTTP — opening `index.html`
from the filesystem won't work, because ES modules and `fetch` need a real origin.

## A note on the league password

The league password is a shared secret checked in the client, not real access control.
It's enough to keep a friend group's pool tidy; it is not security. Firebase Auth
(email + password) is what actually gates accounts.
