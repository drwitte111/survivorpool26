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

// Odds cost one request per game, so unlike scores they aren't worth pulling on
// every poll. Only fetch when something is actually missing, and at most once
// per week per this interval.
const ODDS_RETRY_MS = 10 * 60 * 1000;
const oddsCheckedAt = new Map();

async function fillMissingOdds(n, week){
  const missing = week.games.some(g => g.homeSpread == null || g.overUnder == null);
  if(!missing) return 0;

  const last = oddsCheckedAt.get(n) || 0;
  if(Date.now() - last < ODDS_RETRY_MS) return 0;
  oddsCheckedAt.set(n, Date.now());

  const { games } = await fetchWeekOdds(n, CONFIG.seasonYear);
  let filled = 0;
  games.forEach(row => {
    const game = week.games.find(g => g.away === row.away && g.home === row.home);
    if(!game) return;
    // Only ever fill a blank. An admin's published number is never clobbered,
    // and neither is a line that's already been shown to everyone.
    if(game.homeSpread == null && row.homeSpread != null){ game.homeSpread = row.homeSpread; filled++; }
    if(game.overUnder == null && row.overUnder != null){ game.overUnder = row.overUnder; filled++; }
  });

  // Only stamp the week if numbers actually changed. A fetch that found nothing
  // new shouldn't make the board claim it just refreshed.
  if(filled){
    week.oddsUpdatedAt = new Date().toISOString();
    week.oddsSource = 'espn';
  }
  return filled;
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
      changed += await fillMissingOdds(n, week);
    }catch(e){
      console.warn('ESPN odds sync failed', e.message);
    }
  }

  await ensureSpreadsLoaded(n);
  return changed > 0;
}
