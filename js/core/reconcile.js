// Recomputes a member's weekly points, season total and Survivor status from
// ground truth that's already reliable, instead of trusting the summary
// fields syncToLeague also publishes.
//
// Those summary fields (weeklyPoints, total, survivorAlive, survivorStrikes,
// ...) are computed by that MEMBER'S OWN device, from ITS local copy of every
// week -- and that copy only ever gets refreshed for whichever week is
// "current" on that device (see catchUpStaleWeeks in core/refresh.js for the
// underlying fix, which corrects this at the source over time). A member who
// locked a Week 1 pick and moved on to Week 4 can have a perfectly current
// device and still be publishing a stale Week 1 summary, because nothing on
// their end ever told it to look back -- which is exactly what left someone
// showing 0 points for a week Group Picks shows they won, or "Alive" after a
// Survivor loss nobody's re-graded on their end.
//
// The fix here sidesteps waiting on that device entirely: a member's raw
// picks and Survivor locks (core/league.js) publish the moment they're made,
// so they're reliable immediately. Pair those with the VIEWING device's own
// local copy of each week -- which is exactly as fresh as catchUpStaleWeeks
// has made it -- and any up-to-date viewer can correctly grade EVERYONE's
// week, regardless of whose device is behind. This is the same trick
// ui/picks.js's confidence grid already uses per pick chip; this extends it
// to the season-level summaries shown on Standings and the Survivor grid.
import { store, getWeek } from './state.js';
import { TOTAL_WEEKS } from './data.js';
import { teamAbbrEquals } from './teams.js';
import { gradedWinner, sharedSpread } from './scoring.js';
import { gamePickKey } from './league.js';
import { STRIKES_ALLOWED } from './survivor.js';

/** A member's weeklyPoints/total, recomputed from their published raw picks. */
export function weeklyPointsFromPicks(picks){
  const weeklyPoints = {};
  let total = 0;
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const week = getWeek(n);
    if(!week.games.length) continue;
    const weekPicks = (picks && picks[n]) || {};
    let earned = 0;
    week.games.forEach(g => {
      const entry = weekPicks[gamePickKey(g)];
      if(!entry || !entry.p) return;
      // Graded on the line THIS pick was locked at, falling back to the
      // league's shared line for a pick synced before that was recorded --
      // never to the viewer's own line, which may not even be the same pick.
      const line = entry.s != null ? entry.s : sharedSpread(g);
      const winner = gradedWinner(g, line);
      if(winner && entry.p === winner) earned += (entry.c || 0);
    });
    weeklyPoints[n] = earned;
    total += earned;
  }
  return { weeklyPoints, total };
}

/**
 * A member's Survivor status, recomputed from their published locks.
 *
 * `resultsByWeek` is returned alongside strikes/alive so a caller drawing a
 * per-week grid (ui/picks.js) doesn't have to re-derive the same thing twice.
 */
export function survivorStatusFromLocks(locks){
  const losses = [];
  const resultsByWeek = {};
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const lock = locks && locks[n];
    if(!lock || !lock.team) continue;
    const week = getWeek(n);
    if(!week.games.length) continue;
    const game = week.games.find(g => teamAbbrEquals(g.away, lock.team) || teamAbbrEquals(g.home, lock.team));
    if(!game || !game.actualWinner) continue; // not decided yet on this device
    const side = teamAbbrEquals(game.away, lock.team) ? 'away' : 'home';
    const result = game.actualWinner === side ? 'win' : 'loss';
    resultsByWeek[n] = result;
    if(result === 'loss'){
      losses.push({ week: n, team: lock.team });
      if(losses.length >= STRIKES_ALLOWED){
        return { alive: false, strikes: losses.length, eliminatedWeek: n, eliminatedTeam: lock.team, resultsByWeek };
      }
    }
  }
  return { alive: true, strikes: losses.length, eliminatedWeek: null, eliminatedTeam: null, resultsByWeek };
}

/**
 * The team a still-alive member has locked for the CURRENT week (the
 * viewer's own `store.currentWeek`, not whatever week the member's own device
 * last considered current), or null if there's nothing to show -- no lock,
 * not visible yet, or already eliminated. This replaces trusting the
 * published currentLockTeam/currentLockWeek, which is exactly the pair that
 * was staying pinned to Week 1 on a member's row long after everyone had
 * moved on: it's set from that device's own idea of "current", which stops
 * updating the moment nobody opens the app.
 */
export function currentLockFor(locks){
  const lock = locks && locks[store.currentWeek];
  if(!lock || !lock.team || !lock.lockAt) return null;
  const at = new Date(lock.lockAt);
  if(isNaN(at.getTime()) || new Date() < at) return null; // not public yet -- privacy
  return lock.team;
}

/**
 * A member row with weeklyPoints/total/survivor fields replaced by freshly
 * recomputed ones. Everything else on the row (teamName, uid, email, picks,
 * locks, ...) passes through unchanged.
 */
export function reconcileMember(member){
  const { weeklyPoints, total } = weeklyPointsFromPicks(member.picks);
  const survivor = survivorStatusFromLocks(member.locks);
  return {
    ...member,
    weeklyPoints,
    total,
    survivorAlive: survivor.alive,
    survivorStrikes: survivor.strikes,
    survivorEliminatedWeek: survivor.eliminatedWeek,
    survivorEliminatedTeam: survivor.eliminatedTeam,
    currentLockWeek: store.currentWeek,
    currentLockTeam: survivor.alive ? currentLockFor(member.locks) : null,
  };
}
