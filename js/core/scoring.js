// Confidence scoring, plus the weekly flourishes (MVP pick, perfect week,
// hot streak) that hang off it.
import { store, peekWeek } from './state.js';
import { TOTAL_WEEKS } from './data.js';

export function maxPointsFor(week){ return week.games.length; }

export function weekScore(week){
  let earned = 0, possible = 0, gradedCount = 0, correctCount = 0;
  week.games.forEach(g => {
    if(g.confidence) possible += g.confidence;
    if(g.actualWinner){
      gradedCount++;
      if(g.pick && g.pick === g.actualWinner){ earned += (g.confidence||0); correctCount++; }
    }
  });
  return { earned, possible, gradedCount, correctCount, total: week.games.length };
}

export function seasonScore(){
  let earned = 0, possible = 0;
  Object.values(store.state.weeks).forEach(w => {
    const s = weekScore(w);
    earned += s.earned; possible += s.possible;
  });
  return { earned, possible };
}

export function getMvpPick(week){
  let best = null;
  week.games.forEach(g => {
    if(g.actualWinner && g.pick && g.pick === g.actualWinner && g.confidence){
      if(!best || g.confidence > best.confidence) best = g;
    }
  });
  return best;
}
export function isPerfectWeek(week){
  const s = weekScore(week);
  return s.total > 0 && s.gradedCount === s.total && s.correctCount === s.total;
}
export function isWeekFullyGraded(week){ return week.games.length > 0 && week.games.every(g => g.actualWinner); }
export function isWinningWeek(week){ const s = weekScore(week); return s.correctCount > (s.gradedCount - s.correctCount); }
export function computeHotStreak(){
  let n = TOTAL_WEEKS;
  while(n >= 1 && !isWeekFullyGraded(peekWeek(n))) n--;
  let streak = 0;
  while(n >= 1){
    const w = peekWeek(n);
    if(!isWeekFullyGraded(w) || !isWinningWeek(w)) break;
    streak++; n--;
  }
  return streak;
}


/**
 * Moves `game` to confidence value `next`, shifting the games in between by one
 * so the week stays a clean set of 1..N with no repeats and no new gaps.
 *
 * This is a ranked-list reorder, not a swap. Moving a game from 13 up to 16
 * pushes whatever held 16, 15 and 14 each down a step; the 13 it gave up is
 * absorbed at the bottom of that run, so everything is back to square.
 *
 * Pure, and told which games may move via `canMove`, so the locking rules stay
 * in the UI layer where they belong.
 *
 * Returns { ok, moved }. ok is false when the shift would have to renumber a
 * game that can't move, in which case nothing is changed at all.
 */
export function assignConfidence(games, game, next, canMove = () => true){
  const prev = game.confidence;
  if(next == null){ game.confidence = null; return { ok: true, moved: [] }; }
  if(next === prev) return { ok: true, moved: [] };

  const others = games.filter(g => g !== game);
  const used = new Set(others.filter(g => g.confidence != null).map(g => g.confidence));

  // The slot that frees up and absorbs the shift. Normally it's the value this
  // game gives up; if it didn't have one, the nearest unused number stands in.
  let hole = prev;
  if(hole == null){
    const max = games.length;
    let above = null, below = null;
    for(let v = next + 1; v <= max; v++) if(!used.has(v)){ above = v; break; }
    for(let v = next - 1; v >= 1; v--) if(!used.has(v)){ below = v; break; }
    if(above == null && below == null) hole = next;          // nothing to shift
    else if(above == null) hole = below;
    else if(below == null) hole = above;
    else hole = (above - next) <= (next - below) ? above : below;
  }

  // The run that has to move, and which way.
  const [from, to, delta] = next > hole
    ? [hole + 1, next, -1]      // moving up: the run above slides down a step
    : [next, hole - 1, +1];     // moving down: the run below slides up a step

  const affected = others.filter(g =>
    g.confidence != null && g.confidence >= from && g.confidence <= to);

  if(affected.some(g => !canMove(g))) return { ok: false, moved: [] };

  affected.forEach(g => { g.confidence += delta; });
  game.confidence = next;
  return { ok: true, moved: affected };
}


/** Whether assignConfidence would succeed, without changing anything. */
export function canShiftTo(week, game, next, canMove = () => true){
  const copies = week.games.map(g => ({ ...g }));
  const target = copies.find(g => g.id === game.id);
  if(!target) return false;
  const byId = new Map(week.games.map(g => [g.id, g]));
  return assignConfidence(copies, target, next, (g) => canMove(byId.get(g.id) || g)).ok;
}
