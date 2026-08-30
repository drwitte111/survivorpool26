// Repo health check. Runs in CI on every push and pull request.
//
// Deliberately dependency-free -- the project has no build step and no
// node_modules, and this shouldn't be the thing that introduces them. It uses
// regexes rather than a real parser, which is imprecise in theory but catches
// what actually breaks in practice: a renamed module, a typo'd import, a
// half-finished merge, malformed data.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++; };
const section = (name) => console.log(`\n${name}`);
const pass = (msg) => console.log(`  ✓ ${msg}`);

function walk(dir, out = []){
  for(const entry of readdirSync(dir)){
    const p = join(dir, entry);
    if(statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const jsFiles = existsSync('js') ? walk('js').filter(f => f.endsWith('.js')) : [];

// ---------- 0. Every file actually parses ----------
//
// The rest of this file works by regex, which catches a renamed module or a
// stale import but will happily wave through a syntax error. Node parses each
// file properly here, without executing it -- a duplicate `const` reached the
// browser once, which is why this exists.
//
// The source goes in on stdin with --input-type=module rather than passing the
// path: `node --check file.js` parses a .js as CommonJS first and, on these
// files, reported success on code that genuinely doesn't parse as a module.
section('Syntax');
for(const file of jsFiles){
  try{
    execFileSync(process.execPath, ['--input-type=module', '--check'],
      { input: readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'] });
  }catch(e){
    const detail = (e.stderr ? e.stderr.toString() : e.message)
      .split(/\r?\n/).filter(l => l.trim()).slice(0, 3).join(' | ');
    fail(`${relative(process.cwd(), file)}: ${detail}`);
  }
}
if(!failures) pass(`${jsFiles.length} modules parse cleanly`);

// ---------- 1. Imports resolve, and the names they ask for are exported ----------
section('Module imports');
const exportsOf = new Map();
for(const file of jsFiles){
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for(const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for(const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+(\w+)/gm)) names.add(m[1]);
  exportsOf.set(resolve(file), names);
}

let importCount = 0;
for(const file of jsFiles){
  const src = readFileSync(file, 'utf8');
  for(const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)){
    const [, namesRaw, spec] = m;
    if(!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    if(!existsSync(target)){
      fail(`${file}: imports "${spec}" which does not exist`);
      continue;
    }
    const available = exportsOf.get(target);
    for(const raw of namesRaw.split(',')){
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if(!name) continue;
      importCount++;
      if(available && !available.has(name)){
        fail(`${file}: imports { ${name} } from "${spec}", which does not export it`);
      }
    }
  }
}
if(!failures) pass(`${importCount} named imports across ${jsFiles.length} modules all resolve`);

// ---------- 1b. Nothing calls a helper it forgot to import ----------
//
// The check above verifies imports point at something real. This is the other
// direction: a function that exists elsewhere in the project, is called here,
// and was never imported. That reaches the browser as a ReferenceError at the
// exact moment the code runs -- which for an error handler means the first time
// something goes wrong. It has happened twice.
const importsBefore = failures;
const exportedAnywhere = new Map();       // name -> module that exports it
for(const [file, names] of exportsOf){
  for(const n of names) if(!exportedAnywhere.has(n)) exportedAnywhere.set(n, file);
}

// Comments and string literals mention function names constantly; scanning them
// produces noise, not findings. Blank them out but keep newlines so reported
// line numbers still line up with the real file.
const stripNonCode = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(Math.max(0, m.length - p.length)))
  .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
  .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length));

for(const file of jsFiles){
  const src = stripNonCode(readFileSync(file, 'utf8'));
  const mine = exportsOf.get(resolve(file)) || new Set();

  const imported = new Set();
  for(const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)){
    for(const raw of m[1].split(',')){
      const parts = raw.trim().split(/\s+as\s+/);
      const local = (parts[1] || parts[0] || '').trim();
      if(local) imported.add(local);
    }
  }
  // Anything declared in this file under any of the usual forms.
  const declared = new Set();
  for(const re of [/\b(?:function|class)\s+(\w+)/g, /\b(?:const|let|var)\s+(\w+)/g,
                   /\b(\w+)\s*(?:=|:)\s*(?:async\s*)?\(/g]){
    for(const m of src.matchAll(re)) declared.add(m[1]);
  }

  for(const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)){
    const name = m[1];
    if(imported.has(name) || declared.has(name) || mine.has(name)) continue;
    const home = exportedAnywhere.get(name);
    if(home && resolve(file) !== home){
      const line = src.slice(0, m.index).split('\n').length;
      fail(`${relative(process.cwd(), file)}:${line}: calls ${name}(), exported by `
         + `${relative(process.cwd(), home)}, but never imports it`);
    }
  }
}
if(failures === importsBefore) pass('no module calls a helper it forgot to import');

// ---------- 2. Data files parse and hold what the app expects ----------
section('Data files');
const before = failures;

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch(e){ fail(`${p}: invalid JSON -- ${e.message}`); return null; }
};

const config = readJson('data/config.json');
if(config){
  for(const key of ['seasonYear', 'totalWeeks', 'pickLockMinutesBeforeKickoff',
                    'weekUnlockHoursBeforeStart', 'firebase']){
    if(config[key] === undefined) fail(`data/config.json: missing "${key}"`);
  }
}
const rules = readJson('data/rules.json');
if(rules && (!Array.isArray(rules) || !rules.length)) fail('data/rules.json: expected a non-empty array');
if(rules && Array.isArray(rules)){
  rules.forEach((r, i) => {
    if(!r.heading) fail(`data/rules.json[${i}]: missing heading`);
    if(!Array.isArray(r.body)) fail(`data/rules.json[${i}]: body must be an array`);
  });
}

const readCsv = (p) => {
  const lines = readFileSync(p, 'utf8').trim().split('\n').map(l => l.replace(/\r$/, ''));
  const header = lines.shift().split(',');
  return lines.map(l => Object.fromEntries(header.map((h, i) => [h, (l.split(',')[i] ?? '').trim()])));
};

let teams = [], weeks = [];
try {
  teams = readCsv('data/teams.csv');
  if(teams.length !== 32) fail(`data/teams.csv: expected 32 teams, found ${teams.length}`);
  const names = new Set(teams.map(t => t.name));
  if(names.size !== teams.length) fail('data/teams.csv: duplicate team names');
  teams.forEach(t => {
    if(!t.name || !t.espn_abbr || !t.key) fail(`data/teams.csv: incomplete row for "${t.name || '?'}"`);
    if(!/^#[0-9A-Fa-f]{6}$/.test(t.primary_color)) fail(`data/teams.csv: bad primary_color for ${t.name}`);
  });

  weeks = readCsv('data/weeks.csv');
  const totalWeeks = config ? config.totalWeeks : 18;
  if(weeks.length !== totalWeeks) fail(`data/weeks.csv: expected ${totalWeeks} rows, found ${weeks.length}`);

  const schedule = readCsv('data/schedule.csv');
  const byWeek = new Map();
  schedule.forEach((g, i) => {
    const line = i + 2;
    if(!names.has(g.away)) fail(`data/schedule.csv:${line}: unknown away team "${g.away}"`);
    if(!names.has(g.home)) fail(`data/schedule.csv:${line}: unknown home team "${g.home}"`);
    if(g.away === g.home) fail(`data/schedule.csv:${line}: team plays itself`);
    if(isNaN(Date.parse(g.kickoff_utc))) fail(`data/schedule.csv:${line}: bad kickoff "${g.kickoff_utc}"`);
    if(!['true', 'false'].includes(g.is_mnf)) fail(`data/schedule.csv:${line}: is_mnf must be true/false`);
    const wk = Number(g.week);
    if(!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(g);
  });
  // Exactly one tiebreaker game a week, and nobody playing twice in a week.
  for(const [wk, games] of [...byWeek].sort((a, b) => a[0] - b[0])){
    const mnf = games.filter(g => g.is_mnf === 'true').length;
    if(mnf !== 1) fail(`data/schedule.csv: week ${wk} has ${mnf} MNF games, expected exactly 1`);
    const seen = new Set();
    for(const g of games){
      for(const team of [g.away, g.home]){
        if(seen.has(team)) fail(`data/schedule.csv: week ${wk} has ${team} playing twice`);
        seen.add(team);
      }
    }
  }
  if(failures === before) pass(`${teams.length} teams, ${weeks.length} weeks, ${schedule.length} games all valid`);
}catch(e){
  fail(`data files: ${e.message}`);
}

// ---------- 3. Service worker ----------
section('Service worker');
const swBefore = failures;
const sw = readFileSync('sw.js', 'utf8');
if(!sw.includes("const BUILD_ID = '__BUILD_ID__';")){
  fail('sw.js: BUILD_ID placeholder is missing or edited -- tools/stamp-build.mjs will fail the deploy');
}
for(const m of sw.matchAll(/^\s*'([^']+)',$/gm)){
  const asset = m[1];
  if(asset === './') continue;
  if(!existsSync(asset)) fail(`sw.js: caches "${asset}", which does not exist`);
}
if(failures === swBefore) pass('build placeholder intact and every cached asset exists');

// ---------- 4. index.html references ----------
section('index.html');
const htmlBefore = failures;
const html = readFileSync('index.html', 'utf8');
for(const m of html.matchAll(/(?:href|src)="((?!https?:|data:|#)[^"]+)"/g)){
  const ref = m[1];
  if(!existsSync(ref)) fail(`index.html: references "${ref}", which does not exist`);
}
// Anything left behind by a bad merge.
for(const marker of ['<<<<<<<', '>>>>>>>', '=======']){
  for(const file of [...jsFiles, 'index.html', 'sw.js']){
    const src = readFileSync(file, 'utf8');
    if(marker !== '=======' && src.includes(marker)) fail(`${file}: unresolved merge conflict marker`);
  }
}
if(failures === htmlBefore) pass('all local references resolve, no conflict markers');

console.log(
  failures
    ? `\n${failures} problem(s) found.\n`
    : '\nAll checks passed.\n'
);
process.exit(failures ? 1 : 0);
