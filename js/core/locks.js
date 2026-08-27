// When a week opens for picks, and when it locks.
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
export function lockTimeFor(week){
  const ek = earliestKickoff(week);
  if(!ek) return null;
  return new Date(ek.getTime() - CONFIG.pickLockMinutesBeforeKickoff * 60000);
}
// The for-fun Super Bowl prediction locks at the exact same moment Week 1's
// regular picks lock -- 10 minutes before that week's first kickoff.
export function superBowlLockTime(){
  return lockTimeFor(peekWeek(1));
}
export function isSuperBowlPickLocked(){
  const lt = superBowlLockTime();
  if(!lt) return false;
  return new Date() >= lt;
}
export function isWeekLocked(week){
  if(week.submitted) return true;
  const lt = lockTimeFor(week);
  if(!lt) return false;
  return new Date() >= lt;
}

// True once every game has a team pick and a confidence value, and the MNF
// tiebreaker guess (if there's an MNF game) has been filled in.
// Lists what's still missing from a week's lineup, for the submit warning.
export function getMissingItems(week){
  const missing = [];
  const noPick = week.games.filter(g => g.pick == null).length;
  const noPts = week.games.filter(g => g.confidence == null).length;
  if(noPick) missing.push(`${noPick} team pick${noPick > 1 ? 's' : ''}`);
  if(noPts) missing.push(`${noPts} point value${noPts > 1 ? 's' : ''}`);
  const mnf = week.games.find(g => g.isMNF);
  if(mnf && mnf.tiebreakGuess == null) missing.push('the tiebreaker guess');
  return missing;
}

export function isWeekComplete(week){
  if(!week.games.length) return false;
  const allPicked = week.games.every(g => g.pick != null && g.confidence != null);
  const mnf = week.games.find(g => g.isMNF);
  const tiebreakFilled = !mnf || mnf.tiebreakGuess != null;
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
