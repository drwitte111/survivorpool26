// Confidence scoring, plus the weekly flourishes (MVP pick, perfect week,
// hot streak) that hang off it.
import { store, peekWeek } from './state.js';
import { TOTAL_WEEKS } from './data.js';

export function maxPointsFor(week){ return week.games.length; }

/**
 * The spread YOUR pick is judged against: the line showing when you made it.
 * Falls back to what the game closed at, then to the current number, so picks
 * from before this was recorded still work.
 *
 * `pickedSpread` is personal -- two people who took the same team an hour apart
 * can be holding different numbers, and each is graded on their own. So this is
 * only ever right for the game object in your own state. To grade somebody
 * else's pick, use the line published with it, falling back to sharedSpread().
 */
export function spreadForPick(game){
  return game.pickedSpread ?? game.closingSpread ?? game.homeSpread ?? null;
}

/**
 * The league-wide line for a game: what it closed at, else the number on the
 * board now. Never `pickedSpread`, which belongs to whoever's state this is.
 *
 * This is the fallback for grading another member's pick that was synced
 * before the line it was taken at was published alongside it.
 */
export function sharedSpread(game){
  return game.closingSpread ?? game.homeSpread ?? null;
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
 * `spread` defaults to the line on this game object, which is yours. Pass one
 * in to grade a pick somebody else locked at a different number.
 *
 * A push -- an exact tie against the number -- is graded but correct for
 * nobody, the same treatment a tied game gets.
 *
 * Survivor locks are deliberately not run through this: they're straight-up
 * by design (see core/survivor.js) and keep reading `actualWinner`.
 */
export function gradedWinner(game, spread = spreadForPick(game)){
  if(!game.actualWinner) return null;
  if(spread == null) return game.actualWinner;
  const scores = finalScores(game);
  if(!scores) return game.actualWinner;
  const margin = (scores.home - scores.away) + spread;   // home, against its number
  if(margin > 0) return 'home';
  if(margin < 0) return 'away';
  return 'push';
}

/** Whether this game counts towards a week's graded total. */
export function isGraded(game, spread = spreadForPick(game)){
  return gradedWinner(game, spread) != null;
}

/** Whether this game's pick beat the spread. False for a push and for no pick. */
export function isPickCorrect(game, spread = spreadForPick(game)){
  const winner = gradedWinner(game, spread);
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
 * An unmovable game (one that's already kicked off) keeps its number no
 * matter what -- but that number is a fixed POST the chain reroutes around,
 * not a wall the whole move crashes into. Used to be the latter: a single
 * locked game anywhere between the old and new value failed the entire
 * reassignment, which meant one Thursday-night pick could leave half the
 * week's point values permanently unreachable for everyone else, even though
 * none of those reassignments actually needed to touch it. The only thing
 * that's genuinely impossible is handing a locked game's own number to
 * someone else.
 *
 * Pure, and told which games may move via `canMove`, so the locking rules stay
 * in the UI layer where they belong.
 *
 * Returns { ok, moved }. ok is false only when `next` itself belongs to a
 * game that can't give it up, in which case nothing is changed at all.
 */
export function assignConfidence(games, game, next, canMove = () => true){
  const prev = game.confidence;
  if(next == null){ game.confidence = null; return { ok: true, moved: [] }; }
  if(next === prev) return { ok: true, moved: [] };

  const others = games.filter(g => g !== game);
  const lockedValues = new Set(
    others.filter(g => g.confidence != null && !canMove(g)).map(g => g.confidence));
  // A locked game's own number can never be handed to another game -- full stop.
  if(lockedValues.has(next)) return { ok: false, moved: [] };

  const used = new Set(others.filter(g => g.confidence != null).map(g => g.confidence));

  // A free number on a game that had none: just take it. Without this the
  // nearest-gap search below skipped `next` itself and shifted a neighbour
  // for no reason.
  if(prev == null && !used.has(next)){
    game.confidence = next;
    return { ok: true, moved: [] };
  }

  // The slot that frees up and absorbs the shift. Normally it's the value this
  // game gives up; if it didn't have one, the nearest unused number stands in.
  // Always a free (and therefore unlocked) number, never one a locked game
  // is sitting on.
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

  // The numbers between the hole and the target that are actually free to
  // carry a different game -- a locked game's number is skipped rather than
  // treated as part of the chain, so the chain steps around it instead of
  // stopping there.
  const lo = Math.min(next, hole), hi = Math.max(next, hole);
  const openSlots = [];
  for(let v = lo; v <= hi; v++) if(!lockedValues.has(v)) openSlots.push(v);
  const holeIdx = openSlots.indexOf(hole);
  const nextIdx = openSlots.indexOf(next);

  // Snapshot who's in each open slot before anything moves.
  const occupant = openSlots.map(v => others.find(g => g.confidence === v) || null);

  const moved = [];
  if(nextIdx > holeIdx){
    for(let i = holeIdx + 1; i <= nextIdx; i++){
      const g = occupant[i];
      if(g){ g.confidence = openSlots[i - 1]; moved.push(g); }
    }
  } else {
    for(let i = holeIdx - 1; i >= nextIdx; i--){
      const g = occupant[i];
      if(g){ g.confidence = openSlots[i + 1]; moved.push(g); }
    }
  }
  game.confidence = next;
  return { ok: true, moved };
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
