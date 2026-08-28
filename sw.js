// Service worker: makes the board load instantly on a phone and survive a bad
// signal. Deliberately conservative -- it only ever caches this origin's own
// GET requests. Firebase traffic (auth, Firestore) is cross-origin and never
// touched, so live league data always goes to the network.

const VERSION = 'v6';
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

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
];

self.addEventListener('install', (event) => {
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
