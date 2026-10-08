// Week-size regression tests. Runs in CI after check.mjs.
//
// Loads the real core modules in Node with a fake clock, a fetch that serves
// data/ from disk (and a canned ESPN scoreboard), and a stub Firestore -- so it
// exercises the same code the browser runs. Mostly about bye weeks: weeks 5-14
// have fewer than 16 games, so point values, auto-fill, Survivor choices and
// grading must all follow the slate's real size rather than assume 16.
//
// Dependency-free, like check.mjs: node tools/test.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import(pathToFileURL(join(ROOT, p)).href);

// ---------- fakes ----------
const RealDate = Date;
let NOW = RealDate.parse('2026-10-08T15:00:00Z');
const setNow = (iso) => { NOW = RealDate.parse(iso); };
globalThis.Date = class extends RealDate {
  constructor(...a){ if(a.length === 0) super(NOW); else super(...a); }
  static now(){ return NOW; }
};

const espnBoard = {};   // week -> scoreboard events
globalThis.fetch = async (url) => {
  url = String(url);
  if(url.startsWith('data/')){
    const text = readFileSync(join(ROOT, url), 'utf8');
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  }
  if(url.includes('scoreboard')){
    const wk = Number(new URL(url).searchParams.get('week'));
    return { ok: true, status: 200, json: async () => ({ events: espnBoard[wk] || [] }) };
  }
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};

const docRef = (path) => ({
  id: path.split('/').pop(),
  get: async () => ({ exists: false, data: () => undefined }),
  set: async () => {}, delete: async () => {},
  collection: (c) => col(path + '/' + c),
});
const col = (path) => ({ doc: (id) => docRef(path + '/' + id), get: async () => ({ forEach(){} }) });
globalThis.firebase = {
  initializeApp(){},
  firestore: () => ({ collection: col, enablePersistence: async () => {} }),
  auth: Object.assign(() => ({ setPersistence: async () => {} }), { Auth: { Persistence: { LOCAL: 'local' } } }),
};

// ---------- boot ----------
const data = await mod('js/core/data.js');
await data.loadAppData();
(await mod('js/core/firebase.js')).initFirebase();

const state = await mod('js/core/state.js');
const sched = await mod('js/core/schedule.js');
const scoring = await mod('js/core/scoring.js');
const autofill = await mod('js/core/autofill.js');
const locks = await mod('js/core/locks.js');
const survivor = await mod('js/core/survivor.js');
const reconcile = await mod('js/core/reconcile.js');
const league = await mod('js/core/league.js');
const teams = await mod('js/core/teams.js');
const espn = await mod('js/core/espn.js');

let passed = 0, failed = 0;
async function test(name, fn){
  try{ await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch(e){ failed++; console.error(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
function freshSeason(){ state.store.state = state.newState(); sched.seedDefaultSchedule(); }
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const sorted = (a) => a.slice().sort((x, y) => x - y);

// Derived from the CSV, so this can't drift from the data it checks.
const sizes = {};
Object.entries(data.DEFAULT_SCHEDULE).forEach(([n, g]) => { sizes[n] = g.length; });

console.log('\nSchedule');
await test('every team plays once a week at most and 17 times in all', () => {
  const total = {};
  Object.entries(data.DEFAULT_SCHEDULE).forEach(([n, games]) => {
    const seen = new Set();
    games.forEach(g => [g.away, g.home].forEach(t => {
      assert.ok(data.TEAM_LIST.includes(t), `week ${n}: unknown team ${t}`);
      assert.ok(!seen.has(t), `week ${n}: ${t} plays twice`);
      seen.add(t); total[t] = (total[t] || 0) + 1;
    }));
  });
  data.TEAM_LIST.forEach(t => assert.equal(total[t], 17, t));
});
await test('each week has exactly one MNF game, and it kicks off last', () => {
  Object.entries(data.DEFAULT_SCHEDULE).forEach(([n, games]) => {
    const mnf = games.filter(g => g.isMNF);
    assert.equal(mnf.length, 1, `week ${n}`);
    assert.ok(games.every(g => g === mnf[0] || g.kickoff < mnf[0].kickoff), `week ${n}`);
  });
});
await test('bye weeks really are short (week 5 = 15 games)', () => {
  assert.equal(sizes[5], 15);
  assert.ok(Object.values(sizes).some(n => n < 15));
});

console.log('\nSeeding');
await test('seeding gives each week its own game count', () => {
  freshSeason();
  Object.entries(sizes).forEach(([n, c]) => assert.equal(state.peekWeek(+n).games.length, c, `week ${n}`));
});
await test('seeding fills a missing week without touching weeks already there', () => {
  freshSeason();
  const wk1 = state.getWeek(1); wk1.games[0].pick = 'home';
  delete state.store.state.weeks[5];
  assert.equal(sched.seedDefaultSchedule(), 1);
  assert.equal(state.peekWeek(5).games.length, 15);
  assert.equal(state.peekWeek(1).games[0].pick, 'home');
  assert.equal(sched.seedDefaultSchedule(), 0);
});
await test('Oct 8 2026 is week 5', () => {
  setNow('2026-10-08T15:00:00Z');
  assert.equal(sched.getActiveWeekByDate(), 5);
});

console.log('\nConfidence points');
await test('a short week offers points 1..N, not 1..16', () => {
  freshSeason();
  Object.entries(sizes).forEach(([n, c]) => assert.equal(scoring.maxPointsFor(state.peekWeek(+n)), c));
});
await test('reordering keeps every bye week a clean 1..N', () => {
  freshSeason(); setNow('2026-09-01T12:00:00Z');
  Object.entries(sizes).forEach(([n, c]) => {
    const w = state.getWeek(+n);
    w.games.forEach((g, i) => { g.confidence = i + 1; });
    for(let k = 0; k < 100; k++){
      assert.ok(scoring.assignConfidence(w.games, w.games[k % c], 1 + (k * 7) % c).ok);
    }
    assert.deepEqual(sorted(w.games.map(g => g.confidence)), range(c), `week ${n}`);
  });
});
await test('filling blanks one at a time never goes above N', () => {
  freshSeason(); setNow('2026-10-06T12:00:00Z');
  const w = state.getWeek(5);
  w.games.forEach(g => scoring.assignConfidence(w.games, g, 15));
  assert.deepEqual(sorted(w.games.map(g => g.confidence)), range(15));
});
await test('a locked game in a short week stays a fixed post', () => {
  freshSeason(); setNow('2026-10-09T12:00:00Z');   // TNF has kicked off
  const w = state.getWeek(5);
  w.games.forEach((g, i) => { g.confidence = i + 1; });
  const tnf = w.games[0];
  const canMove = (g) => !locks.isGameLocked(g);
  assert.equal(scoring.canShiftTo(w, w.games[5], tnf.confidence, canMove), false);
  assert.ok(scoring.assignConfidence(w.games, w.games[14], 3, canMove).ok);
  assert.equal(tnf.confidence, 1);
  assert.deepEqual(sorted(w.games.map(g => g.confidence)), range(15));
});

console.log('\nAuto-fill');
await test('a blank week 5 fills only kicked-off games, from 1 up', () => {
  freshSeason(); setNow('2026-10-12T12:00:00Z');    // after SNF, before MNF
  const w = state.getWeek(5);
  autofill.autoFillWeek(w);
  assert.deepEqual(sorted(w.games.filter(g => g.confidence != null).map(g => g.confidence)), range(14));
  assert.equal(w.games.find(g => g.isMNF).confidence, null);
});
await test('a finished blank week uses exactly 1..N', () => {
  freshSeason(); setNow('2027-02-01T12:00:00Z');
  autofill.autoFillAllWeeks();
  Object.entries(sizes).forEach(([n, c]) =>
    assert.deepEqual(sorted(state.peekWeek(+n).games.map(g => g.confidence)), range(c), `week ${n}`));
});

console.log('\nSurvivor');
await test('teams on bye are not offered', () => {
  freshSeason(); setNow('2026-10-06T12:00:00Z');
  const names = survivor.getSurvivorChoices(5).games.flatMap(g => g.teams.map(t => t.name));
  assert.equal(names.length, 30);
  ['Carolina Panthers', 'Kansas City Chiefs'].forEach(t => {
    assert.ok(!names.includes(t), t);
    assert.match(survivor.survivorPickError(5, t), /isn.t one of this week/);
  });
});
await test('auto-lock in a bye week takes the last game', () => {
  freshSeason(); setNow('2026-10-14T12:00:00Z');
  assert.equal(autofill.autoFillSurvivorWeek(5), 1);
  assert.equal(state.peekWeek(5).lockTeam, 'Los Angeles Rams');
});

console.log('\nGrading');
await test('a perfect 15-game week scores 120', () => {
  freshSeason();
  const w = state.getWeek(5);
  w.games.forEach((g, i) => { g.pick = 'home'; g.confidence = i + 1; g.actualWinner = 'home'; });
  assert.equal(scoring.weekScore(w).earned, 120);
  assert.ok(scoring.isPerfectWeek(w));
});
await test('other members are graded on a 15-game week too', () => {
  freshSeason();
  const w = state.getWeek(5);
  const picks = { 5: {} };
  w.games.forEach((g, i) => { g.actualWinner = 'home'; picks[5][league.gamePickKey(g)] = { p: 'home', c: i + 1, s: null }; });
  assert.equal(reconcile.weeklyPointsFromPicks(picks).weeklyPoints[5], 120);
});
await test('ESPN scores match every game in week 5', async () => {
  freshSeason();
  const w = state.getWeek(5);
  const abbr = (n) => teams.getTeamAbbr(n).toUpperCase();
  espnBoard[5] = w.games.map((g, i) => ({ id: 'e' + i, date: g.kickoff, competitions: [{
    status: { type: { state: 'post', completed: true, shortDetail: 'Final' } },
    competitors: [
      { homeAway: 'home', team: { abbreviation: abbr(g.home) }, score: '24', winner: true },
      { homeAway: 'away', team: { abbreviation: abbr(g.away) }, score: '17', winner: false },
    ] }] }));
  assert.equal(await espn.syncWeekScores(5, 2026, w), 15);
  assert.ok(w.games.every(g => g.actualWinner === 'home'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
