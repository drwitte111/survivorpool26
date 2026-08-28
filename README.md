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
  mobile.css          Loaded last. Every responsive and installed-app rule.
img/                header-bg.jpg -- the scoreboard backdrop. Was a 249 KB base64
                    data URI inside the stylesheet; now a cacheable file.
                    icon-*.png -- home-screen icons.
js/
  app.js              Entry point: loads data, boots Firebase, wires the DOM.
  core/               Logic with no DOM knowledge (plus the Firestore layer).
  ui/                 Rendering. One module per page/panel.
manifest.webmanifest  Makes it installable to a home screen.
sw.js                 Service worker: offline support and instant loads.
```

`index.html` loads `js/app.js` as an ES module; everything else is reached through
imports. There is nothing to compile or bundle.

## Installing it on a phone

The site is a PWA, so it installs to a home screen and runs without browser chrome.

- **Android / Chrome** — a install prompt appears, or ⋮ → *Add to Home screen*.
- **iOS / Safari** — Share → *Add to Home Screen*. (iOS only installs from Safari.)

Once installed it launches standalone, keeps its own colour on the status bar, and
paints under the notch — the CSS pads content back with `env(safe-area-inset-*)`.

### Offline

`sw.js` caches the app shell and everything in `data/` on first visit, so the board
opens and renders on a dead signal. Live league data (picks, standings, trash talk)
comes from Firestore and still needs a connection — the service worker never touches
cross-origin requests, so it can't serve stale league data.

**When you change a file, bump `VERSION` in `sw.js`.** Cached assets are keyed to it;
without a bump, returning visitors keep the old copy until their next reload. The page
reloads itself once when a new worker takes over.

## Responsive rules live in one file

All `@media` rules are in `css/mobile.css`, which loads after everything else.
Rules elsewhere were previously overriding each other — `sync.css` carried a
480px block that fought the layout. If you add a responsive rule, put it here,
and match the specificity of the rule you're overriding: several base styles use
`.title-block h1` or `.field input[type=email]`, which a bare `h1` or `input`
selector will never beat no matter how late it loads.

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
