// Service worker: makes the board load instantly on a phone and survive a bad
// signal. Deliberately conservative -- it only ever caches this origin's own
// GET requests. Firebase traffic (auth, Firestore) is cross-origin and never
// touched, so live league data always goes to the network.

// Stamped at deploy time with the commit SHA (see tools/stamp-build.mjs, wired
// up as the Netlify build command). Nobody edits this by hand.
//
// That matters for more than tidiness: this used to be a manual version bump on
// a single line, so two people changing anything in the same week collided here
// every single time.
//
// Left unstamped it still starts with '__', which puts the worker in dev mode:
// no precaching and every request goes to the network, so a local edit shows up
// on reload instead of being served from a stale cache.
const BUILD_ID = '__BUILD_ID__';
const IS_DEV = BUILD_ID.startsWith('__');

const SHELL = `shell-${BUILD_ID}`;
const DATA = `data-${BUILD_ID}`;

// Everything needed to render the board offline.
const SHELL_ASSETS = [
  './',
  'index.html',
  'css/base.css',
  'css/layout.css',
  'css/games.css',
  'css/sync.css',
  'css/survivor.css',
  'css/pages.css',
  'css/gate.css',
  'css/mobile.css',
  'js/app.js',
  'js/core/data.js',
  'js/core/espn.js',
  'js/core/refresh.js',
  'js/core/firebase.js',
  'js/core/league.js',
  'js/core/locks.js',
  'js/core/nflstats.js',
  'js/core/roles.js',
  'js/core/persist.js',
  'js/core/schedule.js',
  'js/core/scoring.js',
  'js/core/session.js',
  'js/core/state.js',
  'js/core/survivor.js',
  'js/core/teams.js',
  'js/core/theme.js',
  'js/ui/account.js',
  'js/ui/admin.js',
  'js/ui/dom.js',
  'js/ui/onboarding.js',
  'js/ui/research.js',
  'js/ui/router.js',
  'js/ui/rules.js',
  'js/ui/standings.js',
  'js/ui/trashtalk.js',
  'js/ui/week.js',
  'img/header-bg.jpg',
  'img/icon-192.png',
  'img/icon-512.png',
  'manifest.webmanifest',
];

// The /data files change between seasons, not between page loads.
const DATA_ASSETS = [
  'data/config.json',
  'data/teams.csv',
  'data/schedule.csv',
  'data/weeks.csv',
  'data/rules.json',
  'data/changelog.json',
];

self.addEventListener('install', (event) => {
  if(IS_DEV){ self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    // addAll is all-or-nothing; cache individually so one 404 can't break install.
    await Promise.all(SHELL_ASSETS.map(u => shell.add(u).catch(() => {})));
    const data = await caches.open(DATA);
    await Promise.all(DATA_ASSETS.map(u => data.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA]);
    const names = await caches.keys();
    await Promise.all(names.map(n => keep.has(n) ? null : caches.delete(n)));
    await self.clients.claim();
  })());
});

// Lets the page tell a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if(event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isData = (url) => url.pathname.includes('/data/');

self.addEventListener('fetch', (event) => {
  if(IS_DEV) return; // straight to the network while developing
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only our own origin. Firebase, Google Fonts and ESPN logos go straight out.
  if(url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell when the network is unavailable, so
  // opening from the home screen works on a dead signal.
  if(req.mode === 'navigate'){
    event.respondWith((async () => {
      try{
        return await fetch(req);
      }catch(e){
        const cached = await caches.match('index.html', { ignoreSearch: true });
        return cached || Response.error();
      }
    })());
    return;
  }

  // Data files: network first so a schedule fix lands, cache as the fallback.
  if(isData(url)){
    event.respondWith((async () => {
      try{
        const res = await fetch(req);
        if(res && res.ok) (await caches.open(DATA)).put(req, res.clone());
        return res;
      }catch(e){
        const cached = await caches.match(req, { ignoreSearch: true });
        if(cached) return cached;
        throw e;
      }
    })());
    return;
  }

  // Everything else (code, css, images): cache first, refresh in the background.
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    const network = fetch(req).then(res => {
      if(res && res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
