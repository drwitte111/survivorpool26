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

### Staying signed in

Firebase Auth uses `Persistence.LOCAL`, so a login sticks on that device until the
person taps **Log Out** on the Account page. Restoring the session is asynchronous,
so `<html>` starts with an `auth-pending` class that hides both gates behind a
splash; `app.js` clears it on the first auth callback (with an 8s failsafe) so a
signed-in person never sees the login form flash on launch.

This is a per-device convenience, not a security boundary: anyone who picks up an
unlocked phone with the app installed is already signed in. That is the normal
trade for a home-screen app, but it's why the pool holds nothing sensitive.

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
| Season year, lock timing, week count | `data/config.json` |

`schedule.csv` columns are `week,away,home,kickoff_utc,is_mnf`. Team names must match
the `name` column in `teams.csv` exactly. Kickoffs are UTC ISO timestamps.

Spreads, over/unders and results are **not** in these files — a league admin sets
them in the app and they're stored in Firestore under `schedule/week{n}`, so every
league sees the same numbers.

### Pulling lines from ESPN

The spread editor has a **Fetch lines from ESPN** button that fills in every game's
spread, over/under and kickoff time. It's a button rather than an automatic sync on
purpose: lines move during the week, and shifting them under people mid-week would
change the board without anyone asking.

Two public ESPN endpoints, no API key and no account — `site.api.espn.com/.../scoreboard`
for the slate, `sports.core.api.espn.com/.../odds` for each line. Both send CORS
headers, so the browser calls them directly with no proxy. ESPN's `spread` field
already uses the same convention as `homeSpread` (negative = home favoured), so
nothing is sign-flipped on the way in. Games are matched by ESPN's team abbreviation
against the `espn_abbr` column in `teams.csv`.

These are undocumented endpoints. If ESPN ever changes them the button reports the
failure and the fields stay hand-editable, so the pool never depends on them. The
over/under is display-only — it's shown on each matchup and used as the placeholder
on the MNF tiebreaker, but nothing scores off it.

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
