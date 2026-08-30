// League standings, weekly recap, achievements and the survivor board.
import { store, ui, peekWeek } from '../core/state.js';
import { TOTAL_WEEKS, CONFIG } from '../core/data.js';
import { getTeamAbbr, teamLogoUrl } from '../core/teams.js';
import { weekScore } from '../core/scoring.js';
import { getSurvivorStatus } from '../core/survivor.js';
import { fetchLeagueTeams, slugifyTeam, loadGlobalSpreads, syncToLeague } from '../core/league.js';
import { escapeHtml, ordinal, rankBadge, placeNickname, timeAgo, renderLoadFailure } from './dom.js';

// Staying alive in Survivor is worth a flat bonus on the Total column.
// Being eliminated never costs points -- it just means no bonus.
const SURVIVOR_BONUS = 50;

export function computeAchievements(teams){
  const badges = {};
  teams.forEach(t => { badges[t.teamName] = []; });

  const playedWeeks = new Set();
  teams.forEach(t => { if(t.weeklyPoints) Object.keys(t.weeklyPoints).forEach(w => playedWeeks.add(parseInt(w))); });
  const sortedWeeks = [...playedWeeks].sort((a, b) => a - b);
  if(!sortedWeeks.length) return badges;

  // Never missed a week
  teams.forEach(t => {
    const submitted = new Set(t.submittedWeeks || []);
    const missedAny = sortedWeeks.some(w => !submitted.has(w));
    if(!missedAny) badges[t.teamName].push({ icon: '📅', label: 'Never Missed a Week' });
  });

  // King-of-the-week streaks (3+ in a row)
  const kingPerWeek = {};
  sortedWeeks.forEach(w => {
    let best = null;
    teams.forEach(t => {
      if(t.weeklyPoints && t.weeklyPoints[w] != null){
        if(!best || t.weeklyPoints[w] > best.pts) best = { teamName: t.teamName, pts: t.weeklyPoints[w] };
      }
    });
    if(best) kingPerWeek[w] = best.teamName;
  });
  teams.forEach(t => {
    let streak = 0, maxStreak = 0;
    sortedWeeks.forEach(w => {
      if(kingPerWeek[w] === t.teamName){ streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    });
    if(maxStreak >= 3) badges[t.teamName].push({ icon: '👑', label: maxStreak + '-peat King' });
  });

  // Survivor milestones
  teams.forEach(t => {
    if(t.survivorAlive){
      badges[t.teamName].push({ icon: '🛡️', label: 'Survivor Alive' });
    } else if(t.survivorEliminatedWeek && t.survivorEliminatedWeek >= 10){
      badges[t.teamName].push({ icon: '🛡️', label: 'Survived to Wk ' + t.survivorEliminatedWeek });
    }
  });

  return badges;
}

export function buildStandingsRow(teamName, pts, rank, total, survivorAlive, isWeekly, badges){
  const row = document.createElement('div');
  const isMe = teamName === store.state.account.teamName;
  let cls = 'standings-row';
  if(survivorAlive !== undefined) cls += ' cols-full';
  if(isMe) cls += ' me';
  if(rank === 1) cls += ' first';
  if(total > 1 && rank === total) cls += ' last';
  row.className = cls;

  let avatarHtml = '';
  if(isMe){
    avatarHtml = store.state.account.profilePic
      ? `<img class="standings-avatar" src="${store.state.account.profilePic}" alt="">`
      : `<div class="standings-avatar placeholder">\ud83c\udfc8</div>`;
  }

  let teamLabel = escapeHtml(teamName);
  if(isWeekly && rank === 1) teamLabel = `<span class="crown-badge" title="King of the Week">\ud83d\udc51</span> ${teamLabel}`;
  if(isWeekly && total > 1 && rank === total) teamLabel = `${teamLabel} <span class="toilet-badge" title="Bottom of the week">\ud83d\udebd</span>`;

  let extraCols = '';
  if(survivorAlive !== undefined){
    const survivorHtml = survivorAlive
      ? '<span class="survivor-col alive">Alive</span>'
      : '<span class="survivor-col out">\u274c</span>';
    const bonus = survivorAlive ? SURVIVOR_BONUS : 0;
    const grandTotal = pts + bonus;
    extraCols = `
    <div class="survivor-cell">${survivorHtml}</div>
    <div class="total-cell"><span class="total-pts">${grandTotal}</span><span class="pts-label">TOTAL</span></div>`;
  }

  const badgesHtml = (badges && badges.length)
    ? `<span class="achievement-badges">${badges.map(b => `<span class="achievement-badge" title="${escapeHtml(b.label)}">${b.icon}</span>`).join('')}</span>`
    : '';

  row.innerHTML = `
    <div class="rank">${rankBadge(rank - 1)}</div>
    <div class="team-cell">
      <div class="team-id-row">
        ${avatarHtml}
        <div>
          <div class="team">${teamLabel}${badgesHtml}</div>
          <div class="nick">${placeNickname(rank, total)}</div>
        </div>
      </div>
    </div>
    <div class="pts-cell">
      <span class="pts">${pts}</span>
      <span class="pts-label">PTS</span>
    </div>${extraCols}`;
  return row;
}


export function updateHeaderRank(teams){
  const el = document.getElementById('seasonRank');
  if(!el) return;
  if(!store.state.account.teamName || !teams.length){ el.textContent = ''; return; }
  const sorted = teams.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
  const idx = sorted.findIndex(t => t.teamName === store.state.account.teamName);
  if(idx === -1){ el.textContent = ''; return; }
  el.textContent = 'You\u2019re in ' + ordinal(idx + 1) + ' place';
  el.classList.toggle('top', idx === 0);
}

export async function updateSeasonRank(){
  try{
    const teams = await fetchLeagueTeams();
    updateHeaderRank(teams);
  }catch(e){ /* leave rank badge blank on failure */ }
}


export async function renderWeekRecap(n, teams){
  const el = document.getElementById('weekRecapCard');
  el.innerHTML = '';
  const week = peekWeek(n);
  if(!week.games.length) return;
  const globalData = await loadGlobalSpreads(n);
  if(!globalData || !globalData.games) return;
  const allGraded = week.games.every(g => {
    const gs = globalData.games.find(x => x.away === g.away && x.home === g.home);
    return gs && gs.actualWinner;
  });
  if(!allGraded) return;

  const rows = teams.filter(t => t.weeklyPoints && t.weeklyPoints[n] != null)
    .map(t => ({ teamName: t.teamName, pts: t.weeklyPoints[n] }));
  rows.sort((a, b) => b.pts - a.pts);
  const king = rows[0];
  const toilet = rows.length > 1 ? rows[rows.length - 1] : null;

  const casualties = teams.filter(t => t.survivorEliminatedWeek === n);

  let closestLine = '';
  if(globalData.mnfFinalScore != null){
    const guessers = teams.filter(t => t.tiebreakGuesses && t.tiebreakGuesses[n] != null)
      .map(t => ({ teamName: t.teamName, guess: t.tiebreakGuesses[n], diff: Math.abs(t.tiebreakGuesses[n] - globalData.mnfFinalScore) }));
    if(guessers.length){
      guessers.sort((a, b) => a.diff - b.diff);
      const c = guessers[0];
      closestLine = `<div class="recap-line">🎯 <b>Closest Tiebreaker:</b> ${escapeHtml(c.teamName)} guessed ${c.guess} (actual was ${globalData.mnfFinalScore})</div>`;
    }
  }

  let upsetLine = '';
  let biggestUpset = null;
  week.games.forEach(g => {
    if(g.homeSpread == null) return;
    const gs = globalData.games.find(x => x.away === g.away && x.home === g.home);
    if(!gs || !gs.actualWinner) return;
    const favoriteSide = g.homeSpread < 0 ? 'home' : (g.homeSpread > 0 ? 'away' : null);
    if(!favoriteSide) return;
    const underdogWon = gs.actualWinner !== favoriteSide;
    if(underdogWon){
      const magnitude = Math.abs(g.homeSpread);
      if(!biggestUpset || magnitude > biggestUpset.magnitude){
        const winnerName = gs.actualWinner === 'away' ? g.away : g.home;
        biggestUpset = { magnitude, text: `${winnerName} won as a ${magnitude}-point underdog` };
      }
    }
  });
  if(biggestUpset) upsetLine = `<div class="recap-line">😱 <b>Biggest Upset:</b> ${escapeHtml(biggestUpset.text)}</div>`;

  let casualtyLine = '';
  if(casualties.length){
    const names = casualties.map(t => `${escapeHtml(t.teamName)} (${escapeHtml(t.survivorEliminatedTeam || 'their lock')})`).join(', ');
    casualtyLine = `<div class="recap-line">💀 <b>Survivor Casualt${casualties.length > 1 ? 'ies' : 'y'}:</b> ${names}</div>`;
  }

  el.innerHTML = `
    <div class="week-recap">
      <div class="week-recap-title">📋 Week ${n} Recap</div>
      ${king ? `<div class="recap-line">👑 <b>King of the Week:</b> ${escapeHtml(king.teamName)} (${king.pts} pts)</div>` : ''}
      ${toilet ? `<div class="recap-line">🚽 <b>Bottom of the Week:</b> ${escapeHtml(toilet.teamName)} (${toilet.pts} pts)</div>` : ''}
      ${casualtyLine}
      ${closestLine}
      ${upsetLine}
    </div>`;
}


export async function renderStandingsPage(){
  const selectEl = document.getElementById('standingsFilterSelect');
  if(!selectEl.dataset.built){
    const overallOpt = document.createElement('option');
    overallOpt.value = 'overall'; overallOpt.textContent = 'Overall Standings';
    selectEl.appendChild(overallOpt);
    for(let n=1;n<=TOTAL_WEEKS;n++){
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = 'Week ' + n;
      selectEl.appendChild(opt);
    }
    selectEl.onchange = () => {
      ui.standingsFilter = selectEl.value === 'overall' ? 'overall' : parseInt(selectEl.value);
      renderStandingsPage();
    };
    selectEl.dataset.built = '1';
  }
  selectEl.value = String(ui.standingsFilter);

  const listEl = document.getElementById('standingsList');
  const highlightEl = document.getElementById('standingsHighlight');
  listEl.innerHTML = '<div class="empty">Loading league standings…</div>';
  highlightEl.innerHTML = '';

  await syncToLeague();

  let teams = [];
  try{
    teams = await fetchLeagueTeams();
  }catch(e){
    console.error('standings load failed', e);
    renderLoadFailure(listEl, {
      message: 'Couldn\u2019t load the standings.',
      onRetry: () => renderStandingsPage(),
    });
    return;
  }

  updateHeaderRank(teams);
  renderSurvivorList(teams);

  if(!teams.length){
    listEl.innerHTML = '<div class="empty">No teams have joined the league yet.<br>Set a Team Name in Account to show up here.</div>';
    return;
  }

  listEl.innerHTML = '';

  if(ui.standingsFilter === 'overall'){
    document.getElementById('weekRecapCard').innerHTML = '';
    teams.forEach(t => { t._grandTotal = (t.total || 0) + (t.survivorAlive ? SURVIVOR_BONUS : 0); });
    teams.sort((a, b) => b._grandTotal - a._grandTotal);
    const achievements = computeAchievements(teams);
    const colHeader = document.createElement('div');
    colHeader.className = 'standings-col-header';
    colHeader.innerHTML = `<span></span><span>Team</span><span>Points</span><span>Survivor</span><span>Total</span>`;
    listEl.appendChild(colHeader);
    teams.forEach((t, i) => {
      listEl.appendChild(buildStandingsRow(t.teamName, t.total || 0, i + 1, teams.length, !!t.survivorAlive, false, achievements[t.teamName]));
    });
  } else {
    const n = ui.standingsFilter;
    renderWeekRecap(n, teams);
    const rows = teams
      .filter(t => t.weeklyPoints && t.weeklyPoints[n] != null)
      .map(t => ({ teamName: t.teamName, pts: t.weeklyPoints[n] }));
    rows.sort((a, b) => b.pts - a.pts);

    if(rows.length){
      const highest = rows[0], lowest = rows[rows.length - 1];
      highlightEl.innerHTML = `
        <div class="standings-highlight-row">
          <div class="hl-card hi">
            <div class="hl-label">\ud83c\udfc6 Highest \u2014 Week ${n}</div>
            <div class="hl-team">${escapeHtml(highest.teamName)}</div>
            <div class="hl-pts">${highest.pts} pts</div>
          </div>
          <div class="hl-card lo">
            <div class="hl-label">\ud83e\udd76 Lowest \u2014 Week ${n}</div>
            <div class="hl-team">${escapeHtml(lowest.teamName)}</div>
            <div class="hl-pts">${lowest.pts} pts</div>
          </div>
        </div>`;
    }

    if(!rows.length){
      listEl.innerHTML = `<div class="empty">No team has points logged for Week ${n} yet.</div>`;
    } else {
      rows.forEach((t, i) => {
        listEl.appendChild(buildStandingsRow(t.teamName, t.pts, i + 1, rows.length, undefined, true));
      });
    }
  }
}


export function renderSurvivorList(teams){
  const el = document.getElementById('survivorList');
  if(!el) return;
  el.innerHTML = '';
  if(!teams.length){
    el.innerHTML = '<div class="empty">No teams have joined the league yet.</div>';
    return;
  }
  const sorted = teams.slice().sort((a, b) => {
    if(!!a.survivorAlive !== !!b.survivorAlive) return a.survivorAlive ? -1 : 1;
    if(!a.survivorAlive && !b.survivorAlive) return (b.survivorEliminatedWeek || 0) - (a.survivorEliminatedWeek || 0);
    return (b.total || 0) - (a.total || 0);
  });
  sorted.forEach(t => {
    const row = document.createElement('div');
    row.className = 'standings-row' + (t.teamName === store.state.account.teamName ? ' me' : '') + (t.survivorAlive ? '' : ' last');
    // Double elimination, so someone still alive may be carrying a strike.
    const strikes = t.survivorStrikes || 0;
    const statusHtml = t.survivorAlive
      ? (strikes
          ? `<span class="survivor-badge warn">${strikes} strike${strikes === 1 ? '' : 's'}</span>`
          : `<span class="survivor-badge alive">Alive</span>`)
      : `<span class="survivor-badge out">Out \u2014 Wk ${t.survivorEliminatedWeek}${t.survivorEliminatedTeam ? ' (' + escapeHtml(t.survivorEliminatedTeam) + ')' : ''}</span>`;
    const lockHtml = t.currentLockTeam ? `<div class="nick">Wk ${t.currentLockWeek} lock: ${escapeHtml(t.currentLockTeam)}</div>` : '';
    row.innerHTML = `
      <div class="rank">${t.survivorAlive ? '\ud83d\udd12' : '\ud83d\udc80'}</div>
      <div class="team-cell">
        <div class="team">${escapeHtml(t.teamName)}</div>
        ${lockHtml}
      </div>
      <div class="pts-cell">${statusHtml}</div>`;
    el.appendChild(row);
  });
}

