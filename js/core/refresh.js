// One way to bring a week up to date, used by every caller so the ordering is
// always the same.
//
// Order matters. ESPN goes first and fills in scores and automatic grades; the
// league's own Firestore document goes second so anything an admin corrected by
// hand overwrites what ESPN said. A game ESPN got wrong stays fixed.
import { CONFIG } from './data.js';
import { getWeek } from './state.js';
import { syncWeekScores } from './espn.js';
import { ensureSpreadsLoaded } from './league.js';

/**
 * Refreshes week n in place. Returns true if any score or result changed, so
 * callers can skip a pointless re-render and save.
 */
export async function refreshWeek(n){
  const week = getWeek(n);
  let changed = 0;

  if(week.games.length){
    try{
      changed = await syncWeekScores(n, CONFIG.seasonYear, week);
    }catch(e){
      // ESPN being unreachable must never stop the league data from loading.
      console.warn('ESPN score sync failed', e.message);
    }
  }

  await ensureSpreadsLoaded(n);
  return changed > 0;
}
