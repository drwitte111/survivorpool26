// The week page: matchup rows, the survivor lock panel, the admin spread and
// results editors, and the week summary.
import { store, ui, getWeek, peekWeek } from '../core/state.js';
import { TEAM_LIST, CONFIG } from '../core/data.js';
import { fetchWeekOdds } from '../core/espn.js';
import { getTeamAbbr, getTeamColors, teamLogoUrl, teamAbbrEquals } from '../core/teams.js';
import { saveState } from '../core/persist.js';
import {
  isGameLocked, isWeekFullyLocked, openGames, nextLockTime,
  isWeekOpen, isWeekComplete, getMissingItems, weekUnlockTime,
} from '../core/locks.js';
import {
  maxPointsFor, usedConfidenceValues, weekScore, seasonScore,
  getMvpPick, isPerfectWeek, computeHotStreak,
} from '../core/scoring.js';
import {
  getLockStatusForWeek, getUsedLockTeams, getSurvivorStatus,
  getSurvivorChoices, survivorPickError,
} from '../core/survivor.js';
import { saveGlobalSpreads, saveGlobalResults, ensureSpreadsLoaded } from '../core/league.js';
import { escapeHtml, isoToLocalInput, localInputToIso, burstConfetti } from './dom.js';
import { render, setSyncStatus } from './router.js';

export function coverStatus(game, side){
  if(game.homeSpread == null) return null;
  if(game.liveAway == null || game.liveHome == null || isNaN(game.liveAway) || isNaN(game.liveHome)) return null;
  const margin = side === 'home' ? (game.liveHome - game.liveAway) : (game.liveAway - game.liveHome);
  const spreadForSide = side === 'home' ? game.homeSpread : -game.homeSpread;
  const value = margin + spreadForSide;
  if(value > 0) return 'cover';
  if(value < 0) return 'no-cover';
  return 'push';
}

export function teamButtonRow(game, mode, locked){
  // mode: 'pick' uses g.pick, 'actual' uses g.actualWinner
  const field = mode === 'pick' ? 'pick' : 'actualWinner';
  const disablePicks = mode === 'pick' && locked;
  const wrap = document.createElement('div');
  wrap.className = 'matchup';
  if(game.isMNF){
    const tag = document.createElement('span');
    tag.className = 'mnf-tag'; tag.textContent = 'MNF';
    wrap.appendChild(tag);
  }

  const awayBtn = document.createElement('button');
  const homeBtn = document.createElement('button');
  [['away', awayBtn, game.away], ['home', homeBtn, game.home]].forEach(([side, btn, label]) => {
    let cls = 'team-btn';
    if(game[field] === side){
      if(mode === 'pick'){
        const cover = coverStatus(game, side);
        cls += cover ? ' picked ' + cover : ' picked';
      } else {
        cls += ' actual-picked';
      }
    }
    if(mode === 'pick' && game.actualWinner){
      cls += (game.actualWinner === side) ? ' result-win' : ' result-loss';
    }
    btn.className = cls;
    if(game[field] === side && mode === 'pick'){
      const colors = getTeamColors(label);
      if(colors){
        btn.style.backgroundImage = `repeating-linear-gradient(135deg, ${colors[0]} 0px, ${colors[0]} 9px, ${colors[1]} 9px, ${colors[1]} 18px)`;
      }
    }
    const abbr = getTeamAbbr(label);
    const logo = teamLogoUrl(label);
    if(logo){
      const img = document.createElement('img');
      img.className = 'team-logo'; img.src = logo; img.alt = '';
      img.onerror = () => {
        img.remove();
        const fallback = document.createElement('span');
        fallback.className = 'team-logo-fallback';
        fallback.textContent = abbr ? abbr.toUpperCase() : '';
        btn.insertBefore(fallback, btn.firstChild);
      };
      btn.appendChild(img);
    } else if(abbr){
      const fallback = document.createElement('span');
      fallback.className = 'team-logo-fallback';
      fallback.textContent = abbr.toUpperCase();
      btn.appendChild(fallback);
    }
    const txt = document.createElement('span');
    txt.className = 'team-btn-label';
    txt.textContent = label;
    btn.appendChild(txt);
    btn.disabled = disablePicks;
    btn.onclick = () => { if(disablePicks) return; game[field] = game[field] === side ? null : side; saveState(); render(); };
  });
  wrap.appendChild(awayBtn);
  const vs = document.createElement('span'); vs.className='vs'; vs.textContent='@';
  wrap.appendChild(vs);
  wrap.appendChild(homeBtn);

  if(game.homeSpread != null || game.overUnder != null){
    const oddsBar = document.createElement('div');
    oddsBar.className = 'odds-bar';
    const fmt = (v) => v > 0 ? '+' + v : String(v);
    let html = '';
    if(game.homeSpread != null){
      const awaySpread = -game.homeSpread;
      html += `<div class="odds-spread-line">${escapeHtml(game.away)} <b>${fmt(awaySpread)}</b></div>`
            + `<div class="odds-spread-line">${escapeHtml(game.home)} <b>${fmt(game.homeSpread)}</b></div>`;
    }
    // Reference only -- the over/under is shown so you can eyeball the expected
    // scoring, especially for the MNF tiebreaker. Nothing scores off it.
    if(game.overUnder != null){
      html += `<div class="odds-total-line">O/U <b>${game.overUnder}</b></div>`;
    }
    oddsBar.innerHTML = html;
    wrap.appendChild(oddsBar);
  }

  if(game.gameState === 'in' || game.gameState === 'post'){
    const score = document.createElement('div');
    score.className = 'score-line';
    const tag = document.createElement('span');
    tag.className = 'status-tag ' + (game.gameState === 'in' ? 'live' : 'final');
    tag.textContent = game.gameState === 'in' ? (game.statusDetail || 'LIVE') : 'FINAL';
    score.appendChild(tag);
    const scoreText = document.createElement('span');
    scoreText.textContent = `${game.away} ${game.liveAway ?? '-'} — ${game.liveHome ?? '-'} ${game.home}`;
    score.appendChild(scoreText);
    wrap.appendChild(score);
  } else if(game.kickoff){
    const ko = document.createElement('div');
    ko.className = 'kickoff';
    try{
      ko.textContent = new Date(game.kickoff).toLocaleString('en-US', { weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit' });
    }catch(e){ ko.textContent = ''; }
    wrap.appendChild(ko);
  }

  if(game.isMNF && mode === 'pick'){
    const tb = document.createElement('div');
    tb.className = 'tiebreak-inline';
    const label = document.createElement('label');
    label.textContent = 'Total points guess:';
    const guessInput = document.createElement('input');
    guessInput.type = 'number'; guessInput.min = '0';
    guessInput.value = game.tiebreakGuess ?? '';
    // The over/under is the bookmakers' own guess at this number, so it makes
    // a far better prompt than an arbitrary example.
    guessInput.placeholder = game.overUnder != null ? `O/U ${game.overUnder}` : 'e.g. 47';
    guessInput.disabled = disablePicks;
    guessInput.onchange = () => { game.tiebreakGuess = guessInput.value ? parseInt(guessInput.value) : null; saveState(); render(); };
    label.appendChild(guessInput);
    tb.appendChild(label);
    if(game.gameState === 'post' && game.liveAway != null && game.liveHome != null && game.tiebreakGuess != null){
      const actualTotal = game.liveAway + game.liveHome;
      const diff = Math.abs(game.tiebreakGuess - actualTotal);
      const res = document.createElement('span');
      res.className = 'tiebreak-result' + (diff === 0 ? ' good' : '');
      res.textContent = diff === 0 ? `Dead on! (${actualTotal})` : `Actual ${actualTotal} · off by ${diff}`;
      tb.appendChild(res);
    }
    wrap.appendChild(tb);
  }

  return wrap;
}


export function renderLockPanel(){
  const panel = document.getElementById('lockPanel');
  panel.innerHTML = '';
  const week = getWeek(store.currentWeek);
  const notOpenYet = !isWeekOpen(store.currentWeek);
  const choices = getSurvivorChoices(store.currentWeek);
  // Stays open all week; closes only once your team has played or nothing is left.
  const locked = notOpenYet || choices.committed || !choices.anyOpen;

  const survivor = getSurvivorStatus();
  const eliminatedBeforeThisWeek = !survivor.alive && survivor.eliminatedWeek < store.currentWeek;
  const eliminatedThisWeek = !survivor.alive && survivor.eliminatedWeek === store.currentWeek;

  const header = document.createElement('div');
  header.className = 'lock-header';
  header.innerHTML = `<div class="lock-title">Survivor <span>\ud83d\udd12</span></div>`;
  const badge = document.createElement('div');
  badge.className = 'survivor-badge ' + (survivor.alive || eliminatedThisWeek ? 'alive' : 'out');
  badge.textContent = survivor.alive
    ? 'Alive'
    : (eliminatedThisWeek ? 'Eliminated this week' : `Eliminated Wk ${survivor.eliminatedWeek}`);
  header.appendChild(badge);
  panel.appendChild(header);

  if(!week.games.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Load this week\u2019s matchups above before setting your Survivor pick.';
    panel.appendChild(empty);
    return;
  }

  if(eliminatedBeforeThisWeek){
    const msg = document.createElement('div');
    msg.className = 'lock-eliminated-msg';
    msg.innerHTML = `You\u2019re out of the Survivor pool \u2014 <b>${escapeHtml(survivor.eliminatedTeam)}</b> lost in Week ${survivor.eliminatedWeek}. Your confidence picks keep going, but there\u2019s no lock pick to make here anymore.`;
    panel.appendChild(msg);
    return;
  }

  const row = document.createElement('div');
  row.className = 'lock-input-row';

  const select = document.createElement('select');
  select.className = 'lock-team-select';
  select.disabled = locked;
  const blankOpt = document.createElement('option');
  blankOpt.value = ''; blankOpt.textContent = 'Select a team that hasn’t played yet...';
  select.appendChild(blankOpt);
  choices.games.forEach(({ game: g, locked: gameLocked, teams }) => {
    // Teams that already kicked off aren't choices any more -- but keep the group
    // visible if it holds the pick you're now committed to.
    const holdsCurrentPick = teams.some(t => t.name === week.lockTeam);
    if(gameLocked && !holdsCurrentPick) return;

    const group = document.createElement('optgroup');
    group.label = `${g.away} @ ${g.home}` + (gameLocked ? ' — kicked off' : '');
    teams.forEach(({ name, usedWeek }) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + (usedWeek ? ` — used Wk ${usedWeek}` : '');
      if(usedWeek || gameLocked) opt.disabled = true;
      if(week.lockTeam === name){ opt.selected = true; opt.disabled = false; }
      group.appendChild(opt);
    });
    select.appendChild(group);
  });

  const errorEl = document.createElement('div');
  errorEl.className = 'lock-error';

  select.onchange = () => {
    const typed = select.value;
    errorEl.textContent = '';
    if(!typed){ week.lockTeam = null; saveState(); render(); return; }
    const matchesGame = week.games.find(g => g.away === typed || g.home === typed);
    if(!matchesGame){
      errorEl.textContent = `"${typed}" isn\u2019t one of this week\u2019s teams.`;
      return;
    }
    const usedElsewhere = getUsedLockTeams(store.currentWeek).find(u => teamAbbrEquals(u.team, typed));
    if(usedElsewhere){
      errorEl.textContent = `You already used ${usedElsewhere.team} as your lock in Week ${usedElsewhere.week}.`;
      return;
    }
    week.lockTeam = typed;
    saveState(); render();
  };
  row.appendChild(select);

  const status = getLockStatusForWeek(store.currentWeek);
  if(status && status.result && status.result !== 'unmatched'){
    const chip = document.createElement('div');
    chip.className = 'lock-status-chip ' + status.result;
    const label = status.result === 'pending' ? '\u23f3 Pending' : (status.result === 'win' ? '\u2705 Survived' : '\u274c Eliminated');
    chip.textContent = label;
    row.appendChild(chip);
  }

  panel.appendChild(row);
  panel.appendChild(errorEl);

  const used = getUsedLockTeams(store.currentWeek);
  if(used.length){
    const usedWrap = document.createElement('div');
    usedWrap.className = 'lock-used-row';
    const label = document.createElement('div');
    label.className = 'lock-used-label';
    label.textContent = 'Locks used this season';
    usedWrap.appendChild(label);
    const chipList = document.createElement('div');
    chipList.className = 'lock-chip-list';
    used.sort((a, b) => a.week - b.week).forEach(u => {
      const st = getLockStatusForWeek(u.week);
      const chip = document.createElement('span');
      chip.className = 'lock-chip' + (st && st.result === 'win' ? ' win' : (st && st.result === 'loss' ? ' loss' : ''));
      chip.textContent = `Wk${u.week}: ${u.team}`;
      chipList.appendChild(chip);
    });
    usedWrap.appendChild(chipList);
    panel.appendChild(usedWrap);
  }
}


export function renderResultsEditor(panel, week){
  const wrap = document.createElement('div');
  wrap.className = 'spread-editor';

  const intro = document.createElement('p');
  intro.className = 'spread-editor-intro';
  intro.textContent = 'Mark who actually won each game, and enter the Monday Night combined final score for the tiebreaker. This publishes for every league at once and grades everyone\u2019s picks.';
  wrap.appendChild(intro);

  const rows = week.games.map(g => {
    const row = document.createElement('div');
    row.className = 'spread-edit-row results-edit-row';
    row.innerHTML = `<div class="spread-edit-matchup">${escapeHtml(g.away)} @ ${escapeHtml(g.home)}${g.isMNF ? ' <span class="mnf-tag">MNF</span>' : ''}</div>`;
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
    undoBtn.title = 'Undo this game\u2019s result';
    undoBtn.textContent = '\u21b6';
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
      clear: () => { selected = null; refresh(); if(scoreInput) scoreInput.value = ''; }
    };
  });
  rows.forEach(r => wrap.appendChild(r.row));

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

    const ok = await saveGlobalResults(store.currentWeek, resultsArr, mnfScore);
    if(ok){
      resultsArr.forEach(r => {
        const local = week.games.find(g => g.away === r.away && g.home === r.home);
        if(local) local.actualWinner = r.actualWinner;
      });
      week.mnfActualTotal = mnfScore;
      saveState();
      ui.resultsEditMode = false;
      render();
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Publish Results';
      setSyncStatus('Couldn\u2019t publish results right now \u2014 try again.');
    }
  };
  actionRow.appendChild(saveBtn);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'admin-kick-btn';
  resetBtn.textContent = 'Reset All';
  resetBtn.title = 'Clear every result on this screen (you\u2019ll still need to Save & Publish)';
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


export function renderSpreadEditor(panel, week){
  const wrap = document.createElement('div');
  wrap.className = 'spread-editor';

  const intro = document.createElement('p');
  intro.className = 'spread-editor-intro';
  intro.textContent = 'Set the spread, over/under and kickoff time for each game. Type either team\u2019s number and the other fills in automatically. This publishes for every league at once.';
  wrap.appendChild(intro);

  // Pull the current lines from ESPN into the form. Deliberately a button
  // rather than an automatic sync -- spreads moving under people mid-week
  // would change the board without anyone asking for it.
  const fetchRow = document.createElement('div');
  fetchRow.className = 'espn-fetch-row';
  const fetchBtn = document.createElement('button');
  fetchBtn.className = 'sync-btn';
  fetchBtn.textContent = '\u2193 Fetch lines from ESPN';
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
        <label>Kickoff<input type="datetime-local" class="se-kickoff" value="${isoToLocalInput(g.kickoff)}"></label>
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
      const { games, missing } = await fetchWeekOdds(store.currentWeek, CONFIG.seasonYear);
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

    const ok = await saveGlobalSpreads(store.currentWeek, gamesArr);
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
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save & Publish Spreads';
      setSyncStatus('Couldn\u2019t publish spreads right now \u2014 try again.');
    }
  };
  actionRow.appendChild(saveBtn);
  wrap.appendChild(actionRow);

  panel.appendChild(wrap);
}


export function renderGames(){
  const week = getWeek(store.currentWeek);
  const panel = document.getElementById('gamesPanel');
  panel.innerHTML = '';
  const notOpenYet = !isWeekOpen(store.currentWeek);
  const fullyLocked = isWeekFullyLocked(week);
  // Week-level gate: only true when nothing is editable any more.
  const locked = notOpenYet || fullyLocked;

  const label = document.createElement('div');
  label.className = 'section-label';
  label.innerHTML = `<span>Week ${store.currentWeek}</span>`;
  if(week.games.length){
    if(store.state.account.isLeagueAdmin){
      const editBtn = document.createElement('button');
      editBtn.className = 'sync-btn small';
      editBtn.textContent = ui.spreadEditMode ? 'Cancel Editing' : 'Update Spreads';
      editBtn.disabled = fullyLocked;
      editBtn.title = fullyLocked
        ? 'Every game has kicked off \u2014 spreads can\u2019t be changed anymore so no one gets caught out.'
        : 'Set the spread and kickoff time for each game';
      editBtn.onclick = () => {
        if(fullyLocked) return;
        ui.spreadEditMode = !ui.spreadEditMode;
        render();
      };
      label.appendChild(editBtn);

      const resultsBtn = document.createElement('button');
      resultsBtn.className = 'sync-btn small';
      resultsBtn.textContent = ui.resultsEditMode ? 'Cancel Editing' : 'Game Results';
      resultsBtn.onclick = () => {
        ui.resultsEditMode = !ui.resultsEditMode;
        ui.spreadEditMode = false;
        render();
      };
      label.appendChild(resultsBtn);
    }

    const clearAllBtn = document.createElement('button');
    clearAllBtn.className = 'sync-btn small';
    clearAllBtn.textContent = 'Clear All';
    clearAllBtn.disabled = locked;
    clearAllBtn.title = locked
      ? 'Every game has kicked off — nothing left to clear'
      : 'Clear picks and points for every game that hasn’t kicked off yet';
    let armed = false;
    let armTimer = null;
    clearAllBtn.onclick = () => {
      if(locked) return;
      if(!armed){
        armed = true;
        clearAllBtn.textContent = 'Confirm Clear?';
        clearAllBtn.classList.add('confirm-armed');
        armTimer = setTimeout(() => {
          armed = false;
          clearAllBtn.textContent = 'Clear All';
          clearAllBtn.classList.remove('confirm-armed');
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      openGames(week).forEach(g => {
        g.pick = null;
        g.confidence = null;
        if(g.isMNF) g.tiebreakGuess = null;
      });
      // Only drop the Survivor lock if that team hasn't played yet.
      if(!getSurvivorChoices(store.currentWeek).committed) week.lockTeam = null;
      saveState(); render();
    };
    label.appendChild(clearAllBtn);
  }
  panel.appendChild(label);

  if(store.state.account.isLeagueAdmin && ui.spreadEditMode && !fullyLocked && week.games.length){
    renderSpreadEditor(panel, week);
    return;
  }
  if(ui.spreadEditMode && fullyLocked) ui.spreadEditMode = false;

  if(store.state.account.isLeagueAdmin && ui.resultsEditMode && week.games.length){
    renderResultsEditor(panel, week);
    return;
  }

  if(!week.games.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `No matchups loaded for Week ${store.currentWeek} yet.<br>Weeks 16-18 depend on real-world flex scheduling and aren't set yet.`;
    panel.appendChild(empty);
    return;
  }

  const maxPts = maxPointsFor(week);

  week.games.forEach(game => {
    const row = document.createElement('div');
    row.className = 'game-row';
    let gradedClass = '';
    if(game.actualWinner && game.pick){
      gradedClass = game.pick === game.actualWinner ? 'correct' : 'incorrect';
    }
    row.className = 'game-row' + (game.actualWinner ? ' graded ' + gradedClass : '');

    // Each matchup closes at its own kickoff, independent of the rest of the slate.
    const gameLocked = notOpenYet || isGameLocked(game);
    if(gameLocked) row.classList.add('locked-game');

    // Left: matchup + team selection
    row.appendChild(teamButtonRow(game, 'pick', gameLocked));

    // Middle: confidence select
    const sel = document.createElement('select');
    sel.className = 'conf-select';
    sel.disabled = gameLocked;
    const noneOpt = document.createElement('option');
    noneOpt.value = ''; noneOpt.textContent = '—';
    sel.appendChild(noneOpt);
    const used = usedConfidenceValues(week, game.id);
    for(let v = maxPts; v >= 1; v--){
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if(used.has(v)) opt.disabled = true;
      if(game.confidence === v) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = () => { game.confidence = sel.value ? parseInt(sel.value) : null; saveState(); render(); };
    row.appendChild(sel);

    // Right: reset points
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const del = document.createElement('button');
    del.className = 'del-btn'; del.textContent = '✕'; del.title = 'Reset team pick and points for this matchup';
    del.disabled = gameLocked;
    del.onclick = () => {
      if(gameLocked) return;
      game.pick = null;
      game.confidence = null;
      saveState(); render();
    };
    actions.appendChild(del);
    row.appendChild(actions);

    panel.appendChild(row);
  });

  // ---- Submit / lock footer ----
  const footer = document.createElement('div');
  footer.className = 'submit-footer';
  const nextLock = nextLockTime(week);
  const stillOpen = openGames(week).length;
  const lockedCount = week.games.length - stillOpen;
  const fmtLock = (d) => d.toLocaleString('en-US', { weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit' });
  if(notOpenYet){
    const unlockAt = weekUnlockTime(store.currentWeek);
    const banner = document.createElement('div');
    banner.className = 'lock-banner opens-soon';
    banner.innerHTML = `🕐 <b>Week ${store.currentWeek} hasn\u2019t opened yet</b> — picks unlock ${unlockAt.toLocaleString('en-US', { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' })}.`;
    footer.appendChild(banner);
  } else if(locked){
    const banner = document.createElement('div');
    banner.className = 'lock-banner';
    banner.innerHTML = `🔒 <b>Week ${store.currentWeek} is locked</b> — every game has kicked off.`;
    footer.appendChild(banner);
  } else if(ui.showIncompleteWarning){
    const missing = getMissingItems(week);
    const warnBox = document.createElement('div');
    warnBox.className = 'lock-banner incomplete-warning';
    warnBox.innerHTML = `\u26a0\ufe0f <b>Your Week ${store.currentWeek} lineup isn\u2019t complete</b> \u2014 you\u2019re still missing ${missing.join(', ')}. Finish those before submitting.`;
    footer.appendChild(warnBox);
    const goBackBtn = document.createElement('button');
    goBackBtn.className = 'submit-btn complete';
    goBackBtn.textContent = 'Go Back';
    goBackBtn.onclick = () => {
      ui.showIncompleteWarning = false;
      render();
    };
    footer.appendChild(goBackBtn);
  } else {
    // Submitting marks the lineup done for the standings; it never freezes the
    // week. Anything that hasn't kicked off stays editable either way.
    if(week.submitted){
      const done = document.createElement('div');
      done.className = 'lock-banner submitted-note';
      done.innerHTML = `✅ <b>Lineup submitted</b> — you can still change any game that hasn’t kicked off.`;
      footer.appendChild(done);
    }
    const submitBtn = document.createElement('button');
    const complete = isWeekComplete(week);
    submitBtn.className = 'submit-btn' + (complete ? ' complete' : '');
    submitBtn.textContent = week.submitted ? 'Update Lineup' : 'Submit Picks';
    let armed = false;
    let armTimer = null;
    submitBtn.onclick = () => {
      if(!complete){
        ui.showIncompleteWarning = true;
        render();
        return;
      }
      if(!armed){
        armed = true;
        submitBtn.textContent = 'Confirm Submit?';
        submitBtn.classList.add('confirm-armed');
        armTimer = setTimeout(() => {
          armed = false;
          submitBtn.textContent = week.submitted ? 'Update Lineup' : 'Submit Picks';
          submitBtn.classList.remove('confirm-armed');
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      const firstTime = !week.submitted;
      week.submitted = true;
      saveState(); render();
      if(firstTime) burstConfetti(70);
    };
    footer.appendChild(submitBtn);
    if(nextLock){
      const note = document.createElement('div');
      note.className = 'lock-note';
      const scope = lockedCount
        ? `${lockedCount} of ${week.games.length} games already locked · next`
        : 'First game locks';
      note.textContent = `${scope} ${fmtLock(nextLock)} — each game locks at its own kickoff`;
      footer.appendChild(note);
    }
  }
  panel.appendChild(footer);
}


export function renderSummary(){
  const week = getWeek(store.currentWeek);
  const s = weekScore(week);
  const el = document.getElementById('weekSummary');
  el.innerHTML = '';

  const left = document.createElement('div');
  left.innerHTML = `<div class="big">${s.earned} / ${s.possible}</div><div class="sub">WEEK ${store.currentWeek} POINTS EARNED</div>`;
  el.appendChild(left);

  if(s.gradedCount > 0){
    const right = document.createElement('div');
    right.style.textAlign = 'right';
    right.innerHTML = `<div class="big">${s.correctCount} / ${s.gradedCount}</div><div class="sub">CORRECT PICKS GRADED</div>`;
    el.appendChild(right);
  }

  document.getElementById('weekTitle').textContent = 'Week ' + store.currentWeek;
  const maxPts = maxPointsFor(week);
  document.getElementById('weekMeta').innerHTML = week.games.length
    ? `${week.games.length} game${week.games.length===1?'':'s'} · points 1–<b>${maxPts}</b>`
    : 'Empty slate';

  // MVP pick of the week
  const mvpEl = document.getElementById('mvpCallout');
  const mvp = getMvpPick(week);
  if(mvp){
    const team = mvp.pick === 'home' ? mvp.home : mvp.away;
    mvpEl.style.display = 'flex';
    mvpEl.innerHTML = `<span class="mvp-star">\ud83c\udf1f</span> <span><b>MVP Pick:</b> ${escapeHtml(team)} nailed you <b>+${mvp.confidence}</b> points this week.</span>`;
  } else {
    mvpEl.style.display = 'none';
    mvpEl.innerHTML = '';
  }

  // Perfect Week celebration (fires confetti once per week)
  const perfectEl = document.getElementById('perfectWeekBanner');
  if(isPerfectWeek(week)){
    perfectEl.style.display = 'block';
    perfectEl.innerHTML = `\ud83c\udfc6 <b>PERFECT WEEK!</b> Every single pick hit in Week ${store.currentWeek}.`;
    if(!week.perfectCelebrated){
      week.perfectCelebrated = true;
      saveState();
      burstConfetti(90);
    }
  } else {
    perfectEl.style.display = 'none';
    perfectEl.innerHTML = '';
  }

  const season = seasonScore();
  document.getElementById('seasonNum').textContent = `${season.earned}`;

  const streakEl = document.getElementById('streakBadge');
  const streak = computeHotStreak();
  if(streak >= 2){
    streakEl.style.display = 'inline-flex';
    streakEl.textContent = `\ud83d\udd25 ${streak}-week streak`;
  } else {
    streakEl.style.display = 'none';
  }
}

