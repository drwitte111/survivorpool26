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
import { teamAbbrEquals } from './teams.js';

export function slugifyTeam(name){
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'team';
}

export function leagueMemberDocRef(){
  if(!store.state.account.leagueSlug || !store.state.account.teamName) return null;
  return db.collection('leagues').doc(store.state.account.leagueSlug)
    .collection('members').doc(slugifyTeam(store.state.account.teamName));
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
// Each league has its own completely separate set of picks/points/schedule.
// store.state.weeks always holds the CURRENTLY ACTIVE league's data (so all the
// existing pick/scoring code just keeps working against it unchanged);
// store.state.leagueData archives every OTHER league's data by slug.
// Each league has its own separate picks/points/schedule AND its own team name
// / display name -- so the same login can be "The Basement Boys" in one league
// and something else entirely in another. Favorite team (color theme) and
// profile picture stay shared across all leagues, since those are personal,
// not league-specific.
export function switchActiveLeague(slug, name, isAdmin){
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
  store.state.account.isLeagueAdmin = isAdmin;
  store.state.account.leagueJoinedAt = new Date().toISOString();
}

// Adds (or updates) a league in the account's list of leagues it belongs to,
// so the person can switch back to it later without re-entering the password.
export function addToMyLeagues(slug, name, isAdmin){
  if(!store.state.leagues) store.state.leagues = [];
  const existingIdx = store.state.leagues.findIndex(l => l.slug === slug);
  const entry = { slug, name, isAdmin };
  if(existingIdx >= 0) store.state.leagues[existingIdx] = entry;
  else store.state.leagues.push(entry);
}

// Creates a new league. Whoever creates it becomes admin, tracked via a
// locally-stored secret token -- there's no real server-side auth here, just
// enough to keep a friend group's league organized.
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
  switchActiveLeague(slug, trimmedName, true);
  addToMyLeagues(slug, trimmedName, true);
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
  const uid = store.currentUser ? store.currentUser.uid : null;
  let isAdmin = !!(existing.creatorUid && uid && existing.creatorUid === uid);
  // Leagues created before login existed have no creatorUid on file. The first
  // person who joins one with the correct password claims admin -- knowing the
  // password is already the bar for entry, so this just recognizes whoever
  // originally set it up (most likely you, testing this exact scenario).
  if(!existing.creatorUid && uid){
    try{
      await db.collection('leagues').doc(slug).update({ creatorUid: uid });
      isAdmin = true;
    }catch(e){ console.error('admin claim failed', e); }
  }
  switchActiveLeague(slug, existing.leagueName, isAdmin);
  addToMyLeagues(slug, existing.leagueName, isAdmin);
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
      joinedAt: store.state.account.leagueJoinedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await ref.set(payload);
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

