// Seeds the board from data/schedule.csv and works out which week is "now".
import { DEFAULT_SCHEDULE, WEEK_DATES, TOTAL_WEEKS } from './data.js';
import { getWeek, gameId } from './state.js';
import { saveState } from './persist.js';

export function getActiveWeekByDate(){
  const now = new Date();
  for(let n=1;n<=TOTAL_WEEKS;n++){
    const [s,e] = WEEK_DATES[n];
    const start = new Date(s+'T00:00:00Z');
    const end = new Date(e+'T23:59:59Z');
    if(now >= start && now <= end) return n;
  }
  if(now < new Date(WEEK_DATES[1][0]+'T00:00:00Z')) return 1;
  return TOTAL_WEEKS;
}

/**
 * Fills in any week that has no games yet, without clobbering existing picks.
 * Runs on entry so the board is populated before any admin spreads load.
 */
export function seedDefaultSchedule(){
  Object.keys(DEFAULT_SCHEDULE).forEach(wk => {
    const week = getWeek(parseInt(wk));
    if(week.games.length) return; // don't clobber anything already there
    week.games = DEFAULT_SCHEDULE[wk].map(({ away, home, kickoff, isMNF }) => ({
      id: gameId(), away, home, kickoff, isMNF,
      pick: null, confidence: null, actualWinner: null, tiebreakGuess: null,
      homeSpread: null, overUnder: null, liveAway: null, liveHome: null,
      gameState: 'pre', statusDetail: null
    }));
  });
  saveState();
}
