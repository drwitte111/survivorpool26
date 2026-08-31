// Team-by-team NFL records for a whole season, for the Research tab: straight-up
// W-L-T and against-the-spread W-L-P, plus points for / against.
//
// The scoreboard request (one per week) gives the final scores. It also carries
// the betting line for upcoming games, but not for a season that's already over
// -- so any game still without a line after that is looked up individually
// through ESPN's per-game odds endpoint (fetchEventSpread), a few at a time. A
// game no source has a line for counts straight-up but not against the spread.
//
// Results are cached in memory and in localStorage: a finished past season never
// changes, and the current season is only re-pulled once an hour.
import { TEAMS } from './data.js';
import { fetchEventSpread } from './espn.js';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const REQUEST_TIMEOUT_MS = 12000;
const TTL_CURRENT_MS = 60 * 60 * 1000;
const TTL_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const ODDS_CONCURRENCY = 10;
const CACHE_VERSION = 2; // bump to invalidate every stored season at once

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

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let cursor = 0;
  async function worker(){
    while(cursor < items.length){
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** ESPN abbreviations are upper-case; teams.csv keeps them lower-case. */
function teamNameFromAbbr(abbr){
  if(!abbr) return null;
  const team = TEAMS.find(t => t.abbr === String(abbr).toLowerCase());
  return team ? team.name : null;
}

// "DET -7.0" / "PK" / "EVEN" -> spread from the home team's perspective (negative
// means home favoured), or null when it can't be read.
function homeSpreadFromDetails(details, homeAbbr, awayAbbr){
  if(details == null) return null;
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

// The line already sitting on a scoreboard event, if any (number or the
// "ABBR -N" details string). Null means it has to be fetched per-game.
function embeddedSpread(comp, homeAbbr, awayAbbr){
  const line = (comp.odds || [])[0];
  if(!line) return null;
  if(line.spread != null){
    const n = parseFloat(line.spread);
    if(!isNaN(n)) return n;
  }
  return homeSpreadFromDetails(line.details, homeAbbr, awayAbbr);
}

async function fetchSeasonGames(seasonYear){
  const boards = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      getJson(`${SCOREBOARD}?dates=${seasonYear}&seasontype=2&week=${i + 1}`)
        .then(d => d.events || [])
        .catch(() => null)
    )
  );
  if(boards.every(b => b === null)) throw new Error('ESPN unreachable');

  const games = [];
  boards.filter(Boolean).flat().forEach(event => {
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

    games.push({
      eventId: event.id,
      homeName, awayName, hs, as,
      spread: embeddedSpread(comp, homeAbbr, awayAbbr),
    });
  });

  // Fill the lines the scoreboard didn't carry (all of them, for a past season)
  // from the per-game odds endpoint, a bounded number at a time.
  const needLine = games.filter(g => g.spread == null);
  await mapLimit(needLine, ODDS_CONCURRENCY, async g => {
    g.spread = await fetchEventSpread(g.eventId);
  });

  return games;
}

function blankRecord(name){
  return { name, w: 0, l: 0, t: 0, atsW: 0, atsL: 0, atsP: 0, pf: 0, pa: 0, games: 0 };
}

function computeRecords(games){
  const table = new Map();
  const rec = (name) => {
    if(!table.has(name)) table.set(name, blankRecord(name));
    return table.get(name);
  };

  games.forEach(({ homeName, awayName, hs, as, spread }) => {
    const H = rec(homeName), A = rec(awayName);
    H.games++; A.games++;
    H.pf += hs; H.pa += as;
    A.pf += as; A.pa += hs;

    if(hs > as){ H.w++; A.l++; }
    else if(as > hs){ A.w++; H.l++; }
    else { H.t++; A.t++; }

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

function storageKey(seasonYear){
  return `hdrf:nflstats:v${CACHE_VERSION}:${seasonYear}`;
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
 * cache lifetime. Throws only if every scoreboard request fails.
 */
export async function getSeasonRecords(seasonYear, isCurrent){
  const ttl = isCurrent ? TTL_CURRENT_MS : TTL_PAST_MS;
  const key = storageKey(seasonYear);

  const hit = memCache.get(seasonYear);
  if(hit && Date.now() - hit.at < ttl) return hit.data;

  const stored = readStored(key, ttl);
  if(stored){ memCache.set(seasonYear, { at: Date.now(), data: stored }); return stored; }

  const data = computeRecords(await fetchSeasonGames(seasonYear));
  memCache.set(seasonYear, { at: Date.now(), data });
  try{ localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); }catch(e){}
  return data;
}
