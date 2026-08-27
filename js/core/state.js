// The app's mutable state, gathered into two objects instead of a dozen loose
// globals. `store` is persisted data; `ui` is throwaway view state that never
// leaves the page.

export const store = {
  // weeks[n] = { games: [ {id, away, home, isMNF, pick, confidence, actualWinner, ...} ],
  //              mnfActualTotal, submitted, lockTeam }
  state: newState(),
  currentWeek: 1,
  currentUser: null,
};

export const ui = {
  accountFormDirty: false,
  spreadEditMode: false,
  showIncompleteWarning: false,
  resultsEditMode: false,
  standingsFilter: 'overall',
};

export function newAccount(){
  return {
    profilePic: null, teamName: '', yourName: '', favTeam: '',
    leagueSlug: null, leagueName: '', isLeagueAdmin: false,
    leagueAdminSecret: null, leagueJoinedAt: null, superBowlPick: null,
  };
}

export function newState(){
  return { weeks: {}, account: newAccount(), leagues: [], leagueData: {}, leagueProfiles: {} };
}

export function emptyWeek(){
  return { games: [], mnfActualTotal: null, submitted: false, lockTeam: null };
}

/** Week n, created on demand. Use when you're about to write to it. */
export function getWeek(n){
  if(!store.state.weeks[n]) store.state.weeks[n] = emptyWeek();
  return store.state.weeks[n];
}

/** Week n, or a throwaway blank. Use for read-only access. */
export function peekWeek(n){
  return store.state.weeks[n] || { games: [], submitted: false, lockTeam: null };
}

export function gameId(){
  return 'g' + Math.random().toString(36).slice(2, 9);
}

/** Fills in anything a stored state doc is missing, in place. */
export function normalizeState(){
  const s = store.state;
  if(!s.account) s.account = newAccount();
  if(!s.weeks) s.weeks = {};
  if(!s.leagues) s.leagues = [];
  if(!s.leagueData) s.leagueData = {};
  if(!s.leagueProfiles) s.leagueProfiles = {};
  if(s.account.leagueSlug && !s.leagues.some(l => l.slug === s.account.leagueSlug)){
    s.leagues.push({
      slug: s.account.leagueSlug,
      name: s.account.leagueName,
      isAdmin: s.account.isLeagueAdmin,
    });
  }
  if(s.account.leagueSlug === undefined) s.account.leagueSlug = null;
  if(s.account.isLeagueAdmin === undefined) s.account.isLeagueAdmin = false;
  if(s.account.superBowlPick === undefined) s.account.superBowlPick = null;
}
