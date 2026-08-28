// Loading a signed-in user's state, and starting (or restarting) the board once
// they're in a league. enterApp() is also what runs after someone creates or
// joins a league mid-session.
import { store, normalizeState } from './state.js';
import { loadUserState } from './firebase.js';
import { applyTeamTheme } from './theme.js';
import { getActiveWeekByDate, seedDefaultSchedule } from './schedule.js';
import { syncToLeague } from './league.js';
import { refreshWeek } from './refresh.js';
import { isAdmin } from './roles.js';
import { render } from '../ui/router.js';
import { updateSeasonRank } from '../ui/standings.js';

export async function loadState(){
  const loaded = await loadUserState(store.currentUser.uid);
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

  const hasAnyGames = Object.values(store.state.weeks).some(w => w.games && w.games.length);
  if(!hasAnyGames){
    seedDefaultSchedule();
    render();
  }
  // A first-load refresh can fill in live scores and ESPN lines; paint them.
  if(await refreshWeek(store.currentWeek)) render();
  syncToLeague().catch(() => {});
  updateSeasonRank().catch(() => {});
}
