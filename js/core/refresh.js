// One way to bring a week up to date, used by every caller so the ordering is
// always the same.
//
// Three sources, cheapest and least authoritative first:
//
//   1. ESPN scores   -- live/final scores, and grades completed games.
//   2. ESPN odds     -- fills in spread and over/under where nothing is set yet.
//   3. League doc    -- whatever the admin published, which overwrites both.
//
// The order is the point. Everyone sees real numbers without an admin lifting a
// finger, and an admin who publishes still has the last word.
import { CONFIG, TOTAL_WEEKS } from './data.js';
import { getWeek } from './state.js';
import { syncWeekScores, fetchWeekOdds } from './espn.js';
import { ensureSpreadsLoaded } from './league.js';
import { isGameLocked } from './locks.js';
import { autoFillAllWeeks } from './autofill.js';

// Odds cost one request per game, so unlike scores they aren't worth pulling on
// every poll, so it runs on a timer instead -- by default once an hour while
// someone has the app open, plus straight away if anything has no line at all.
//
// This used to only fill blanks and skip entirely once every game had a number,
// which meant spreads were pulled once and then never updated again. Lines move
// all week; leaving them frozen is worse than the mid-week shift that gate was
// trying to avoid.
const oddsCheckedAt = new Map();

function oddsRefreshMs(){
  return (CONFIG && CONFIG.oddsRefreshMinutes ? CONFIG.oddsRefreshMinutes : 60) * 60 * 1000;
}

async function refreshOdds(n, week){
  // A game that has kicked off keeps the line it closed at -- that's what people
  // were picking against, so it must not move afterwards.
  const live = week.games.filter(g => !isGameLocked(g));
  if(!live.length) return 0;

  const anyMissing = live.some(g => g.homeSpread == null || g.overUnder == null);
  const now = Date.now();
  const last = oddsCheckedAt.get(n) || 0;
  // A last-checked stamp in the future means the device clock moved backwards
  // (a correction, a timezone change, a phone waking up wrong). Treat it as
  // stale rather than letting it block refreshes until the clock catches up.
  const since = last > now ? Infinity : now - last;

  // A plain interval is enough. Each pick records the line it was made against
  // (see spreadForPick in ui/week.js), so nothing depends on catching the exact
  // number a game happened to close at.
  if(!anyMissing && since < oddsRefreshMs()) return 0;
  oddsCheckedAt.set(n, Date.now());

  const { games } = await fetchWeekOdds(n, CONFIG.seasonYear);
  let changed = 0;
  games.forEach(row => {
    const game = week.games.find(g => g.away === row.away && g.home === row.home);
    if(!game || isGameLocked(game)) return;      // closing line stays put
    if(row.homeSpread != null && game.homeSpread !== row.homeSpread){
      game.homeSpread = row.homeSpread; changed++;
    }
    if(row.overUnder != null && game.overUnder !== row.overUnder){
      game.overUnder = row.overUnder; changed++;
    }
  });

  // "Checked" and "changed" are different questions. Record both: the first
  // answers "are these current?", which is what the picks page needs to show.
  // An admin-published number is restored right after this by
  // ensureSpreadsLoaded, so nothing here can override a published line.
  const stamp = new Date().toISOString();
  week.oddsCheckedAt = stamp;
  if(changed){
    week.oddsUpdatedAt = stamp;
    week.oddsSource = 'espn';
  }
  return changed;
}

/**
 * Records the spread and over/under each game had when it locked.
 *
 * `homeSpread` already stops moving at kickoff, but keeping an explicit copy
 * means the number people actually picked against is preserved as its own fact
 * -- it survives a later edit, an admin republishing, or any future change to
 * how live spreads are handled. Written once and never overwritten.
 */
function captureClosingLines(week){
  let captured = 0;
  week.games.forEach(g => {
    if(!isGameLocked(g)) return;
    if(g.closingSpread == null && g.homeSpread != null){
      g.closingSpread = g.homeSpread;
      g.closingLineAt = g.closingLineAt || new Date().toISOString();
      captured++;
    }
    if(g.closingOverUnder == null && g.overUnder != null){
      g.closingOverUnder = g.overUnder;
      captured++;
    }
  });
  return captured;
}

// Not the same question as scoring.js's isWeekFullyGraded, which also counts a
// game that simply hasn't kicked off yet as "not graded" -- exactly right for
// deciding whether a week's score is final, and exactly wrong here, where it
// would mean re-fetching every week still in the future, forever. This only
// cares about games that HAVE kicked off: a week is settled once each of those
// either has a winner or ESPN has marked it final. The gameState check (rather
// than actualWinner alone) matters for a tie: a completed tie never gets an
// actualWinner by design, so relying on that alone would re-check a tied week
// forever.
function isWeekSettled(week){
  return week.games.every(g => !isGameLocked(g) || g.actualWinner || g.gameState === 'post');
}

/**
 * Every game in the week has actually kicked off AND been decided -- unlike
 * isWeekSettled above (which only asks about games that HAVE kicked off, so a
 * week that hasn't started yet trivially "passes"), this is false for a week
 * that's still upcoming or still in progress. For deciding whether there's a
 * finished week worth writing a recap about (core/commissioner.js), not for
 * deciding whether refreshWeek has anything left to check.
 */
export function isWeekFinished(week){
  return week.games.length > 0 && week.games.every(g => isGameLocked(g) && (g.actualWinner || g.gameState === 'post'));
}

/**
 * Grades any OTHER week that still has a kicked-off game with no result.
 *
 * refreshWeek only ever pulls ESPN scores and an admin's publish for the one
 * week it's called with -- so a week nobody has reopened since its games
 * finished never gets re-checked by either source, and its local actualWinner
 * sits at null indefinitely. That's what left some members' weekly points,
 * picks and Survivor result frozen mid-game even though they kept using the
 * app every week for whatever week was current: Survivor and season totals are
 * computed from each person's OWN local copy of every past week (see
 * syncToLeague), so a stale week1 on their device is a wrong week1 on the
 * standings for everyone, forever, until something re-grades it there.
 *
 * Cheap in steady state: a week stops being checked at all the moment
 * isWeekSettled(week) is true, so this only ever costs anything for the
 * handful of weeks still settling -- and never touches a week that's simply
 * still in the future.
 */
async function catchUpStaleWeeks(skip){
  let changed = 0;
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    if(n === skip) continue;
    const week = getWeek(n);
    if(!week.games.length || isWeekSettled(week)) continue;
    try{
      changed += await syncWeekScores(n, CONFIG.seasonYear, week);
    }catch(e){
      console.warn('catch-up ESPN sync failed for week', n, e.message);
    }
    try{
      changed += await ensureSpreadsLoaded(n);
    }catch(e){
      console.warn('catch-up publish sync failed for week', n, e.message);
    }
  }
  return changed;
}

/**
 * Refreshes week n in place. Returns true if anything visible changed, so
 * callers can skip a pointless re-render and save.
 */
export async function refreshWeek(n){
  const week = getWeek(n);
  let changed = 0;

  if(week.games.length){
    try{
      changed += await syncWeekScores(n, CONFIG.seasonYear, week);
    }catch(e){
      // ESPN being unreachable must never stop the league data from loading.
      console.warn('ESPN score sync failed', e.message);
    }
    try{
      changed += await refreshOdds(n, week);
    }catch(e){
      console.warn('ESPN odds sync failed', e.message);
    }
    // Runs regardless of whether a fetch happened -- a game can lock between
    // polls, and its line has to be frozen the moment it does.
    changed += captureClosingLines(week);
  }

  changed += await ensureSpreadsLoaded(n);

  // Every other week that isn't done grading yet -- see catchUpStaleWeeks.
  try{
    changed += await catchUpStaleWeeks(n);
  }catch(e){
    console.warn('stale-week catch-up sweep failed', e.message);
  }

  // Last, so it fills against the final picture: scores in, lines frozen, and
  // whatever the admin published applied. Every week rather than just this one
  // -- a week nobody opened is exactly the one with blanks in it -- and every
  // caller of refreshWeek goes through here, so boot, a week change and the
  // background poll all cover it.
  changed += autoFillAllWeeks();

  return changed > 0;
}
