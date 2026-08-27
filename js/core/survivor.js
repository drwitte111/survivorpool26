// Survivor pool: one straight-up lock per week, each team usable only once,
// one loss and you're out for the season.
import { TOTAL_WEEKS } from './data.js';
import { peekWeek } from './state.js';
import { teamAbbrEquals } from './teams.js';

export function getLockStatusForWeek(n){
  const week = peekWeek(n);
  if(!week.lockTeam) return null;
  const game = week.games.find(g => teamAbbrEquals(g.away, week.lockTeam) || teamAbbrEquals(g.home, week.lockTeam));
  if(!game) return { team: week.lockTeam, game: null, side: null, result: 'unmatched' };
  const side = teamAbbrEquals(game.away, week.lockTeam) ? 'away' : 'home';
  if(!game.actualWinner) return { team: week.lockTeam, game, side, result: 'pending' };
  return { team: week.lockTeam, game, side, result: game.actualWinner === side ? 'win' : 'loss' };
}

// Every team already spent as a lock this season, keyed by the week it was used.
export function getUsedLockTeams(excludeWeek){
  const used = [];
  for(let n=1;n<=TOTAL_WEEKS;n++){
    if(n === excludeWeek) continue;
    const week = peekWeek(n);
    if(week.lockTeam) used.push({ week: n, team: week.lockTeam });
  }
  return used;
}

// Survivor status: alive until the first week where the locked team loses.
export function getSurvivorStatus(){
  for(let n=1;n<=TOTAL_WEEKS;n++){
    const status = getLockStatusForWeek(n);
    if(status && status.result === 'loss') return { alive: false, eliminatedWeek: n, eliminatedTeam: status.team };
  }
  return { alive: true, eliminatedWeek: null, eliminatedTeam: null };
}
