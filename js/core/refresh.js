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
import { CONFIG } from './data.js';
import { getWeek } from './state.js';
import { syncWeekScores, fetchWeekOdds } from './espn.js';
import { ensureSpreadsLoaded } from './league.js';
import { isGameLocked } from './locks.js';

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

  await ensureSpreadsLoaded(n);
  return changed > 0;
}
