// Filling in what somebody didn't.
//
// A game that kicks off with no pick on it used to score nothing, and a week
// nobody touched scored zero across the board -- which ends someone's interest
// in the season by about Week 4. The house rule now: once a game locks, an
// empty pick becomes the home team, and an empty points value becomes the
// lowest number still unused that week.
//
// Three properties matter here, and the whole design follows from them:
//
//   Deterministic -- every device must fill an abandoned week identically, or
//     two people's copies of the standings disagree. So the order is kickoff
//     time, then game id, never array order or "whatever we saw first".
//
//   Idempotent -- this runs on boot and on every poll. Running it twice must
//     change nothing the second time.
//
//   Never touches an open game -- only games that have already kicked off, so
//     nobody is ever auto-filled out of a choice they could still make.
import { TOTAL_WEEKS } from './data.js';
import { peekWeek } from './state.js';
import { isGameLocked } from './locks.js';
import { teamAbbrEquals } from './teams.js';
import { getUsedLockTeams, getSurvivorStatus } from './survivor.js';

/**
 * Fills the blanks on every locked game in one week.
 *
 * Pick and points are handled independently -- a game can easily have one
 * without the other -- and each filled field is flagged so the board can say it
 * wasn't chosen.
 *
 * Returns the number of fields filled.
 */
export function autoFillWeek(week){
  if(!week || !week.games || !week.games.length) return 0;

  const locked = week.games.filter(g => isGameLocked(g));
  if(!locked.length) return 0;

  // Same order on every device, whatever order the games arrived in.
  const order = locked.slice().sort((a, b) => {
    const ka = Date.parse(a.kickoff) || 0;
    const kb = Date.parse(b.kickoff) || 0;
    if(ka !== kb) return ka - kb;
    return String(a.id).localeCompare(String(b.id));
  });

  // Taken across the whole week, not just the locked part: a value sitting on a
  // game that hasn't kicked off yet is still spoken for.
  const used = new Set(week.games.map(g => g.confidence).filter(v => v != null));
  const maxPoints = week.games.length;
  let next = 1;
  const lowestFree = () => {
    while(next <= maxPoints && used.has(next)) next++;
    return next <= maxPoints ? next : null;
  };

  let filled = 0;
  order.forEach(game => {
    if(!game.pick){
      game.pick = 'home';
      game.autoPick = true;
      // Judged against the line it closed at, the same as any other pick made
      // at that moment.
      if(game.pickedSpread == null){
        game.pickedSpread = game.closingSpread ?? game.homeSpread ?? null;
        game.pickedOverUnder = game.closingOverUnder ?? game.overUnder ?? null;
      }
      filled++;
    }
    if(game.confidence == null){
      const value = lowestFree();
      if(value != null){
        game.confidence = value;
        used.add(value);
        game.autoPoints = true;
        filled++;
      }
    }
  });

  return filled;
}

/**
 * Locks in a Survivor pick for someone who never made one.
 *
 * Only at the last possible moment: it waits until every game that still had a
 * team you could use has kicked off. Up to that point the choice is yours, and
 * firing early would take it away while you could still act.
 *
 * The pick comes from the last of those games -- the final chance you had. If
 * both its teams were still available to you it takes the home side; otherwise
 * there's only one team left to take and it takes that one.
 *
 * Does nothing if you already picked, if you'd used every team playing that
 * week, or for a week after you were already eliminated.
 *
 * Returns 1 if it locked something, 0 otherwise.
 */
export function autoFillSurvivorWeek(n){
  const week = peekWeek(n);
  if(!week || !week.games || !week.games.length) return 0;
  if(week.lockTeam) return 0;                       // they made a pick

  // A week after the season ended for them has nothing to decide.
  const status = getSurvivorStatus();
  if(status.eliminatedWeek != null && n > status.eliminatedWeek) return 0;

  const usedElsewhere = getUsedLockTeams(n);
  const available = (name) => !usedElsewhere.some(u => teamAbbrEquals(u.team, name));

  // Games that could ever have served as this week's pick.
  const usable = week.games.filter(g => available(g.away) || available(g.home));
  if(!usable.length) return 0;                      // every team already spent

  // Still time to choose for themselves.
  if(usable.some(g => !isGameLocked(g))) return 0;

  // The last chance they had. Ordered the same way everywhere else is, so two
  // devices resolve an identical week identically.
  const last = usable.slice().sort((a, b) => {
    const ka = Date.parse(a.kickoff) || 0;
    const kb = Date.parse(b.kickoff) || 0;
    if(ka !== kb) return ka - kb;
    return String(a.id).localeCompare(String(b.id));
  }).pop();

  // Home when both were open to them; otherwise whichever one was left.
  week.lockTeam = available(last.home) ? last.home : last.away;
  week.autoLock = true;
  return 1;
}

/**
 * Every week, not just the one on screen.
 *
 * A week that was never opened is exactly the one that needs this, so it can't
 * be limited to the current week. It's pure local arithmetic over state already
 * in memory, so running it across all 18 costs nothing worth measuring.
 *
 * Returns the number of fields filled.
 */
export function autoFillAllWeeks(){
  let filled = 0;
  // Ascending, and Survivor after the picks: auto-locking week 3 can be the
  // loss that eliminates someone, and week 4 has to see that when it decides
  // whether there's still a season to pick for.
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    filled += autoFillWeek(peekWeek(n));
    filled += autoFillSurvivorWeek(n);
  }
  return filled;
}

/** True if anything in this week was filled in rather than chosen. */
export function weekHasAutoFills(week){
  return !!week && !!week.games && week.games.some(g => g.autoPick || g.autoPoints);
}
