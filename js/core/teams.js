// Team lookups. The old code matched teams with `fullName.includes(nickname)`;
// that behaviour is preserved here, just driven off data/teams.csv instead of
// four hand-maintained object literals.
import { TEAMS } from './data.js';

function findTeam(name){
  if(!name) return null;
  const lower = name.toLowerCase();
  return TEAMS.find(t => lower.includes(t.key)) || null;
}

export function getTeamAbbr(name){
  const team = findTeam(name);
  return team ? team.abbr : null;
}

export function teamLogoUrl(name){
  const abbr = getTeamAbbr(name);
  return abbr ? `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${abbr}.png` : null;
}

export function getTeamColors(name){
  const team = findTeam(name);
  return team ? team.colors : null;
}

export function teamAbbrEquals(nameA, nameB){
  const a = getTeamAbbr(nameA), b = getTeamAbbr(nameB);
  return !!a && !!b && a === b;
}
