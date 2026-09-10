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
import { withTimeout } from './net.js';
import { store, getWeek, peekWeek } from './state.js';
import { saveState } from './persist.js';
import { TOTAL_WEEKS } from './data.js';
import { isGameLocked, isSuperBowlPickLocked, gameLockTime } from './locks.js';
import { weekScore, spreadForPick } from './scoring.js';
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

// Cleanup reads the whole members collection, so it must not run on every sync
// -- syncToLeague fires on each save. It only has to happen when the id this
// account writes under could have changed: once per session, and after a rename.
let cleanupDoneFor = null;

function cleanupNeeded(){
  const signature = `${store.state.account.leagueSlug}|${slugifyTeam(store.state.account.teamName)}`;
  if(cleanupDoneFor === signature) return false;
  cleanupDoneFor = signature;
  return true;
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
    const docSnap = await withTimeout(
      db.collection('schedule').doc('week' + n).get(), undefined, 'Loading spreads');
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
      // The final score travels with the result. Grading is against the
      // spread, so a published winner on its own isn't enough to grade a
      // game -- without the score every client would have to have reached
      // ESPN itself for the same numbers.
      g.awayScore = r.awayScore != null ? r.awayScore : null;
      g.homeScore = r.homeScore != null ? r.homeScore : null;
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
      // Closing lines are write-once: the first value recorded is the one that
      // stands, whether it came from this device or the admin's publish.
      if(local.closingSpread == null && gs.closingSpread != null) local.closingSpread = gs.closingSpread;
      if(local.closingOverUnder == null && gs.closingOverUnder != null) local.closingOverUnder = gs.closingOverUnder;
      if(gs.kickoff) local.kickoff = gs.kickoff;
      if(gs.isMNF !== undefined) local.isMNF = gs.isMNF;
      if(gs.actualWinner){
        local.actualWinner = gs.actualWinner;
        // Published finals win over whatever this device last pulled from
        // ESPN, so everyone grades the same game off the same score.
        if(gs.awayScore != null) local.liveAway = gs.awayScore;
        if(gs.homeScore != null) local.liveHome = gs.homeScore;
      }
    }
  });
  if(data.mnfFinalScore != null) week.mnfActualTotal = data.mnfFinalScore;

  // When an admin last published spreads for this week. Takes precedence over a
  // local ESPN fill if it's newer -- published numbers are the shared truth.
  if(data.updatedAt && (!week.oddsUpdatedAt || data.updatedAt > week.oddsUpdatedAt)){
    week.oddsUpdatedAt = data.updatedAt;
    week.oddsSource = 'published';
    week.oddsUpdatedBy = data.updatedBy || null;
  }
}

export async function getLeagueMeta(slug){
  try{
    const docSnap = await withTimeout(
      db.collection('leagues').doc(slug).get(), undefined, 'Loading league');
    if(docSnap.exists) return docSnap.data();
  }catch(e){ console.error('getLeagueMeta failed', e); }
  return null;
}

/**
 * Flags a member as playing for money (or clears the flag).
 *
 * Kept on the league document, keyed by member doc id. It can't live on the
 * member row: syncToLeague writes that row wholesale on every save, so the flag
 * would survive until the member next touched a pick and then vanish. Keying by
 * doc id rather than team name means a rename doesn't lose it.
 *
 * Read-modify-write of a map this small is fine -- only an admin can call it,
 * and only when someone's status actually changes.
 */
export async function setPlaysForMoney(memberKey, on){
  const slug = store.state.account.leagueSlug;
  if(!slug) throw new Error('No active league');
  const ref = db.collection('leagues').doc(slug);
  const snap = await withTimeout(ref.get(), undefined, 'Loading league');
  const map = { ...((snap.exists && snap.data().playsForMoney) || {}) };
  if(on) map[memberKey] = true; else delete map[memberKey];
  await ref.set({ playsForMoney: map }, { merge: true });
  return map;
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
    // Written as soon as a pick is made, not at kickoff. Holding them back
    // meant a pick only ever reached the league if that member happened to open
    // the app again after the game locked -- pick on Tuesday, don't come back,
    // and the board showed you as having skipped the week.
    //
    // Each pick carries the moment it opens up (`lockAt`), and the grid draws
    // nobody else's until that passes. Be honest about what that is: it's the
    // UI declining to show it, not the server refusing to hand it over. Anyone
    // signed in can read this document directly. That's the same footing as the
    // rest of the app -- the sign-in password ships in the page (firebase.js),
    // so anyone with a member's email can already sign in as them -- but if
    // these ever need sealing properly, the fix is a Firestore rule comparing
    // request.time against lockAt, which is why the field is written now.
    const picks = {};
    for(let n = 1; n <= TOTAL_WEEKS; n++){
      const week = peekWeek(n);
      if(!week.games.length) continue;
      const weekPicks = {};
      week.games.forEach(g => {
        if(!g.pick && g.confidence == null) return;
        // `s` is the line this pick was locked at. It has to travel with the
        // pick: take a team at -3 and someone else takes it at -3.5 an hour
        // later and you are not on the same bet, so the grid can't grade
        // anyone else's chip off the number sitting in your own state.
        weekPicks[gamePickKey(g)] = {
          p: g.pick || null,
          c: g.confidence ?? null,
          s: spreadForPick(g),
          // When this pick becomes everyone's business. Null -- no kickoff time
          // set yet -- reads as "not yet", so the grid fails closed.
          lockAt: gameLockTime(g) ? gameLockTime(g).toISOString() : null,
        };
      });
      if(Object.keys(weekPicks).length) picks[n] = weekPicks;
    }

    // Survivor picks per week, for the grid's Survivor view. Written on the
    // same terms as the confidence picks above, and carrying the same lockAt so
    // the grid can hold each one back until its team has kicked off.
    const locks = {};
    for(let n = 1; n <= TOTAL_WEEKS; n++){
      const w = peekWeek(n);
      if(!w.lockTeam || !w.games.length) continue;
      const lockGame = w.games.find(g =>
        teamAbbrEquals(g.away, w.lockTeam) || teamAbbrEquals(g.home, w.lockTeam));
      if(!lockGame) continue;
      const side = teamAbbrEquals(lockGame.away, w.lockTeam) ? 'away' : 'home';
      locks[n] = {
        team: w.lockTeam,
        // null while the game is in progress; 'win' or 'loss' once graded.
        result: lockGame.actualWinner ? (lockGame.actualWinner === side ? 'win' : 'loss') : null,
        lockAt: gameLockTime(lockGame) ? gameLockTime(lockGame).toISOString() : null,
      };
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
      // Shown on the admin roster so an admin can identify and, if needed, reset
      // or remove the right account. Anyone signed in can already read every
      // member row, and knowing an email is enough to sign in as that person
      // anyway, so this exposes nothing the login model didn't already.
      email: (store.currentUser && store.currentUser.email) || null,
      weeklyPoints, total,
      tiebreakGuesses,
      submittedWeeks,
      survivorAlive: survivor.alive,
      survivorStrikes: survivor.strikes,
      survivorEliminatedWeek: survivor.eliminatedWeek,
      survivorEliminatedTeam: survivor.eliminatedTeam,
      currentLockWeek: store.currentWeek,
      currentLockTeam: currentLock,
      superBowlPick: isSuperBowlPickLocked() ? (store.state.account.superBowlPick || null) : null,
      picks,
      locks,
      // Recorded so a row can always be traced back to the account that wrote
      // it, no matter how many times the team gets renamed.
      uid: store.currentUser ? store.currentUser.uid : null,
      joinedAt: store.state.account.leagueJoinedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    rememberMemberDocId();
    await ref.set(payload);
    // A rename (or the move off the old team-name keying) leaves an orphan row.
    // Guarded, because this scans every member and syncToLeague runs on save.
    if(cleanupNeeded()) await removeStaleMemberDocs(ref.id);
  }catch(e){ console.error('league sync failed', e); }
}

/**
 * Admin-only: removes a member from the pool. Deletes their roster row and,
 * where the rules allow it, their saved picks/profile at users/{uid} so a
 * re-join starts clean.
 *
 * Their Firebase sign-in account is left alone -- a static app can't delete
 * another person's auth user. Pair this with sendResetEmail() when the reason
 * they're being removed is that they can't get in.
 */
export async function removeMemberAccount(memberKey, uid){
  if(!isAdmin()) throw new Error('Admins only');
  const slug = store.state.account.leagueSlug;
  if(!slug) throw new Error('No active league');
  await db.collection('leagues').doc(slug).collection('members').doc(memberKey).delete();
  if(uid){
    try{
      await db.collection('users').doc(uid).delete();
    }catch(e){
      // firestore.rules may not grant admins delete on users/{uid} yet -- the
      // roster removal still stands; their stored picks just linger until they
      // overwrite them on a fresh join.
      console.warn('could not delete user doc', e && e.message);
    }
  }
}

/**
 * The league roster. Throws on failure rather than returning an empty array --
 * "couldn't load" and "nobody has joined" look identical otherwise, and the
 * caller needs to tell them apart to offer a retry.
 */
export async function fetchLeagueTeams(){
  const teams = [];
  if(!store.state.account.leagueSlug) return teams;
  try{
    const snap = await withTimeout(
      db.collection('leagues').doc(store.state.account.leagueSlug).collection('members').get(),
      undefined, 'Loading roster');
    snap.forEach(docSnap => { teams.push({ key: docSnap.id, ...docSnap.data() }); });
  }catch(e){
    console.error('fetchLeagueTeams failed', e);
    throw e;
  }
  return teams;
}

