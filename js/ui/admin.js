// The League Admin page: the spread and results editors, a week selector to
// point them at, and roster management. Admin-only -- who counts as an admin is
// the fixed email list in core/roles.js, not anything a league can grant.
import { store, ui, getWeek } from '../core/state.js';
import { TOTAL_WEEKS, CONFIG, CHANGELOG } from '../core/data.js';
import { db } from '../core/firebase.js';
import { fetchWeekOdds, fetchWeekScores } from '../core/espn.js';
import { fetchLeagueTeams, getLeagueMeta, saveGlobalSpreads, saveGlobalResults } from '../core/league.js';
import { isWeekFullyLocked } from '../core/locks.js';
import { isAdmin } from '../core/roles.js';
import { saveState } from '../core/persist.js';
import { escapeHtml } from './dom.js';
import { isoToZonedInput as isoToLocalInput, zonedInputToIso as localInputToIso, formatInZone, zoneLabel } from '../core/tz.js';
import { render, setSyncStatus } from './router.js';


// This render clears the page, then awaits Firestore before appending the
// roster. Two overlapping calls -- easy to trigger by toggling the editors or
// the week selector twice in quick succession -- would both append after their
// await and duplicate every panel. Each run takes a ticket and abandons its
// work if a newer run has started since.
let adminRenderToken = 0;

export async function renderAdminPage(){
  const el = document.getElementById('adminContent');
  const myToken = ++adminRenderToken;
  const superseded = () => myToken !== adminRenderToken;

  if(!isAdmin()){
    el.innerHTML = `
      <div class="panel">
        <div class="admin-locked-msg">🔒 Only a pool admin can open this page.</div>
      </div>`;
    return;
  }

  if(ui.adminWeek == null) ui.adminWeek = store.currentWeek;

  // ---- Spreads & results, for a chosen week ----
  const tools = document.createElement('div');
  tools.className = 'panel';

  const weekRow = document.createElement('div');
  weekRow.className = 'admin-week-row';
  const weekLabel = document.createElement('label');
  weekLabel.className = 'admin-week-label';
  weekLabel.textContent = 'Editing week';
  const weekSelect = document.createElement('select');
  weekSelect.className = 'admin-week-select';
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = 'Week ' + n;
    if(n === ui.adminWeek) opt.selected = true;
    weekSelect.appendChild(opt);
  }
  weekSelect.onchange = () => {
    ui.adminWeek = parseInt(weekSelect.value, 10);
    ui.spreadEditMode = false;
    ui.resultsEditMode = false;
    renderAdminPage();
  };
  weekLabel.appendChild(weekSelect);
  weekRow.appendChild(weekLabel);

  const toggleRow = document.createElement('div');
  toggleRow.className = 'admin-tool-toggle-row';
  const spreadToggle = document.createElement('button');
  spreadToggle.className = 'sync-btn small' + (ui.spreadEditMode ? ' confirm-armed' : '');
  spreadToggle.textContent = ui.spreadEditMode ? 'Close Spreads' : 'Update Spreads';
  spreadToggle.onclick = () => {
    ui.spreadEditMode = !ui.spreadEditMode;
    ui.resultsEditMode = false;
    renderAdminPage();
  };
  const resultsToggle = document.createElement('button');
  resultsToggle.className = 'sync-btn small' + (ui.resultsEditMode ? ' confirm-armed' : '');
  resultsToggle.textContent = ui.resultsEditMode ? 'Close Results' : 'Game Results';
  resultsToggle.onclick = () => {
    ui.resultsEditMode = !ui.resultsEditMode;
    ui.spreadEditMode = false;
    renderAdminPage();
  };
  toggleRow.appendChild(spreadToggle);
  toggleRow.appendChild(resultsToggle);

  tools.appendChild(weekRow);
  tools.appendChild(toggleRow);

  const week = getWeek(ui.adminWeek);
  if(ui.spreadEditMode){
    if(!week.games.length){
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `No matchups loaded for Week ${ui.adminWeek} yet.`;
      tools.appendChild(note);
    } else if(isWeekFullyLocked(week)){
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = 'Every game this week has kicked off — spreads are frozen so no one gets caught out.';
      tools.appendChild(note);
    } else {
      renderSpreadEditor(tools, ui.adminWeek);
    }
  }
  if(ui.resultsEditMode){
    if(!week.games.length){
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `No matchups loaded for Week ${ui.adminWeek} yet.`;
      tools.appendChild(note);
    } else {
      renderResultsEditor(tools, ui.adminWeek);
    }
  }

  el.innerHTML = '';
  el.appendChild(tools);

  // ---- Roster ----
  const rosterPanel = document.createElement('div');
  rosterPanel.className = 'panel';
  rosterPanel.innerHTML = '<div class="empty">Loading league roster…</div>';
  el.appendChild(rosterPanel);

  let leaguePassword = '••••••';
  try{
    const meta = await getLeagueMeta(store.state.account.leagueSlug);
    if(meta && meta.password) leaguePassword = meta.password;
  }catch(e){ /* leave placeholder */ }
  if(superseded()) return;

  const teams = await fetchLeagueTeams();
  if(superseded()) return;
  const aliveCount = teams.filter(t => t.survivorAlive).length;

  rosterPanel.innerHTML = `
    <div class="league-info-row">League: <b>${escapeHtml(store.state.account.leagueName || '')}</b> &nbsp;·&nbsp; Password: <b>${escapeHtml(leaguePassword)}</b></div>
    <div class="admin-summary-row">
      <div class="admin-stat-card"><div class="admin-stat-num">${teams.length}</div><div class="admin-stat-label">Members</div></div>
      <div class="admin-stat-card"><div class="admin-stat-num">${aliveCount}</div><div class="admin-stat-label">Alive in Survivor</div></div>
      <div class="admin-stat-card"><div class="admin-stat-num">${teams.length - aliveCount}</div><div class="admin-stat-label">Eliminated</div></div>
    </div>
    <div id="adminMemberList"></div>`;

  const listEl = rosterPanel.querySelector('#adminMemberList');
  if(!teams.length){
    listEl.innerHTML = '<div class="empty">No one has joined yet — share the league name and password to get your friends in.</div>';
    renderUpdateLog(el); // an empty roster shouldn't hide the log
    return;
  }
  teams.sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0));
  teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'admin-member-row';
    const joined = t.joinedAt ? new Date(t.joinedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : 'unknown';
    row.innerHTML = `
      <div>
        <div class="admin-member-name">${escapeHtml(t.teamName)}${t.yourName ? ' — ' + escapeHtml(t.yourName) : ''}</div>
        <div class="admin-member-sub">${t.total || 0} pts · ${t.survivorAlive ? (t.survivorStrikes ? t.survivorStrikes + ' strike' + (t.survivorStrikes === 1 ? '' : 's') : 'Alive') : 'Eliminated Wk ' + (t.survivorEliminatedWeek || '?')} · joined ${joined}</div>
      </div>`;
    if(t.teamName !== store.state.account.teamName){
      const kickBtn = document.createElement('button');
      kickBtn.className = 'admin-kick-btn';
      kickBtn.textContent = 'Remove';
      kickBtn.onclick = async () => {
        kickBtn.disabled = true; kickBtn.textContent = 'Removing…';
        try{ await db.collection('leagues').doc(store.state.account.leagueSlug).collection('members').doc(t.key).delete(); }
        catch(e){ console.error('kick failed', e); }
        renderAdminPage();
      };
      row.appendChild(kickBtn);
    }
    listEl.appendChild(row);
  });

  renderUpdateLog(el);
}


// ---------------------------------------------------------------------------
// Update Log
//
// ⚠️  IF YOU ARE AN AI AGENT (OR A PERSON) CHANGING ANYTHING IN THIS REPO:
//     add an entry to data/changelog.json before you commit. Every change gets
//     one, including small ones. The file itself carries the format and the
//     rules; this table just renders it.
//
// The log is deliberately a hand-maintained data file rather than something
// derived from git. Commit messages describe code; this is for the two people
// running the pool, who want to know what changed for *them* and when.
// ---------------------------------------------------------------------------
function renderUpdateLog(el){
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `<div class="section-label"><span>📋 Update Log</span></div>`;

  if(!CHANGELOG.length){
    panel.innerHTML += '<div class="empty">No updates recorded yet.</div>';
    el.appendChild(panel);
    return;
  }

  const intro = document.createElement('p');
  intro.className = 'update-log-intro';
  intro.textContent = `${CHANGELOG.length} update${CHANGELOG.length === 1 ? '' : 's'}, newest first. Times are shown in your local timezone.`;
  panel.appendChild(intro);

  const table = document.createElement('div');
  table.className = 'update-log';

  CHANGELOG.forEach(entry => {
    const when = new Date(entry.at);
    const validDate = !isNaN(when.getTime());

    const row = document.createElement('div');
    row.className = 'update-log-row';

    const stamp = document.createElement('div');
    stamp.className = 'update-log-when';
    stamp.innerHTML = validDate
      ? `<span class="ul-date">${when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`
        + `<span class="ul-time">${when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>`
      : `<span class="ul-date">—</span>`;
    if(validDate) stamp.title = when.toLocaleString();
    row.appendChild(stamp);

    const body = document.createElement('div');
    body.className = 'update-log-body';
    let html = `<div class="update-log-title">${escapeHtml(entry.title || 'Untitled update')}</div>`;
    if(entry.detail) html += `<div class="update-log-detail">${escapeHtml(entry.detail)}</div>`;
    const meta = [];
    if(entry.by) meta.push(`<span class="update-log-by">${escapeHtml(entry.by)}</span>`);
    (entry.tags || []).forEach(t => meta.push(`<span class="update-log-tag">${escapeHtml(t)}</span>`));
    if(meta.length) html += `<div class="update-log-meta">${meta.join('')}</div>`;
    body.innerHTML = html;
    row.appendChild(body);

    table.appendChild(row);
  });

  panel.appendChild(table);
  el.appendChild(panel);
}


// ---------------------------------------------------------------------------
// Spread editor. Moved here from the week page -- spreads publish to every
// league at once, so only an admin should ever see this.
// ---------------------------------------------------------------------------
export function renderSpreadEditor(panel, weekNum){
  const week = getWeek(weekNum);
  const wrap = document.createElement('div');
  wrap.className = 'spread-editor';

  const intro = document.createElement('p');
  intro.className = 'spread-editor-intro';
  intro.textContent = 'Set the spread, over/under and kickoff time for each game. Type either team’s number and the other fills in automatically. This publishes for every league at once.';
  wrap.appendChild(intro);

  // Lines auto-fill from ESPN on the first load of a week that has none. This
  // button is for pulling fresh numbers after that -- deliberately manual,
  // because spreads move during the week and shifting the board under people
  // without anyone asking is the thing to avoid.
  const fetchRow = document.createElement('div');
  fetchRow.className = 'espn-fetch-row';
  const fetchBtn = document.createElement('button');
  fetchBtn.className = 'sync-btn';
  fetchBtn.textContent = '↓ Fetch lines from ESPN';
  const fetchStatus = document.createElement('span');
  fetchStatus.className = 'espn-fetch-status';
  fetchRow.appendChild(fetchBtn);
  fetchRow.appendChild(fetchStatus);
  wrap.appendChild(fetchRow);

  const rows = week.games.map(g => {
    const row = document.createElement('div');
    row.className = 'spread-edit-row';
    const awayVal = g.homeSpread != null ? -g.homeSpread : '';
    const homeVal = g.homeSpread != null ? g.homeSpread : '';
    const ouVal = g.overUnder != null ? g.overUnder : '';
    row.innerHTML = `
      <div class="spread-edit-matchup">${escapeHtml(g.away)} @ ${escapeHtml(g.home)}</div>
      <div class="spread-edit-fields">
        <label>${escapeHtml(g.away)} Spread<input type="number" step="0.5" class="se-away-spread" placeholder="e.g. 3.5" value="${awayVal}"></label>
        <label>${escapeHtml(g.home)} Spread<input type="number" step="0.5" class="se-home-spread" placeholder="e.g. -3.5" value="${homeVal}"></label>
        <label>Over/Under<input type="number" step="0.5" class="se-over-under" placeholder="e.g. 47.5" value="${ouVal}"></label>
        <label>Kickoff (${zoneLabel()})<input type="datetime-local" class="se-kickoff" value="${isoToLocalInput(g.kickoff)}"></label>
      </div>`;
    const awayInput = row.querySelector('.se-away-spread');
    const homeInput = row.querySelector('.se-home-spread');
    [awayInput, homeInput].forEach(inp => {
      inp.addEventListener('wheel', e => { e.preventDefault(); }, { passive: false });
    });
    awayInput.addEventListener('input', () => {
      const v = parseFloat(awayInput.value);
      homeInput.value = isNaN(v) ? '' : (-v);
    });
    homeInput.addEventListener('input', () => {
      const v = parseFloat(homeInput.value);
      awayInput.value = isNaN(v) ? '' : (-v);
    });
    return { row, game: g };
  });
  rows.forEach(r => wrap.appendChild(r.row));

  // Fills the form only -- the admin still has to hit Save & Publish.
  fetchBtn.onclick = async () => {
    fetchBtn.disabled = true;
    fetchStatus.className = 'espn-fetch-status';
    fetchStatus.textContent = 'Fetching…';
    try{
      const { games, missing } = await fetchWeekOdds(weekNum, CONFIG.seasonYear);
      let filled = 0, unmatched = 0;
      games.forEach(g => {
        const target = rows.find(r => r.game.away === g.away && r.game.home === g.home);
        if(!target){ unmatched++; return; }
        if(g.homeSpread != null){
          target.row.querySelector('.se-home-spread').value = g.homeSpread;
          target.row.querySelector('.se-away-spread').value = -g.homeSpread;
          filled++;
        }
        if(g.overUnder != null) target.row.querySelector('.se-over-under').value = g.overUnder;
        if(g.kickoff) target.row.querySelector('.se-kickoff').value = isoToLocalInput(g.kickoff);
      });
      const provider = (games.find(g => g.provider) || {}).provider;
      const notes = [`Filled ${filled} of ${rows.length} games`];
      if(provider) notes.push(`via ${provider}`);
      if(missing) notes.push(`${missing} with no line yet`);
      if(unmatched) notes.push(`${unmatched} not on this week’s board`);
      fetchStatus.className = 'espn-fetch-status ok';
      fetchStatus.textContent = notes.join(' · ') + ' — review, then Save & Publish.';
    }catch(e){
      fetchStatus.className = 'espn-fetch-status err';
      fetchStatus.textContent = 'Couldn’t reach ESPN (' + e.message + '). Enter the numbers by hand.';
    }
    fetchBtn.disabled = false;
  };

  const actionRow = document.createElement('div');
  actionRow.className = 'spread-editor-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'submit-btn complete';
  saveBtn.textContent = 'Save & Publish Spreads';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Publishing…';
    const gamesArr = rows.map(r => {
      const g = r.game;
      const homeVal = r.row.querySelector('.se-home-spread').value.trim();
      const ouVal = r.row.querySelector('.se-over-under').value.trim();
      const kickoffVal = r.row.querySelector('.se-kickoff').value;
      return {
        away: g.away,
        home: g.home,
        homeSpread: homeVal !== '' ? parseFloat(homeVal) : null,
        overUnder: ouVal !== '' ? parseFloat(ouVal) : null,
        kickoff: kickoffVal ? localInputToIso(kickoffVal) : g.kickoff
      };
    });
    // Latest kickoff becomes the MNF / tiebreaker game
    let latestIdx = 0;
    gamesArr.forEach((g, i) => {
      if(g.kickoff && new Date(g.kickoff) > new Date(gamesArr[latestIdx].kickoff || 0)) latestIdx = i;
    });
    gamesArr.forEach((g, i) => { g.isMNF = (i === latestIdx); });

    const ok = await saveGlobalSpreads(weekNum, gamesArr);
    if(ok){
      gamesArr.forEach(gs => {
        const local = week.games.find(g => g.away === gs.away && g.home === gs.home);
        if(local){
          local.homeSpread = gs.homeSpread;
          local.overUnder = gs.overUnder;
          local.kickoff = gs.kickoff;
          local.isMNF = gs.isMNF;
        }
      });
      saveState();
      ui.spreadEditMode = false;
      render();
      renderAdminPage();
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Publish Spreads';
      setSyncStatus('Couldn’t publish spreads right now — try again.');
    }
  };
  actionRow.appendChild(saveBtn);
  wrap.appendChild(actionRow);

  panel.appendChild(wrap);
}


// ---------------------------------------------------------------------------
// Results editor. Also moved from the week page. Publishing here grades every
// league's picks for the week.
// ---------------------------------------------------------------------------
export function renderResultsEditor(panel, weekNum){
  const week = getWeek(weekNum);
  const wrap = document.createElement('div');
  wrap.className = 'spread-editor';

  const intro = document.createElement('p');
  intro.className = 'spread-editor-intro';
  intro.textContent = 'Mark who actually won each game, and enter the Monday Night combined final score for the tiebreaker. This publishes for every league at once and grades everyone’s picks.';
  wrap.appendChild(intro);

  // Same idea as the spread editor: pull the real results in, then let the admin
  // check them and publish. Scores already sync on their own for display -- this
  // is what makes them the league's official, published result.
  const fetchRow = document.createElement('div');
  fetchRow.className = 'espn-fetch-row';
  const fetchBtn = document.createElement('button');
  fetchBtn.className = 'sync-btn';
  fetchBtn.textContent = '↓ Fetch results from ESPN';
  const fetchStatus = document.createElement('span');
  fetchStatus.className = 'espn-fetch-status';
  fetchRow.appendChild(fetchBtn);
  fetchRow.appendChild(fetchStatus);
  wrap.appendChild(fetchRow);

  const rows = week.games.map(g => {
    const row = document.createElement('div');
    row.className = 'spread-edit-row results-edit-row';
    const finalScore = (g.liveAway != null && g.liveHome != null)
      ? `<span class="results-score">${g.liveAway}–${g.liveHome}</span>` : '';
    row.innerHTML = `<div class="spread-edit-matchup">${escapeHtml(g.away)} @ ${escapeHtml(g.home)}${g.isMNF ? ' <span class="mnf-tag">MNF</span>' : ''}${finalScore}</div>`;
    const btnRow = document.createElement('div');
    btnRow.className = 'results-winner-row';
    const awayBtn = document.createElement('button');
    awayBtn.type = 'button';
    awayBtn.className = 'results-winner-btn' + (g.actualWinner === 'away' ? ' selected' : '');
    awayBtn.textContent = g.away + ' Won';
    const homeBtn = document.createElement('button');
    homeBtn.type = 'button';
    homeBtn.className = 'results-winner-btn' + (g.actualWinner === 'home' ? ' selected' : '');
    homeBtn.textContent = g.home + ' Won';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'results-undo-btn';
    undoBtn.title = 'Undo this game’s result';
    undoBtn.textContent = '↶';
    let selected = g.actualWinner || null;
    const refresh = () => {
      awayBtn.classList.toggle('selected', selected === 'away');
      homeBtn.classList.toggle('selected', selected === 'home');
      undoBtn.style.visibility = selected ? 'visible' : 'hidden';
    };
    awayBtn.onclick = () => { selected = (selected === 'away') ? null : 'away'; refresh(); };
    homeBtn.onclick = () => { selected = (selected === 'home') ? null : 'home'; refresh(); };
    undoBtn.onclick = () => { selected = null; refresh(); };
    btnRow.appendChild(awayBtn);
    btnRow.appendChild(homeBtn);
    btnRow.appendChild(undoBtn);
    row.appendChild(btnRow);
    refresh();

    let scoreInput = null;
    if(g.isMNF){
      const scoreField = document.createElement('div');
      scoreField.className = 'mnf-score-field';
      scoreField.innerHTML = `<label>Combined Final Score<input type="number" class="re-mnf-score" placeholder="e.g. 45" value="${week.mnfActualTotal != null ? week.mnfActualTotal : ''}"></label>`;
      row.appendChild(scoreField);
      scoreInput = scoreField.querySelector('.re-mnf-score');
    }
    return {
      row, game: g,
      getSelected: () => selected,
      setSelected: (v) => { selected = v; refresh(); },
      scoreInput,
      clear: () => { selected = null; refresh(); if(scoreInput) scoreInput.value = ''; }
    };
  });
  rows.forEach(r => wrap.appendChild(r.row));

  // Fills the form only -- Save & Publish is still a separate, deliberate step.
  fetchBtn.onclick = async () => {
    fetchBtn.disabled = true;
    fetchStatus.className = 'espn-fetch-status';
    fetchStatus.textContent = 'Fetching…';
    try{
      const results = await fetchWeekScores(weekNum, CONFIG.seasonYear);
      let graded = 0, pending = 0, ties = 0;
      results.forEach(r => {
        const target = rows.find(x => x.game.away === r.away && x.game.home === r.home);
        if(!target) return;

        // Show the score in the row whether or not the game is over yet.
        const label = target.row.querySelector('.spread-edit-matchup');
        let scoreEl = label.querySelector('.results-score');
        if(r.awayScore != null && r.homeScore != null){
          if(!scoreEl){
            scoreEl = document.createElement('span');
            scoreEl.className = 'results-score';
            label.appendChild(scoreEl);
          }
          scoreEl.textContent = `${r.awayScore}–${r.homeScore}`;
          scoreEl.classList.toggle('pending', !r.completed);
        }

        if(!r.completed){ pending++; return; }
        if(r.winner){ target.setSelected(r.winner); graded++; }
        else ties++;

        // The tiebreaker wants the two teams' combined final score.
        if(target.game.isMNF && target.scoreInput && r.awayScore != null && r.homeScore != null){
          target.scoreInput.value = r.awayScore + r.homeScore;
        }
      });
      const notes = [`${graded} of ${rows.length} games final`];
      if(pending) notes.push(`${pending} still in progress`);
      if(ties) notes.push(`${ties} tied — left ungraded`);
      fetchStatus.className = 'espn-fetch-status ok';
      fetchStatus.textContent = notes.join(' · ') + ' — review, then Save & Publish.';
    }catch(e){
      fetchStatus.className = 'espn-fetch-status err';
      fetchStatus.textContent = 'Couldn’t reach ESPN (' + e.message + '). Mark the winners by hand.';
    }
    fetchBtn.disabled = false;
  };

  const actionRow = document.createElement('div');
  actionRow.className = 'spread-editor-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'submit-btn complete';
  saveBtn.textContent = 'Save & Publish Results';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Publishing…';
    // Include every game's current selection, even ones cleared back to null --
    // otherwise an undone result would just get silently skipped instead of
    // actually clearing for everyone.
    const resultsArr = rows.map(r => ({
      away: r.game.away,
      home: r.game.home,
      actualWinner: r.getSelected()
    }));
    const mnfInput = wrap.querySelector('.re-mnf-score');
    const mnfScore = mnfInput && mnfInput.value.trim() !== '' ? parseInt(mnfInput.value, 10) : null;

    const ok = await saveGlobalResults(weekNum, resultsArr, mnfScore);
    if(ok){
      resultsArr.forEach(r => {
        const local = week.games.find(g => g.away === r.away && g.home === r.home);
        if(local) local.actualWinner = r.actualWinner;
      });
      week.mnfActualTotal = mnfScore;
      saveState();
      ui.resultsEditMode = false;
      render();
      renderAdminPage();
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Publish Results';
      setSyncStatus('Couldn’t publish results right now — try again.');
    }
  };
  actionRow.appendChild(saveBtn);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'admin-kick-btn';
  resetBtn.textContent = 'Reset All';
  resetBtn.title = 'Clear every result on this screen (you’ll still need to Save & Publish)';
  let resetArmed = false;
  let resetArmTimer = null;
  resetBtn.onclick = () => {
    if(!resetArmed){
      resetArmed = true;
      resetBtn.textContent = 'Confirm Reset All?';
      setTimeout(() => {
        if(resetArmed){ resetArmed = false; resetBtn.textContent = 'Reset All'; }
      }, 3000);
      return;
    }
    clearTimeout(resetArmTimer);
    rows.forEach(r => r.clear());
    resetArmed = false;
    resetBtn.textContent = 'Reset All';
  };
  actionRow.appendChild(resetBtn);
  wrap.appendChild(actionRow);

  panel.appendChild(wrap);
}
