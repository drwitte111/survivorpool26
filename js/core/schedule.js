// Seeds the board from data/schedule.csv and works out which week is "now".
import { DEFAULT_SCHEDULE, WEEK_DATES, TOTAL_WEEKS } from './data.js';
import { getWeek, gameId } from './state.js';
import { zonedDateToUtc } from './tz.js';
import { saveState } from './persist.js';

export function getActiveWeekByDate(){
  const now = new Date();
  for(let n=1;n<=TOTAL_WEEKS;n++){
    const [s,e] = WEEK_DATES[n];
    // Boundaries on the league's clock. Using UTC midnight meant the board
    // rolled over to next week at about 8pm Eastern -- in the middle of Monday
    // Night Football.
    const start = zonedDateToUtc(s, 0, 0);
    const end = new Date(zonedDateToUtc(e, 0, 0).getTime() + 24 * 60 * 60 * 1000 - 1);
    if(now >= start && now <= end) return n;
  }
  if(now < zonedDateToUtc(WEEK_DATES[1][0], 0, 0)) return 1;
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
    week.oddsUpdatedAt = week.oddsUpdatedAt || null;
    week.oddsSource = week.oddsSource || null;
    week.games = DEFAULT_SCHEDULE[wk].map(({ away, home, kickoff, isMNF }) => ({
      id: gameId(), away, home, kickoff, isMNF,
      pick: null, confidence: null, actualWinner: null, tiebreakGuess: null,
      pickedSpread: null, pickedOverUnder: null, pickedAt: null,
      homeSpread: null, overUnder: null,
      closingSpread: null, closingOverUnder: null, closingLineAt: null,
      liveAway: null, liveHome: null,
      gameState: 'pre', statusDetail: null
    }));
  });
  saveState();
}
