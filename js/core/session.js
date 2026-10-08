// Loading a signed-in user's state, and starting (or restarting) the board once
// they're in a league. enterApp() is also what runs after someone creates or
// joins a league mid-session.
import { store, normalizeState } from './state.js';
import { loadUserState } from './firebase.js';
import { applyTeamTheme } from './theme.js';
import { getActiveWeekByDate, seedDefaultSchedule } from './schedule.js';
import { syncToLeague } from './league.js';
import { saveState } from './persist.js';
import { refreshWeek } from './refresh.js';
import { isAdmin } from './roles.js';
import { checkAndPostWeeklyRecaps } from './commissioner.js';
import { render, setSyncStatus } from '../ui/router.js';
import { updateSeasonRank } from '../ui/standings.js';
import { maybeShowProfileGate } from '../ui/onboarding.js';
import { updateUnreadBadges } from '../ui/trashtalk.js';

const LOAD_RETRY_MAX_MS = 30000;

export async function loadState(){
  const uid = store.currentUser.uid;
  // A failed read is retried, never treated as an empty account -- see
  // loadUserState. Backs off up to every 30s until it gets through.
  let loaded;
  for(let attempt = 0; ; attempt++){
    try{
      loaded = await loadUserState(uid);
      break;
    }catch(e){
      console.error('loadUserState failed', e);
      if(!store.currentUser || store.currentUser.uid !== uid) return; // signed out meanwhile
      setSyncStatus('Couldn’t load your picks — retrying…');
      await new Promise(r => setTimeout(r, Math.min(LOAD_RETRY_MAX_MS, 2000 * 2 ** attempt)));
      if(!store.currentUser || store.currentUser.uid !== uid) return;
    }
  }
  setSyncStatus('');
  if(loaded) store.state = loaded;
  normalizeState();

  // Admin is the fixed email list in roles.js, nothing else. Overwrite whatever
  // was persisted -- an old user doc may still carry isLeagueAdmin: true from the
  // retired "first to join claims admin" rule.
  store.state.account.isLeagueAdmin = isAdmin();
  (store.state.leagues || []).forEach(l => { l.isAdmin = isAdmin(); });

  if(!store.state.account.leagueSlug){
    document.getElementById('leagueGate').style.display = 'flex';
    return; // App init resumes in enterApp(), called once the gate is passed.
  }
  document.getElementById('leagueGate').style.display = 'none';
  await enterApp();
}

export async function enterApp(){
  applyTeamTheme(store.state.account.favTeam);
  store.currentWeek = getActiveWeekByDate();
  render();

  if(seedDefaultSchedule()) render();

  // New (or half-set-up) member: block the board until they're on the leaderboard.
  maybeShowProfileGate();

  // A first-load refresh can fill in live scores and ESPN lines, and auto-fill
  // any locked game left blank. Paint it, and write it -- an auto-filled pick
  // that only ever exists in memory scores nothing.
  if(await refreshWeek(store.currentWeek)){ render(); saveState(); }
  syncToLeague().catch(() => {});
  updateSeasonRank().catch(() => {});
  checkAndPostWeeklyRecaps().catch(() => {});
  updateUnreadBadges().catch(() => {});
}
