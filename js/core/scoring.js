// Confidence scoring, plus the weekly flourishes (MVP pick, perfect week,
// hot streak) that hang off it.
import { store, peekWeek } from './state.js';
import { TOTAL_WEEKS } from './data.js';

export function maxPointsFor(week){ return week.games.length; }

/**
 * The spread this pick is judged against: the line showing when it was made.
 * Falls back to what the game closed at, then to the current number, so picks
 * from before this was recorded still work.
 */
export function spreadForPick(game){
  return game.pickedSpread ?? game.closingSpread ?? game.homeSpread ?? null;
}

/** Both final scores, or null if this game hasn't got a usable pair. */
function finalScores(game){
  const away = game.liveAway, home = game.liveHome;
  if(away == null || home == null || isNaN(away) || isNaN(home)) return null;
  return { away, home };
}

/**
 * How `side` is doing against its number right now: 'cover' | 'no-cover' |
 * 'push', or null when there's no line or no score yet. Live, so it reads
 * off whatever is on the board at this moment.
 */
export function coverStatus(game, side){
  const spread = spreadForPick(game);
  if(spread == null) return null;
  const scores = finalScores(game);
  if(!scores) return null;
  const margin = side === 'home' ? (scores.home - scores.away) : (scores.away - scores.home);
  const spreadForSide = side === 'home' ? spread : -spread;
  const value = margin + spreadForSide;
  if(value > 0) return 'cover';
  if(value < 0) return 'no-cover';
  return 'push';
}

/**
 * The side a confidence pick is actually graded against: whoever beat the
 * spread, not whoever won the game. 'away' | 'home' | 'push' | null.
 *
 * This is the whole point of the board -- every pick is made on a number and
 * records the number it was made on, so a team that wins by less than it was
 * laying has not won you anything. Seattle -3.5 winning by 3 is a loss for
 * Seattle backers and a win for the other side.
 *
 * `actualWinner` (straight up, from ESPN or an admin) is still what says a
 * game is over: null there means in progress or tied, and both stay ungraded.
 * It's also the fallback when a game has no published line or no final score,
 * so a pool running without spreads keeps working exactly as it did.
 *
 * A push -- an exact tie against the number -- is graded but correct for
 * nobody, the same treatment a tied game gets.
 *
 * Survivor locks are deliberately not run through this: they're straight-up
 * by design (see core/survivor.js) and keep reading `actualWinner`.
 */
export function gradedWinner(game){
  if(!game.actualWinner) return null;
  const spread = spreadForPick(game);
  if(spread == null) return game.actualWinner;
  const scores = finalScores(game);
  if(!scores) return game.actualWinner;
  const margin = (scores.home - scores.away) + spread;   // home, against its number
  if(margin > 0) return 'home';
  if(margin < 0) return 'away';
  return 'push';
}

/** Whether this game counts towards a week's graded total. */
export function isGraded(game){ return gradedWinner(game) != null; }

/** Whether this game's pick beat the spread. False for a push and for no pick. */
export function isPickCorrect(game){
  const winner = gradedWinner(game);
  return !!game.pick && !!winner && game.pick === winner;
}

export function weekScore(week){
  let earned = 0, possible = 0, gradedCount = 0, correctCount = 0;
  week.games.forEach(g => {
    if(g.confidence) possible += g.confidence;
    if(isGraded(g)){
      gradedCount++;
      if(isPickCorrect(g)){ earned += (g.confidence||0); correctCount++; }
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
    if(isPickCorrect(g) && g.confidence){
      if(!best || g.confidence > best.confidence) best = g;
    }
  });
  return best;
}
export function isPerfectWeek(week){
  const s = weekScore(week);
  return s.total > 0 && s.gradedCount === s.total && s.correctCount === s.total;
}
export function isWeekFullyGraded(week){ return week.games.length > 0 && week.games.every(g => isGraded(g)); }
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

/** How many other games a move would renumber. Changes nothing. */
export function shiftCount(week, game, next, canMove = () => true){
  const copies = week.games.map(g => ({ ...g }));
  const target = copies.find(g => g.id === game.id);
  if(!target) return 0;
  const byId = new Map(week.games.map(g => [g.id, g]));
  const result = assignConfidence(copies, target, next, (g) => canMove(byId.get(g.id) || g));
  return result.ok ? result.moved.length : 0;
}
