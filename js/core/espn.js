// Pulls spreads and over/unders from ESPN's public endpoints.
//
// One call per week. The scoreboard request carries the slate, the live scores
// AND the betting line for each game, so spreads and totals come back in the
// same response as everything else. A per-game odds endpoint exists and is still
// used as a fallback, but only for a game the scoreboard had no line for.
//
// No API key and no account -- these are the same public endpoints the site
// itself uses, and both send CORS headers, so the browser can read them directly
// with no proxy.
//
// Nothing here writes anything. It returns a plain list and lets the admin
// review it in the spread editor before publishing.
import { TEAMS } from './data.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ODDS = (id) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/odds`;

const REQUEST_TIMEOUT_MS = 12000;

async function getJson(url){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try{
    const res = await fetch(url, { signal: ctrl.signal });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Home-relative closing spread for one event, from the per-game odds endpoint
 * (negative = home favoured), or null. Used for past seasons, whose scoreboard
 * responses no longer carry a line at all. ESPN has reported `spread` as either
 * a number or a numeric string over time, so both are accepted.
 */
export async function fetchEventSpread(eventId){
  try{
    const odds = await getJson(ODDS(eventId));
    const line = (odds.items || [])[0];
    if(!line || line.spread == null) return null;
    const n = parseFloat(line.spread);
    return isNaN(n) ? null : n;
  }catch(e){
    return null;
  }
}

/** ESPN abbreviations line up with the espn_abbr column in teams.csv. */
function teamNameFromAbbr(abbr){
  if(!abbr) return null;
  const lower = String(abbr).toLowerCase();
  const team = TEAMS.find(t => t.abbr === lower);
  return team ? team.name : null;
}

/**
 * Spreads and totals for one week, keyed to our own team names.
 *
 * Returns { games: [{away, home, kickoff, homeSpread, overUnder, provider}], missing }
 * where `missing` counts games ESPN listed but had no line for. `homeSpread`
 * follows the board's own convention -- negative means the home team is
 * favoured, which is exactly what ESPN's `spread` field already reports.
 */
export async function fetchWeekOdds(week, seasonYear){
  const board = await getJson(
    `${SCOREBOARD}?dates=${seasonYear}&seasontype=2&week=${week}`
  );
  const events = board.events || [];

  const results = await Promise.all(events.map(async (event) => {
    const comp = (event.competitions || [])[0];
    if(!comp) return null;
    const competitors = comp.competitors || [];
    const homeSide = competitors.find(c => c.homeAway === 'home');
    const awaySide = competitors.find(c => c.homeAway === 'away');
    if(!homeSide || !awaySide) return null;

    const home = teamNameFromAbbr(homeSide.team && homeSide.team.abbreviation);
    const away = teamNameFromAbbr(awaySide.team && awaySide.team.abbreviation);
    if(!home || !away) return null; // an abbreviation we don't recognise

    // The scoreboard response already carries the line on each competition, so
    // the normal case costs no extra request at all. This used to hit the
    // per-game odds endpoint for every game -- 17 requests a refresh instead of
    // 1 -- which is also what made a refresh slow enough to notice on a phone.
    //
    // Providers vary by game (DraftKings, ESPN BET, ...); take the first, which
    // is the one ESPN ranks highest. Both sources report `spread` from the home
    // team's perspective, so nothing downstream changes.
    let line = (comp.odds || [])[0] || null;

    if(!line || (typeof line.spread !== 'number' && typeof line.overUnder !== 'number')){
      // Only a game the scoreboard had no line for falls back to the per-game
      // endpoint. Keeping the fallback means a mid-season gap still resolves.
      try{
        const odds = await getJson(ODDS(event.id));
        line = (odds.items || [])[0] || null;
      }catch(e){
        // A missing line for one game shouldn't sink the whole fetch.
        console.warn('ESPN odds unavailable for', away, '@', home, e.message);
      }
    }

    let homeSpread = null, overUnder = null, provider = null;
    if(line){
      if(typeof line.spread === 'number') homeSpread = line.spread;
      if(typeof line.overUnder === 'number') overUnder = line.overUnder;
      provider = line.provider ? line.provider.name : null;
    }

    return { away, home, kickoff: event.date, homeSpread, overUnder, provider };
  }));

  const games = results.filter(Boolean);
  return {
    games,
    missing: games.filter(g => g.homeSpread == null).length,
  };
}

// ---------- Live scores & final results ----------

/**
 * Every game's score and status for a week, in a single scoreboard request.
 *
 * `winner` is 'away' | 'home' | null. Null covers both an unfinished game and
 * a tie -- a tie means nobody picked correctly, which is how the board already
 * treats a null actualWinner.
 */
export async function fetchWeekScores(week, seasonYear){
  const board = await getJson(
    `${SCOREBOARD}?dates=${seasonYear}&seasontype=2&week=${week}`
  );

  return (board.events || []).map(event => {
    const comp = (event.competitions || [])[0];
    if(!comp) return null;
    const homeSide = (comp.competitors || []).find(c => c.homeAway === 'home');
    const awaySide = (comp.competitors || []).find(c => c.homeAway === 'away');
    if(!homeSide || !awaySide) return null;

    const home = teamNameFromAbbr(homeSide.team && homeSide.team.abbreviation);
    const away = teamNameFromAbbr(awaySide.team && awaySide.team.abbreviation);
    if(!home || !away) return null;

    const status = (comp.status && comp.status.type) || {};
    const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
    const homeScore = num(homeSide.score);
    const awayScore = num(awaySide.score);

    let winner = null;
    if(status.completed){
      if(homeSide.winner === true) winner = 'home';
      else if(awaySide.winner === true) winner = 'away';
      // both false === tie, which stays null
    }

    return {
      away, home, awayScore, homeScore, winner,
      state: status.state || 'pre',        // 'pre' | 'in' | 'post'
      completed: !!status.completed,
      detail: status.shortDetail || null,  // 'Final', 'Q3 5:22', ...
      kickoff: event.date,
    };
  }).filter(Boolean);
}

/**
 * Pulls a week's scores and merges them into local state, grading finished
 * games as it goes. Returns the number of games whose result changed, so the
 * caller can decide whether a re-render and save are worth it.
 *
 * Admin-published results still win: this runs before ensureSpreadsLoaded,
 * which overwrites actualWinner from Firestore if a human corrected it.
 */
export async function syncWeekScores(n, seasonYear, week){
  const rows = await fetchWeekScores(n, seasonYear);
  let changed = 0;

  rows.forEach(row => {
    const game = week.games.find(g => g.away === row.away && g.home === row.home);
    if(!game) return;

    const before = `${game.liveAway}|${game.liveHome}|${game.gameState}|${game.actualWinner}`;

    game.liveAway = row.awayScore;
    game.liveHome = row.homeScore;
    game.gameState = row.state;
    game.statusDetail = row.detail;
    // Only ever set a winner from a completed game; never clear one, so an
    // admin's manual grade survives a game ESPN hasn't marked final yet.
    if(row.winner) game.actualWinner = row.winner;

    if(`${game.liveAway}|${game.liveHome}|${game.gameState}|${game.actualWinner}` !== before) changed++;
  });

  return changed;
}
