// Loads everything the board needs from /data at boot: league config, the team
// table, the 2026 slate, week boundaries and the rules copy. Nothing here is
// baked into the page, so updating a schedule or a rule is a data edit, not a
// code edit.

/** Minimal RFC-4180 CSV parser: handles quoted fields, doubled quotes, CRLF. */
function parseCsv(text){
  const rows = [];
  let row = [], field = '', quoted = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"'){
        if(text[i + 1] === '"'){ field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if(c === '"') quoted = true;
    else if(c === ','){ row.push(field); field = ''; }
    else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
    else if(c !== '\r') field += c;
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}

/** Turns a CSV table into objects keyed by its header row. */
function parseCsvObjects(text){
  const rows = parseCsv(text).filter(r => r.length && r.some(c => c !== ''));
  const header = rows.shift();
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

async function fetchText(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.text();
}

// Populated by loadAppData() before anything else runs.
export let CONFIG = null;
export let TEAMS = [];
export let TEAM_LIST = [];
export let WEEK_DATES = {};
export let DEFAULT_SCHEDULE = {};
export let RULES = [];
export let CHANGELOG = [];
export let TOTAL_WEEKS = 18;

export async function loadAppData(){
  const [configText, teamsText, scheduleText, weeksText, rulesText, changelogText] = await Promise.all([
    fetchText('data/config.json'),
    fetchText('data/teams.csv'),
    fetchText('data/schedule.csv'),
    fetchText('data/weeks.csv'),
    fetchText('data/rules.json'),
    fetchText('data/changelog.json'),
  ]);

  CONFIG = JSON.parse(configText);
  RULES = JSON.parse(rulesText);
  // Newest first, whatever order the file happens to be in.
  CHANGELOG = (JSON.parse(changelogText).entries || [])
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  TOTAL_WEEKS = CONFIG.totalWeeks;

  TEAMS = parseCsvObjects(teamsText).map(t => ({
    key: t.key,
    name: t.name,
    abbr: t.espn_abbr,
    nflCode: t.nfl_code,
    colors: [t.primary_color, t.secondary_color],
  }));
  TEAM_LIST = TEAMS.map(t => t.name);

  WEEK_DATES = {};
  parseCsvObjects(weeksText).forEach(w => {
    WEEK_DATES[Number(w.week)] = [w.start, w.end];
  });

  DEFAULT_SCHEDULE = {};
  parseCsvObjects(scheduleText).forEach(g => {
    const wk = Number(g.week);
    (DEFAULT_SCHEDULE[wk] ||= []).push({
      away: g.away,
      home: g.home,
      kickoff: g.kickoff_utc,
      isMNF: g.is_mnf === 'true',
    });
  });
}
