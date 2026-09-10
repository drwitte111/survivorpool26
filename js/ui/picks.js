// Group Picks: a grid of who took what.
//
// Games down the left, league members across the top. Each cell shows the logo
// of the team that person took, with the points they put on it printed over the
// top. Once a game is graded the logo picks up a green ring for a correct pick
// or a red one for a wrong one.
//
// Privacy: picks are published as they're made, so an unkicked game's picks ARE
// in Firestore and this file is what keeps them off the screen -- the `locked`
// check on each cell, and visibleLock() for Survivor. Both fail closed. This is
// a curtain, not a lock: anyone signed in can read the member documents
// directly. See the note in core/league.js for why that's the deal here, and
// what a real seal would take. Your own picks come from local state, so you can
// always see your own full column.
import { store, peekWeek, getWeek } from '../core/state.js';
import { TOTAL_WEEKS } from '../core/data.js';
import { getTeamAbbr, teamLogoUrl } from '../core/teams.js';
import { isGameLocked } from '../core/locks.js';
import { fetchLeagueTeams, gamePickKey } from '../core/league.js';
import { getLockStatusForWeek, getSurvivorStatus, STRIKES_ALLOWED } from '../core/survivor.js';
import { gradedWinner, spreadForPick, sharedSpread } from '../core/scoring.js';
import { escapeHtml, renderLoadFailure } from './dom.js';
import { formatInZone } from '../core/tz.js';

let picksWeek = null;
let picksMode = 'confidence';   // 'confidence' | 'survivor'

export function setPicksWeek(n){ picksWeek = n; }

export async function renderPicksPage(){
  const grid = document.getElementById('picksGrid');
  const weekSelect = document.getElementById('picksWeekSelect');
  if(picksWeek == null) picksWeek = store.currentWeek;

  // Confidence is per week; Survivor is a season-long view, so the week picker
  // doesn't apply to it.
  const toggle = document.getElementById('picksModeToggle');
  toggle.querySelectorAll('.picks-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === picksMode);
    btn.onclick = () => {
      if(picksMode === btn.dataset.mode) return;
      picksMode = btn.dataset.mode;
      renderPicksPage();
    };
  });
  const survivorMode = picksMode === 'survivor';
  document.getElementById('picksWeekLabel').style.display = survivorMode ? 'none' : '';
  weekSelect.style.display = survivorMode ? 'none' : '';

  // Week chooser
  weekSelect.innerHTML = '';
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = 'Week ' + n;
    if(n === picksWeek) opt.selected = true;
    weekSelect.appendChild(opt);
  }
  weekSelect.onchange = () => {
    picksWeek = parseInt(weekSelect.value, 10);
    renderPicksPage();
  };

  const week = getWeek(picksWeek);
  // Survivor is a season view, so an empty selected week doesn't apply to it.
  if(!survivorMode && !week.games.length){
    grid.innerHTML = `<div class="empty">No matchups loaded for Week ${picksWeek} yet.</div>`;
    return;
  }

  grid.innerHTML = '<div class="empty">Loading everyone’s picks…</div>';
  let members;
  try{
    members = await fetchLeagueTeams();
  }catch(e){
    // A stalled read used to leave this on "Loading…" with no way back.
    renderLoadFailure(grid, {
      message: 'Couldn’t load everyone’s picks.',
      onRetry: () => renderPicksPage(),
    });
    return;
  }
  if(!survivorMode && picksWeek !== parseInt(weekSelect.value, 10)) return; // week changed mid-load

  const me = store.state.account.teamName;
  const myUid = store.currentUser && store.currentUser.uid;

  // Your own column is drawn from local state, so it has to be here even if your
  // roster row hasn't synced yet -- otherwise you'd be missing from your own grid.
  const iAmListed = members.some(m => m.uid === myUid || m.teamName === me);
  if(!iAmListed && me){
    members.push({ teamName: me, yourName: store.state.account.yourName || '', uid: myUid, total: 0 });
  }

  members.sort((a, b) => {
    const aMe = a.uid === myUid || a.teamName === me;
    const bMe = b.uid === myUid || b.teamName === me;
    if(aMe !== bMe) return aMe ? -1 : 1;        // you first, so your column is easy to find
    return (b.total || 0) - (a.total || 0);
  });

  if(!members.length){
    grid.innerHTML = '<div class="empty">No one has joined this league yet.</div>';
    return;
  }

  if(survivorMode){
    renderSurvivorGrid(grid, members, me, myUid);
    return;
  }

  const lockedCount = week.games.filter(isGameLocked).length;

  // Members whose row is older than a game that has already kicked off. Their
  // cell is blank because nothing has been published for them, which is not the
  // same claim as "they didn't pick" -- see staleFor() below.
  // Members whose row has never been written for this week. Name -> whether
  // they say they submitted it, which decides how firmly the note can put it.
  const unsynced = new Map();

  const table = document.createElement('table');
  table.className = 'picks-table';

  // ---- header: one column per member ----
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'picks-corner';
  corner.textContent = `Week ${picksWeek}`;
  headRow.appendChild(corner);
  members.forEach(m => {
    const th = document.createElement('th');
    const isMe = (myUid && m.uid === myUid) || m.teamName === me;
    th.className = 'picks-member' + (isMe ? ' is-me' : '');
    th.innerHTML = `<span class="picks-member-name">${escapeHtml(m.teamName || '—')}</span>`
      + `<span class="picks-member-pts">${m.total || 0} pts</span>`;
    th.title = m.yourName ? `${m.teamName} — ${m.yourName}` : (m.teamName || '');
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  // ---- one row per game ----
  const tbody = document.createElement('tbody');
  week.games.forEach(game => {
    const locked = isGameLocked(game);
    const key = gamePickKey(game);
    const tr = document.createElement('tr');
    if(!locked) tr.className = 'picks-row-open';

    const gameCell = document.createElement('th');
    gameCell.className = 'picks-game';
    const kickoff = game.kickoff
      ? formatInZone(game.kickoff, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : '';
    gameCell.innerHTML =
      `<span class="picks-game-teams">${escapeHtml(getTeamAbbr(game.away)?.toUpperCase() || game.away)}`
      + `<span class="picks-at">@</span>`
      + `${escapeHtml(getTeamAbbr(game.home)?.toUpperCase() || game.home)}</span>`
      + `<span class="picks-game-when">${locked ? escapeHtml(statusText(game)) : escapeHtml(kickoff)}</span>`;
    tr.appendChild(gameCell);

    members.forEach(m => {
      const td = document.createElement('td');
      td.className = 'picks-cell';
      const isMe = (myUid && m.uid === myUid) || m.teamName === me;

      // Yours comes from local state so it's visible immediately. Everyone
      // else's is in Firestore from the moment they pick, so THIS is the gate
      // that keeps an open game's picks out of sight -- `locked` first, before
      // the row is even consulted, so a game with no kickoff time set stays
      // hidden rather than falling open.
      const entry = isMe
        ? (game.pick || game.confidence != null
            ? { p: game.pick, c: game.confidence, s: spreadForPick(game) }
            : null)
        : (locked && m.picks && m.picks[picksWeek] ? m.picks[picksWeek][key] : null);

      if(!entry || !entry.p){
        const stale = staleFor(m, isMe, locked);
        const submitted = (m.submittedWeeks || []).includes(picksWeek);
        if(stale) unsynced.set(m.teamName || m.uid, submitted);
        td.appendChild(placeholder(locked, isMe, stale, submitted));
      } else {
        td.appendChild(pickChip(game, entry, isMe));
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  grid.innerHTML = '';

  const note = document.createElement('p');
  note.className = 'picks-note';
  note.textContent = lockedCount === week.games.length
    ? 'Every game has kicked off — every published pick is visible.'
    : `${lockedCount} of ${week.games.length} games have kicked off. Everyone else’s picks appear as each game starts; your own are always shown.`;
  grid.appendChild(note);

  // Nobody has written anything for this week on these rows. Say which of the
  // two reasons it is where the row can tell us, and don't pretend where it
  // can't -- the point of the note is that a blank cell is not evidence.
  if(unsynced.size){
    const warn = document.createElement('p');
    warn.className = 'picks-note picks-note-warn';
    const list = (names) => names.map(escapeHtml).join(', ');
    const said = [...unsynced].filter(([, sub]) => sub).map(([name]) => name);
    const quiet = [...unsynced].filter(([, sub]) => !sub).map(([name]) => name);
    const parts = [];
    if(said.length){
      parts.push(`<b>${list(said)}</b> ${said.length === 1 ? 'has' : 'have'} submitted a `
        + `Week ${picksWeek} lineup, so those picks definitely exist — they have just never `
        + `been published to the league.`);
    }
    if(quiet.length){
      parts.push(`Nothing at all has been published for <b>${list(quiet)}</b> this week, and `
        + `${quiet.length === 1 ? 'their row doesn’t' : 'their rows don’t'} record a submitted `
        + `lineup either, so the board genuinely can’t tell whether `
        + `${quiet.length === 1 ? 'they picked' : 'they picked'}.`);
    }
    warn.innerHTML = '⚠ ' + parts.join(' ')
      + ` Either way a blank above means <b>nothing published</b>, not "no pick". It resolves`
      + ` the moment each of them opens the board on the current version — once, after which`
      + ` it stays up to date on its own.`;
    grid.appendChild(warn);
  }

  const scroller = document.createElement('div');
  scroller.className = 'picks-scroll';
  scroller.appendChild(table);
  grid.appendChild(scroller);
}

function statusText(game){
  if(game.gameState === 'post' && game.liveAway != null) return `${game.liveAway}–${game.liveHome}`;
  if(game.gameState === 'in') return game.statusDetail || 'Live';
  return 'Locked';
}

/**
 * True when this member's row can't be trusted to say they skipped this game.
 *
 * The whole question is whether the row has ever been written for this week.
 * A key here -- even an empty object -- means their device synced this week, so
 * the row is a complete account of it and a gap in it is a real gap. That holds
 * for older builds too: those published locked picks, and this only ever asks
 * about a game that has already locked.
 *
 * No key at all means nothing has been written for this week by anyone. Their
 * picks may well exist, unreachable in users/{uid}, so the board must not call
 * that "no pick".
 */
function staleFor(m, isMe, locked){
  if(isMe || !locked) return false;
  return !(m.picks && m.picks[picksWeek]);
}

function placeholder(locked, isMe, stale, submitted){
  const el = document.createElement('div');
  el.className = 'pick-empty' + (stale ? ' unsynced' : '');
  if(!locked && !isMe){
    el.textContent = '🔒';
    el.title = 'Hidden until this game kicks off';
    return el;
  }
  if(stale){
    el.textContent = '⋯';
    el.title = submitted
      ? 'Nothing has been published for this member this week, but their row says they '
        + 'submitted a lineup — so this pick exists and the board can’t reach it. '
        + 'Clears once they open the board on the current version.'
      : 'Nothing has been published for this member this week and their row records no '
        + 'submitted lineup, so the board can’t tell whether they picked. '
        + 'Clears once they open the board on the current version.';
    return el;
  }
  // Their row is newer than kickoff and still has nothing here, so this one is
  // genuine: they didn't pick it.
  el.textContent = '—';
  el.title = 'No pick';
  return el;
}

function pickChip(game, entry, isMe){
  const side = entry.p;                       // 'away' | 'home'
  const teamName = side === 'home' ? game.home : game.away;
  const wrap = document.createElement('div');
  wrap.className = 'pick-chip' + (isMe ? ' is-me' : '');

  // Green ring for a correct pick, red for a wrong one, nothing until graded.
  // Judged against the line THIS person locked in, which isn't necessarily the
  // one you're on -- so two chips on the same team can grade differently, and
  // that's correct. `s` is missing on picks synced before it was published;
  // those fall back to the league's shared line rather than to yours.
  const line = entry.s != null ? entry.s : sharedSpread(game);
  const graded = gradedWinner(game, line);
  if(graded){
    wrap.classList.add(graded === side ? 'correct' : 'wrong');
  }

  const logo = teamLogoUrl(teamName);
  const abbr = (getTeamAbbr(teamName) || teamName).toUpperCase();
  if(logo){
    const img = document.createElement('img');
    img.className = 'pick-logo';
    img.src = logo;
    img.alt = '';
    img.onerror = () => {
      img.remove();
      const fallback = document.createElement('span');
      fallback.className = 'pick-logo-fallback';
      fallback.textContent = abbr;
      wrap.insertBefore(fallback, wrap.firstChild);
    };
    wrap.appendChild(img);
  } else {
    const fallback = document.createElement('span');
    fallback.className = 'pick-logo-fallback';
    fallback.textContent = abbr;
    wrap.appendChild(fallback);
  }

  // The wager, printed over the logo.
  const pts = document.createElement('span');
  pts.className = 'pick-points';
  pts.textContent = entry.c != null ? entry.c : '';
  wrap.appendChild(pts);

  // Name the number too. Two chips on the same team can carry different lines
  // and so grade differently, and the tooltip is where that becomes explicable
  // rather than looking like a bug.
  const lineLabel = line == null ? '' : (() => {
    const n = side === 'home' ? line : -line;
    return ' ' + (n === 0 ? 'PK' : (n > 0 ? '+' + n : String(n)));
  })();
  wrap.title = `${teamName}${lineLabel}${entry.c != null ? ` — ${entry.c} pt${entry.c === 1 ? '' : 's'}` : ''}`;
  return wrap;
}


// ---------------------------------------------------------------------------
// Survivor view
//
// A season grid rather than a single week: weeks down the left, members across
// the top, each cell the team they locked. Green ring if that team won, red if
// it lost. Survivor is double elimination, so the running strike count matters
// more than any one week -- it's shown under each member's name.
// ---------------------------------------------------------------------------
function renderSurvivorGrid(grid, members, me, myUid){
  const isMine = (m) => (myUid && m.uid === myUid) || m.teamName === me;

  // Only show weeks anyone has actually reached.
  const weeks = [];
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const mine = peekWeek(n).lockTeam;
    const theirs = members.some(m => visibleLock(m.locks && m.locks[n]));
    if(mine || theirs) weeks.push(n);
  }

  grid.innerHTML = '';

  if(!weeks.length){
    grid.innerHTML = '<div class="empty">No Survivor picks yet. They appear here once each locked team has kicked off.</div>';
    return;
  }

  const note = document.createElement('p');
  note.className = 'picks-note';
  note.textContent = 'Each week\u2019s Survivor pick. Double elimination \u2014 two losing locks and you\u2019re out. '
    + 'Other people\u2019s locks appear once that team has kicked off; your own are always shown.';
  grid.appendChild(note);

  const table = document.createElement('table');
  table.className = 'picks-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'picks-corner';
  corner.textContent = 'Survivor';
  headRow.appendChild(corner);
  members.forEach(m => {
    const th = document.createElement('th');
    th.className = 'picks-member' + (isMine(m) ? ' is-me' : '');
    const strikes = strikeCountFor(m, isMine(m));
    const out = strikes >= STRIKES_ALLOWED;
    th.innerHTML = `<span class="picks-member-name">${escapeHtml(m.teamName || '—')}</span>`
      + `<span class="survivor-strikes ${out ? 'out' : strikes ? 'warn' : 'clean'}">`
      + (out ? '💀 Out' : `${strikes}/${STRIKES_ALLOWED} strikes`)
      + `</span>`;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  weeks.forEach(n => {
    const tr = document.createElement('tr');
    const wkCell = document.createElement('th');
    wkCell.className = 'picks-game';
    wkCell.innerHTML = `<span class="picks-game-teams">Week ${n}</span>`;
    tr.appendChild(wkCell);

    members.forEach(m => {
      const td = document.createElement('td');
      td.className = 'picks-cell';
      // Locks publish when they're set, not at kickoff, so this is the gate
      // that keeps them out of sight. A missing lockAt is an entry from before
      // that field existed, which was only ever written post-kickoff anyway.
      const entry = isMine(m) ? myLockFor(n) : visibleLock(m.locks && m.locks[n]);

      if(!entry || !entry.team){
        const empty = document.createElement('div');
        empty.className = 'pick-empty';
        empty.textContent = isMine(m) ? '—' : '🔒';
        empty.title = isMine(m) ? 'No lock set' : 'Hidden until that team kicks off';
        td.appendChild(empty);
      } else {
        td.appendChild(lockChip(entry, isMine(m)));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const scroller = document.createElement('div');
  scroller.className = 'picks-scroll';
  scroller.appendChild(table);
  grid.appendChild(scroller);
}

/**
 * Somebody else's lock, or null while the team it's on hasn't kicked off yet.
 * A lockAt that won't parse counts as not yet -- fail closed, never leak.
 */
function visibleLock(entry){
  if(!entry) return null;
  if(entry.lockAt === undefined) return entry;   // written before lockAt existed
  if(!entry.lockAt) return null;                 // no kickoff time known
  const at = new Date(entry.lockAt);
  if(isNaN(at.getTime())) return null;
  return new Date() >= at ? entry : null;
}

/** Your own lock for a week, straight from local state so it's always visible. */
function myLockFor(n){
  const status = getLockStatusForWeek(n);
  if(!status) return null;
  return {
    team: status.team,
    result: status.result === 'win' || status.result === 'loss' ? status.result : null,
  };
}

function strikeCountFor(member, mine){
  if(mine) return getSurvivorStatus().strikes;
  if(typeof member.survivorStrikes === 'number') return member.survivorStrikes;
  // Older rows predate survivorStrikes; fall back to counting published losses.
  return Object.values(member.locks || {}).filter(l => l && l.result === 'loss').length;
}

function lockChip(entry, mine){
  const wrap = document.createElement('div');
  wrap.className = 'pick-chip survivor-chip' + (mine ? ' is-me' : '');
  if(entry.result === 'win') wrap.classList.add('correct');
  else if(entry.result === 'loss') wrap.classList.add('wrong');

  const abbr = (getTeamAbbr(entry.team) || entry.team).toUpperCase();
  const logo = teamLogoUrl(entry.team);
  if(logo){
    const img = document.createElement('img');
    img.className = 'pick-logo';
    img.src = logo; img.alt = '';
    img.onerror = () => {
      img.remove();
      const fb = document.createElement('span');
      fb.className = 'pick-logo-fallback';
      fb.textContent = abbr;
      wrap.appendChild(fb);
    };
    wrap.appendChild(img);
  } else {
    const fb = document.createElement('span');
    fb.className = 'pick-logo-fallback';
    fb.textContent = abbr;
    wrap.appendChild(fb);
  }

  // No wager on a Survivor pick, so the team code goes under the logo instead.
  const tag = document.createElement('span');
  tag.className = 'survivor-abbr';
  tag.textContent = abbr;
  wrap.appendChild(tag);

  wrap.title = entry.team + (entry.result ? ` — ${entry.result === 'win' ? 'survived' : 'lost'}` : ' — pending');
  return wrap;
}
