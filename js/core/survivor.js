// Survivor pool: one straight-up lock per week, each team usable only once.
// Double elimination -- the first losing lock is a strike, the second ends your
// season.
import { TOTAL_WEEKS } from './data.js';
import { peekWeek } from './state.js';
import { isGameLocked } from './locks.js';
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

// Two strikes and you're out.
//
// Double elimination: the first losing lock is a strike and you keep playing;
// the second ends your season. `alive`, `eliminatedWeek` and `eliminatedTeam`
// keep their original meanings so everything reading this still works -- they
// now describe the *second* loss rather than the first.
export const STRIKES_ALLOWED = 2;

export function getSurvivorStatus(){
  const losses = [];
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const status = getLockStatusForWeek(n);
    if(status && status.result === 'loss'){
      losses.push({ week: n, team: status.team });
      if(losses.length >= STRIKES_ALLOWED){
        return {
          alive: false,
          strikes: losses.length,
          strikesAllowed: STRIKES_ALLOWED,
          losses,
          eliminatedWeek: n,
          eliminatedTeam: status.team,
        };
      }
    }
  }
  return {
    alive: true,
    strikes: losses.length,          // 0, or 1 while carrying a strike
    strikesAllowed: STRIKES_ALLOWED,
    losses,
    eliminatedWeek: null,
    eliminatedTeam: null,
  };
}

// Which teams you may still lock this week.
//
// The pick stays open all week rather than closing at the first kickoff, but
// you can only choose from teams that haven't played yet -- and the usual rule
// still applies, one team per season. Once your own locked team kicks off,
// you're committed for the week: no watching them fall behind and swapping out.
export function getSurvivorChoices(n){
  const week = peekWeek(n);
  const usedElsewhere = getUsedLockTeams(n);
  const usedFor = (name) => usedElsewhere.find(u => teamAbbrEquals(u.team, name)) || null;

  const games = week.games.map(g => ({
    game: g,
    locked: isGameLocked(g),
    teams: [g.away, g.home].map(name => ({ name, usedWeek: (usedFor(name) || {}).week || null })),
  }));

  const committedGame = week.lockTeam
    ? week.games.find(g => teamAbbrEquals(g.away, week.lockTeam) || teamAbbrEquals(g.home, week.lockTeam))
    : null;

  return {
    games,
    // Frozen once the team you locked has kicked off.
    committed: !!(committedGame && isGameLocked(committedGame)),
    // Nothing left to choose from.
    anyOpen: games.some(g => !g.locked && g.teams.some(t => !t.usedWeek)),
  };
}

/** Validates a proposed lock. Returns null if fine, or a reason string. */
export function survivorPickError(n, teamName){
  const week = peekWeek(n);
  const game = week.games.find(g => g.away === teamName || g.home === teamName);
  if(!game) return `"${teamName}" isn\u2019t one of this week\u2019s teams.`;
  if(isGameLocked(game)) return `${teamName} has already kicked off \u2014 pick a team that hasn\u2019t played yet.`;
  // Once the team you locked has played, you're committed for the week --
  // otherwise you could watch them fall behind and swap out.
  if(getSurvivorChoices(n).committed){
    return `${week.lockTeam} has already kicked off \u2014 your Survivor pick is locked in for Week ${n}.`;
  }
  const used = getUsedLockTeams(n).find(u => teamAbbrEquals(u.team, teamName));
  if(used) return `You already used ${used.team} as your lock in Week ${used.week}.`;
  return null;
}
