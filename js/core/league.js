// Everything that talks to Firestore's shared collections.
//
// Two very different things live here:
//   * leagues/{slug}          -- a friend group: password, admin, member roster.
//   * schedule/week{n}        -- spreads, kickoff times and results. These are
//                                facts about real NFL games, not league-specific,
//                                so one admin sets them once and every league
//                                sees the same numbers.
//
// The league password is a shared secret, not real auth -- enough to keep a
// friend group's pool tidy, nothing more.
import { db, saveUserState } from './firebase.js';
import { store, getWeek, peekWeek } from './state.js';
import { saveState } from './persist.js';
import { TOTAL_WEEKS } from './data.js';
import { isGameLocked, isSuperBowlPickLocked } from './locks.js';
import { weekScore } from './scoring.js';
import { getSurvivorStatus } from './survivor.js';
import { teamAbbrEquals, getTeamAbbr } from './teams.js';
import { isAdmin } from './roles.js';

// Stable id for a matchup, used as the key for synced picks. Team abbreviations
// rather than names so a display-name tweak can't orphan everyone's picks.
export function gamePickKey(game){
  const away = getTeamAbbr(game.away) || slugifyTeam(game.away);
  const home = getTeamAbbr(game.home) || slugifyTeam(game.home);
  return `${away}@${home}`;
}

export function slugifyTeam(name){
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'team';
}

// Your roster entry is keyed by Firebase uid, which never changes.
//
// It used to be keyed by slugifyTeam(teamName). Renaming your team therefore
// wrote to a brand new document and left the old one behind, so the standings
// showed you twice -- a rename looked like a second person joining. Keying on
// uid makes a rename just an edit to the same row.
export function leagueMemberDocRef(){
  const uid = store.currentUser && store.currentUser.uid;
  if(!store.state.account.leagueSlug || !uid) return null;
  return db.collection('leagues').doc(store.state.account.leagueSlug)
    .collection('members').doc(uid);
}

// Every document id this account has written in the current league. Used to
// clear up rows left behind by the old team-name keying, including ones written
// before this change existed.
function rememberMemberDocId(){
  const slug = store.state.account.leagueSlug;
  if(!slug) return [];
  if(!store.state.leagueMemberKeys) store.state.leagueMemberKeys = {};
  const seen = store.state.leagueMemberKeys[slug] || (store.state.leagueMemberKeys[slug] = []);
  // The id the old scheme would have used for the name currently on the account.
  const legacyId = slugifyTeam(store.state.account.teamName);
  if(legacyId && !seen.includes(legacyId)) seen.push(legacyId);
  return seen;
}

// Deletes roster rows this account left behind under a previous id.
async function removeStaleMemberDocs(currentId){
  const slug = store.state.account.leagueSlug;
  const uid = store.currentUser && store.currentUser.uid;
  if(!slug || !uid) return;
  const seen = rememberMemberDocId();
  try{
    const col = db.collection('leagues').doc(slug).collection('members');
    const snap = await col.get();
    const doomed = [];
    snap.forEach(docSnap => {
      if(docSnap.id === currentId) return;
      const data = docSnap.data() || {};
      // Ours if it carries our uid, or -- for rows written before uid was
      // recorded -- if it sits under a team-name id this account has used.
      if(data.uid === uid || (!data.uid && seen.includes(docSnap.id))){
        doomed.push(docSnap.ref.delete());
      }
    });
    await Promise.all(doomed);
  }catch(e){ console.error('stale member cleanup failed', e); }
}

export async function loadGlobalSpreads(n){
  try{
    const docSnap = await db.collection('schedule').doc('week' + n).get();
    if(docSnap.exists) return docSnap.data();
  }catch(e){ console.error('loadGlobalSpreads failed', e); }
  return null;
}

export async function saveGlobalSpreads(n, gamesArr){
  try{
    const existing = await loadGlobalSpreads(n);
    await db.collection('schedule').doc('week' + n).set({
      games: gamesArr,
      mnfFinalScore: existing && existing.mnfFinalScore != null ? existing.mnfFinalScore : null,
      updatedAt: new Date().toISOString(),
      updatedBy: store.currentUser ? store.currentUser.email : null
    });
    return true;
  }catch(e){
    console.error('saveGlobalSpreads failed', e);
    return false;
  }
}

export async function saveGlobalResults(n, resultsArr, mnfFinalScore){
  try{
    const existing = await loadGlobalSpreads(n);
    const games = (existing && existing.games) ? existing.games.map(g => ({...g})) : [];
    resultsArr.forEach(r => {
      let g = games.find(x => x.away === r.away && x.home === r.home);
      if(!g){ g = { away: r.away, home: r.home }; games.push(g); }
      g.actualWinner = r.actualWinner;
    });
    await db.collection('schedule').doc('week' + n).set({
      games,
      mnfFinalScore: mnfFinalScore != null ? mnfFinalScore : null,
      updatedAt: new Date().toISOString(),
      updatedBy: store.currentUser ? store.currentUser.email : null
    });
    return true;
  }catch(e){
    console.error('saveGlobalResults failed', e);
    return false;
  }
}

// Merges admin-published spread/time/result data into this week's local game
// list (matching by team names), without touching anyone's picks. Always
// fetches fresh (no caching) since results can be entered/updated at any time
// after a week's spreads were first loaded.
export async function ensureSpreadsLoaded(n){
  const data = await loadGlobalSpreads(n);
  if(!data || !data.games) return;
  const week = getWeek(n);
  data.games.forEach(gs => {
    const local = week.games.find(g => g.away === gs.away && g.home === gs.home);
    if(local){
      local.homeSpread = gs.homeSpread != null ? gs.homeSpread : local.homeSpread;
      local.overUnder = gs.overUnder != null ? gs.overUnder : local.overUnder;
      if(gs.kickoff) local.kickoff = gs.kickoff;
      if(gs.isMNF !== undefined) local.isMNF = gs.isMNF;
      if(gs.actualWinner) local.actualWinner = gs.actualWinner;
    }
  });
  if(data.mnfFinalScore != null) week.mnfActualTotal = data.mnfFinalScore;
}

export async function getLeagueMeta(slug){
  try{
    const docSnap = await db.collection('leagues').doc(slug).get();
    if(docSnap.exists) return docSnap.data();
  }catch(e){ console.error('getLeagueMeta failed', e); }
  return null;
}

// Sets which league is currently active for this account.
// Admin is not league-specific -- it's the fixed email list in roles.js -- so
// this takes no admin argument and just re-derives the flag.
// Each league has its own completely separate set of picks/points/schedule.
// store.state.weeks always holds the CURRENTLY ACTIVE league's data (so all the
// existing pick/scoring code just keeps working against it unchanged);
// store.state.leagueData archives every OTHER league's data by slug.
// Each league has its own separate picks/points/schedule AND its own team name
// / display name -- so the same login can be "The Basement Boys" in one league
// and something else entirely in another. Favorite team (color theme) and
// profile picture stay shared across all leagues, since those are personal,
// not league-specific.
export function switchActiveLeague(slug, name){
  if(!store.state.leagueData) store.state.leagueData = {};
  if(!store.state.leagueProfiles) store.state.leagueProfiles = {};
  if(store.state.account.leagueSlug && store.state.account.leagueSlug !== slug){
    store.state.leagueData[store.state.account.leagueSlug] = store.state.weeks;
    store.state.leagueProfiles[store.state.account.leagueSlug] = {
      teamName: store.state.account.teamName,
      yourName: store.state.account.yourName
    };
  }
  store.state.weeks = store.state.leagueData[slug] ? store.state.leagueData[slug] : {};
  const profile = store.state.leagueProfiles[slug] || { teamName: '', yourName: '' };
  store.state.account.teamName = profile.teamName || '';
  store.state.account.yourName = profile.yourName || '';
  store.state.account.leagueSlug = slug;
  store.state.account.leagueName = name;
  store.state.account.isLeagueAdmin = isAdmin();
  store.state.account.leagueJoinedAt = new Date().toISOString();
}

// Adds (or updates) a league in the account's list of leagues it belongs to,
// so the person can switch back to it later without re-entering the password.
export function addToMyLeagues(slug, name){
  if(!store.state.leagues) store.state.leagues = [];
  const existingIdx = store.state.leagues.findIndex(l => l.slug === slug);
  const entry = { slug, name, isAdmin: isAdmin() };
  if(existingIdx >= 0) store.state.leagues[existingIdx] = entry;
  else store.state.leagues.push(entry);
}

// Creates a new league. The creator's uid is recorded for reference, but admin
// rights come only from the fixed email list in roles.js -- creating a league
// does not make you its admin.
export async function createLeague(name, password){
  const trimmedName = name.trim();
  if(!trimmedName) return { ok: false, error: 'Enter a league name.' };
  if(!password) return { ok: false, error: 'Choose a password.' };
  const slug = slugifyTeam(trimmedName);
  const existing = await getLeagueMeta(slug);
  if(existing){
    return { ok: false, error: 'A league with that name already exists. Use "Join a League" below instead.' };
  }
  const meta = {
    leagueName: trimmedName,
    password,
    creatorUid: store.currentUser ? store.currentUser.uid : null,
    createdAt: new Date().toISOString()
  };
  try{
    await db.collection('leagues').doc(slug).set(meta);
  }catch(e){
    console.error('createLeague failed', e);
    const detail = (e && e.message) ? e.message : 'unknown error';
    return { ok: false, error: 'Couldn\u2019t create the league right now (' + detail + ') \u2014 try again.' };
  }
  switchActiveLeague(slug, trimmedName);
  addToMyLeagues(slug, trimmedName);
  const saved = await saveUserState(store.currentUser.uid, store.state);
  if(!saved) return { ok: false, error: 'League was created, but saving it to your account failed \u2014 try refreshing and switching to it from Account.' };
  return { ok: true, created: true };
}

export async function joinLeague(name, password){
  const trimmedName = name.trim();
  if(!trimmedName) return { ok: false, error: 'Enter a league name.' };
  if(!password) return { ok: false, error: 'Enter a password.' };
  const slug = slugifyTeam(trimmedName);
  const existing = await getLeagueMeta(slug);
  if(!existing){
    return { ok: false, error: 'No league found with that name. Use "Create a League" above to start one.' };
  }
  if(existing.password !== password){
    return { ok: false, error: 'Incorrect password for that league.' };
  }
  // Joining never confers admin -- that's the fixed email list in roles.js.
  switchActiveLeague(slug, existing.leagueName);
  addToMyLeagues(slug, existing.leagueName);
  store.state.account.leagueJoinedAt = new Date().toISOString();
  saveState();
  const saved = await saveUserState(store.currentUser.uid, store.state);
  if(!saved) return { ok: false, error: 'Joined the league, but saving it to your account failed \u2014 try refreshing and switching to it from Account.' };
  return { ok: true };
}

export async function syncToLeague(){
  try{
    if(!store.state.account.teamName || !store.state.account.leagueSlug) return;
    const ref = leagueMemberDocRef();
    if(!ref) return;
    const weeklyPoints = {};
    const tiebreakGuesses = {};
    const submittedWeeks = [];
    let total = 0;
    for(let n=1;n<=TOTAL_WEEKS;n++){
      const week = peekWeek(n);
      if(!week.games.length) continue;
      const s = weekScore(week);
      weeklyPoints[n] = s.earned;
      total += s.earned;
      if(week.submitted) submittedWeeks.push(n);
      const mnfGame = week.games.find(g => g.isMNF);
      if(mnfGame && mnfGame.tiebreakGuess != null) tiebreakGuesses[n] = mnfGame.tiebreakGuess;
    }
    // Everyone's picks, for the group picks grid.
    //
    // A pick is only written once its own game has kicked off. This is the
    // privacy rule, and it has to live here rather than in the UI: the Firebase
    // config ships in the page, so anything written to Firestore is readable by
    // anyone signed in. Not writing it is the only way it's genuinely hidden.
    const picks = {};
    for(let n = 1; n <= TOTAL_WEEKS; n++){
      const week = peekWeek(n);
      if(!week.games.length) continue;
      const weekPicks = {};
      week.games.forEach(g => {
        if(!isGameLocked(g)) return;         // still in play -- stays private
        if(!g.pick && g.confidence == null) return;
        weekPicks[gamePickKey(g)] = { p: g.pick || null, c: g.confidence ?? null };
      });
      if(Object.keys(weekPicks).length) picks[n] = weekPicks;
    }

    const survivor = getSurvivorStatus();
    const curWeek = peekWeek(store.currentWeek);
    // Your Survivor pick stays hidden from the league until the team you locked
    // has actually kicked off -- no tipping your hand while it's still changeable.
    const lockGame = curWeek.lockTeam
      ? curWeek.games.find(g => teamAbbrEquals(g.away, curWeek.lockTeam) || teamAbbrEquals(g.home, curWeek.lockTeam))
      : null;
    const currentLock = (lockGame && isGameLocked(lockGame)) ? curWeek.lockTeam : null;
    const payload = {
      teamName: store.state.account.teamName,
      yourName: store.state.account.yourName || '',
      weeklyPoints, total,
      tiebreakGuesses,
      submittedWeeks,
      survivorAlive: survivor.alive,
      survivorEliminatedWeek: survivor.eliminatedWeek,
      survivorEliminatedTeam: survivor.eliminatedTeam,
      currentLockWeek: store.currentWeek,
      currentLockTeam: currentLock,
      superBowlPick: isSuperBowlPickLocked() ? (store.state.account.superBowlPick || null) : null,
      picks,
      // Recorded so a row can always be traced back to the account that wrote
      // it, no matter how many times the team gets renamed.
      uid: store.currentUser ? store.currentUser.uid : null,
      joinedAt: store.state.account.leagueJoinedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    rememberMemberDocId();
    await ref.set(payload);
    // A rename (or the move off the old team-name keying) leaves an orphan row.
    await removeStaleMemberDocs(ref.id);
  }catch(e){ console.error('league sync failed', e); }
}

export async function fetchLeagueTeams(){
  const teams = [];
  if(!store.state.account.leagueSlug) return teams;
  try{
    const snap = await db.collection('leagues').doc(store.state.account.leagueSlug).collection('members').get();
    snap.forEach(docSnap => { teams.push({ key: docSnap.id, ...docSnap.data() }); });
  }catch(e){ console.error('fetchLeagueTeams failed', e); }
  return teams;
}

