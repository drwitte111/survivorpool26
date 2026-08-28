// Team-by-team NFL records for a whole season, for the Research tab: straight-up
// W-L-T and against-the-spread W-L-P, plus points for / against.
//
// Built entirely from ESPN's public scoreboard -- one request per week, all 18
// fired together. Each scoreboard event carries both the final score and the
// closing line, so no per-game odds call is needed. A game ESPN never posted a
// line for simply doesn't count toward an ATS record.
//
// Results are cached in memory and in localStorage: a finished past season never
// changes, and the current season is only re-pulled once an hour.
import { TEAMS } from './data.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const REQUEST_TIMEOUT_MS = 12000;
const TTL_CURRENT_MS = 60 * 60 * 1000;
const TTL_PAST_MS = 30 * 24 * 60 * 60 * 1000;

const memCache = new Map(); // seasonYear -> { at, data }

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

/** ESPN abbreviations are upper-case; teams.csv keeps them lower-case. */
function teamNameFromAbbr(abbr){
  if(!abbr) return null;
  const lower = String(abbr).toLowerCase();
  const team = TEAMS.find(t => t.abbr === lower);
  return team ? team.name : null;
}

// "DET -7.0" / "PK" / "EVEN" -> spread from the home team's perspective (negative
// means home favoured), or null when it can't be read.
function homeSpreadFromDetails(details, homeAbbr, awayAbbr){
  if(!details) return null;
  const s = String(details).trim().toUpperCase();
  if(s === 'PK' || s === 'EVEN' || s === 'PICK') return 0;
  const m = s.match(/^([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/);
  if(!m) return null;
  const abbr = m[1].toLowerCase();
  const num = parseFloat(m[2]);
  if(abbr === String(homeAbbr).toLowerCase()) return num;
  if(abbr === String(awayAbbr).toLowerCase()) return -num;
  return null;
}

function blankRecord(name){
  return { name, w: 0, l: 0, t: 0, atsW: 0, atsL: 0, atsP: 0, pf: 0, pa: 0, games: 0 };
}

function computeRecords(events){
  const table = new Map();
  const rec = (name) => {
    if(!table.has(name)) table.set(name, blankRecord(name));
    return table.get(name);
  };

  events.forEach(event => {
    const comp = (event.competitions || [])[0];
    const type = comp && comp.status && comp.status.type;
    if(!type || !type.completed) return; // only finished games count

    const home = (comp.competitors || []).find(c => c.homeAway === 'home');
    const away = (comp.competitors || []).find(c => c.homeAway === 'away');
    if(!home || !away) return;

    const homeAbbr = home.team && home.team.abbreviation;
    const awayAbbr = away.team && away.team.abbreviation;
    const homeName = teamNameFromAbbr(homeAbbr);
    const awayName = teamNameFromAbbr(awayAbbr);
    if(!homeName || !awayName) return;

    const hs = parseInt(home.score, 10);
    const as = parseInt(away.score, 10);
    if(isNaN(hs) || isNaN(as)) return;

    const H = rec(homeName), A = rec(awayName);
    H.games++; A.games++;
    H.pf += hs; H.pa += as;
    A.pf += as; A.pa += hs;

    if(hs > as){ H.w++; A.l++; }
    else if(as > hs){ A.w++; H.l++; }
    else { H.t++; A.t++; }

    const odds = (comp.odds || [])[0];
    const spread = odds ? homeSpreadFromDetails(odds.details, homeAbbr, awayAbbr) : null;
    if(spread != null){
      const edge = (hs - as) + spread; // > 0: home covered
      if(edge > 0){ H.atsW++; A.atsL++; }
      else if(edge < 0){ A.atsW++; H.atsL++; }
      else { H.atsP++; A.atsP++; }
    }
  });

  // Rank by straight-up win percentage, then wins, then point differential.
  return [...table.values()].sort((a, b) => {
    const pa = a.games ? (a.w + a.t * 0.5) / a.games : 0;
    const pb = b.games ? (b.w + b.t * 0.5) / b.games : 0;
    return pb - pa || b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa);
  });
}

function readStored(key, ttl){
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(Date.now() - parsed.at > ttl) return null;
    return parsed.data;
  }catch(e){ return null; }
}

/**
 * Records for every team that has played in `seasonYear`. `isCurrent` picks the
 * cache lifetime. Throws only if every week request fails.
 */
export async function getSeasonRecords(seasonYear, isCurrent){
  const ttl = isCurrent ? TTL_CURRENT_MS : TTL_PAST_MS;
  const key = 'hdrf:nflstats:' + seasonYear;

  const hit = memCache.get(seasonYear);
  if(hit && Date.now() - hit.at < ttl) return hit.data;

  const stored = readStored(key, ttl);
  if(stored){ memCache.set(seasonYear, { at: Date.now(), data: stored }); return stored; }

  const weeks = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      getJson(`${SCOREBOARD}?dates=${seasonYear}&seasontype=2&week=${i + 1}`)
        .then(d => d.events || [])
        .catch(() => null)
    )
  );
  if(weeks.every(w => w === null)) throw new Error('ESPN unreachable');

  const data = computeRecords(weeks.filter(Boolean).flat());
  memCache.set(seasonYear, { at: Date.now(), data });
  try{ localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); }catch(e){}
  return data;
}
