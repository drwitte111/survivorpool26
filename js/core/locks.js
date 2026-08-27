// When a week opens for picks, and when each game closes.
//
// Locking is per game, not per week: a matchup closes at its own kickoff, so
// missing Thursday night doesn't cost you the rest of the slate. Submitting a
// lineup marks it done but never freezes it -- anything that hasn't kicked off
// stays editable.
import { CONFIG, WEEK_DATES } from './data.js';
import { peekWeek } from './state.js';

export function earliestKickoff(week){
  let earliest = null;
  week.games.forEach(g => {
    if(!g.kickoff) return;
    const d = new Date(g.kickoff);
    if(!earliest || d < earliest) earliest = d;
  });
  return earliest;
}

/** When a single game closes for edits. Null if it has no kickoff time yet. */
export function gameLockTime(game){
  if(!game || !game.kickoff) return null;
  const ko = new Date(game.kickoff);
  if(isNaN(ko.getTime())) return null;
  return new Date(ko.getTime() - CONFIG.pickLockMinutesBeforeKickoff * 60000);
}

export function isGameLocked(game){
  const lt = gameLockTime(game);
  if(!lt) return false; // no kickoff time set -> stays open
  return new Date() >= lt;
}

/** Games still open for edits, in slate order. */
export function openGames(week){
  return week.games.filter(g => !isGameLocked(g));
}

/** The whole week is closed only once every game has kicked off. */
export function isWeekFullyLocked(week){
  return week.games.length > 0 && week.games.every(isGameLocked);
}

/** The soonest upcoming lock, for the footer countdown. Null if none left. */
export function nextLockTime(week){
  const times = openGames(week).map(gameLockTime).filter(Boolean);
  if(!times.length) return null;
  return new Date(Math.min(...times.map(t => t.getTime())));
}

// The for-fun Super Bowl prediction locks when the season does -- at the first
// kickoff of Week 1.
export function superBowlLockTime(){
  return gameLockTime(earliestKickoffGame(peekWeek(1)));
}
export function isSuperBowlPickLocked(){
  const lt = superBowlLockTime();
  if(!lt) return false;
  return new Date() >= lt;
}

function earliestKickoffGame(week){
  let best = null;
  week.games.forEach(g => {
    if(!g.kickoff) return;
    if(!best || new Date(g.kickoff) < new Date(best.kickoff)) best = g;
  });
  return best;
}

// Lists what's still missing from a week's lineup, for the submit warning.
// Only counts games you can still act on -- nagging about a Thursday game that
// already kicked off is just noise.
export function getMissingItems(week){
  const missing = [];
  const open = openGames(week);
  const noPick = open.filter(g => g.pick == null).length;
  const noPts = open.filter(g => g.confidence == null).length;
  if(noPick) missing.push(`${noPick} team pick${noPick > 1 ? 's' : ''}`);
  if(noPts) missing.push(`${noPts} point value${noPts > 1 ? 's' : ''}`);
  const mnf = week.games.find(g => g.isMNF);
  if(mnf && !isGameLocked(mnf) && mnf.tiebreakGuess == null) missing.push('the tiebreaker guess');
  return missing;
}

/** True once everything still open has been filled in. */
export function isWeekComplete(week){
  if(!week.games.length) return false;
  const open = openGames(week);
  const allPicked = open.every(g => g.pick != null && g.confidence != null);
  const mnf = week.games.find(g => g.isMNF);
  const tiebreakFilled = !mnf || isGameLocked(mnf) || mnf.tiebreakGuess != null;
  return allPicked && tiebreakFilled;
}

// Each NFL week officially opens the Tuesday after the previous week's Monday
// Night Football, at 6:00 AM local time. Week 1 has no "previous week," so it's
// always open. WEEK_DATES[n][0] is the ESPN calendar boundary date, which lands
// on a Wednesday for weeks 2-18 -- the Tuesday just before that is the open date.
export function weekUnlockTime(n){
  if(n === 1) return null;
  const range = WEEK_DATES[n];
  if(!range) return null;
  const boundary = new Date(range[0] + 'T00:00:00');
  const unlock = new Date(boundary.getTime() - CONFIG.weekUnlockHoursBeforeStart * 60 * 60 * 1000);
  unlock.setHours(6, 0, 0, 0);
  return unlock;
}
export function isWeekOpen(n){
  const t = weekUnlockTime(n);
  return !t || new Date() >= t;
}
