// League standings, weekly recap, achievements and the survivor board.
import { store, ui, peekWeek } from '../core/state.js';
import { TOTAL_WEEKS, CONFIG } from '../core/data.js';
import { getTeamAbbr, teamLogoUrl } from '../core/teams.js';
import { weekScore, isWeekFullyGraded } from '../core/scoring.js';
import { getSurvivorStatus } from '../core/survivor.js';
import {
  fetchLeagueTeams, slugifyTeam, loadGlobalSpreads, syncToLeague, getLeagueMeta,
} from '../core/league.js';
import { escapeHtml, ordinal, rankBadge, placeNickname, timeAgo, renderLoadFailure } from './dom.js';

// Survivor is its own contest. It used to add a flat 50 to a "Total" column,
// which meant the board could rank someone above a player with more points, and
// the 50 was there from Week 1 before anybody had locked anything. It's now
// tracked alongside the points and never mixed into them -- so the standings
// rank on points, full stop, and the Survivor column says where you stand in
// the other game.

// Members flagged on the Admin page as playing for money, by team name. Stored
// on the league document rather than the member row: a member's own sync writes
// their row wholesale, so a flag kept there would be wiped every time they
// touched a pick.
let moneyNames = new Set();

/** True if this team is flagged as playing for money. */
export function playsForMoney(teamName){ return moneyNames.has(teamName); }

/**
 * Standard competition ranking: equal scores share a place, and the next
 * distinct score skips the places the tie used up -- 1, 1, 3, 4 rather than
 * 1, 2, 3, 4.
 *
 * `rows` must already be sorted best-first. Returns one rank per row, in the
 * same order.
 */
export function competitionRanks(rows, valueOf){
  const ranks = [];
  rows.forEach((row, i) => {
    const tiedWithPrevious = i > 0 && valueOf(row) === valueOf(rows[i - 1]);
    ranks.push(tiedWithPrevious ? ranks[i - 1] : i + 1);
  });
  return ranks;
}

/**
 * Where each place sits in the table, given a list of ranks.
 *
 * Last place can't be found by comparing a rank to the number of rows once ties
 * exist -- in 1, 1, 3, 3 nobody holds rank 4 -- so the bottom two places are
 * worked out from the distinct ranks actually present.
 */
export function placeShape(ranks){
  const distinct = [...new Set(ranks)];
  return {
    lastRank: distinct[distinct.length - 1],
    secondLastRank: distinct.length > 1 ? distinct[distinct.length - 2] : null,
    places: distinct.length,
  };
}

/**
 * Season points: the sum of the weeks, added up here rather than read from the
 * stored `total`.
 *
 * The two should agree -- the same client writes both -- but only one of them is
 * what the weekly tabs show. Summing what's displayed means the Overall column
 * can always be checked against the weeks it came from.
 */
export function seasonPoints(team){
  const weekly = team.weeklyPoints || {};
  return Object.keys(weekly).reduce((sum, w) => sum + (weekly[w] || 0), 0);
}

/**
 * The season's highest single-week scores, whoever posted them.
 *
 * Not one per person -- these are the best weeks, so the same player can hold
 * more than one place. Only fully graded weeks count: a week still in progress
 * carries a partial score that isn't comparable to a finished one.
 */
export function bestWeeks(teams, limit = 3){
  const graded = new Set();
  for(let n = 1; n <= TOTAL_WEEKS; n++){
    const w = peekWeek(n);
    if(w.games.length && isWeekFullyGraded(w)) graded.add(n);
  }
  const rows = [];
  teams.forEach(t => {
    const weekly = t.weeklyPoints || {};
    Object.keys(weekly).forEach(key => {
      const week = parseInt(key, 10);
      const pts = weekly[key];
      if(pts == null || !graded.has(week)) return;
      rows.push({ teamName: t.teamName, week, pts });
    });
  });
  // Ties go to the earlier week, then alphabetically, so the order is stable
  // rather than dependent on whatever order the roster came back in.
  rows.sort((a, b) => b.pts - a.pts || a.week - b.week || a.teamName.localeCompare(b.teamName));
  if(rows.length <= limit) return rows;
  // Two weeks on the same score are the same placing, so a tie at the cutoff
  // shows both rather than dropping one on a coin flip.
  const cutoff = rows[limit - 1].pts;
  return rows.filter((r, i) => i < limit || r.pts === cutoff);
}

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

  // King-of-the-week streaks (3+ in a row). A tied top score crowns everyone on
  // it -- keeping only the first team found would have quietly broken someone's
  // streak on a week they didn't lose.
  const kingsPerWeek = {};
  sortedWeeks.forEach(w => {
    let bestPts = null;
    teams.forEach(t => {
      const pts = t.weeklyPoints && t.weeklyPoints[w];
      if(pts == null) return;
      if(bestPts === null || pts > bestPts) bestPts = pts;
    });
    if(bestPts === null) return;
    kingsPerWeek[w] = new Set(
      teams.filter(t => t.weeklyPoints && t.weeklyPoints[w] === bestPts).map(t => t.teamName));
  });
  teams.forEach(t => {
    let streak = 0, maxStreak = 0;
    sortedWeeks.forEach(w => {
      if(kingsPerWeek[w] && kingsPerWeek[w].has(t.teamName)){ streak++; maxStreak = Math.max(maxStreak, streak); }
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

/**
 * One standings row.
 *
 * Takes an options object rather than eight positional arguments: `rank` and
 * "is this last place" stopped being the same question once ties could share a
 * place, and the call sites are clearer for naming what they mean.
 */
export function buildStandingsRow({
  teamName, pts, rank, total, survivorAlive, isWeekly, badges,
  isLast = false, isSecondLast = false,
}){
  const row = document.createElement('div');
  const isMe = teamName === store.state.account.teamName;
  let cls = 'standings-row';
  if(survivorAlive !== undefined) cls += ' cols-full';
  if(isMe) cls += ' me';
  if(rank === 1) cls += ' first';
  if(total > 1 && isLast) cls += ' last';
  row.className = cls;

  let avatarHtml = '';
  if(isMe){
    avatarHtml = store.state.account.profilePic
      ? `<img class="standings-avatar" src="${escapeHtml(store.state.account.profilePic)}" alt="" onerror="this.remove()">`
      : `<div class="standings-avatar placeholder">\ud83c\udfc8</div>`;
  }

  let teamLabel = escapeHtml(teamName);
  if(playsForMoney(teamName)){
    teamLabel = '<span class="money-badge" title="Playing for money">$</span> ' + teamLabel;
  }
  // A shared top or bottom score means everyone on it gets the badge.
  if(isWeekly && rank === 1) teamLabel = `<span class="crown-badge" title="King of the Week">\ud83d\udc51</span> ${teamLabel}`;
  if(isWeekly && total > 1 && isLast) teamLabel = `${teamLabel} <span class="toilet-badge" title="Bottom of the week">\ud83d\udebd</span>`;

  let extraCols = '';
  if(survivorAlive !== undefined){
    const survivorHtml = survivorAlive
      ? '<span class="survivor-col alive">Alive</span>'
      : '<span class="survivor-col out">\u274c</span>';
    // No Total column any more: with the bonus gone it only ever repeated the
    // Points column beside it.
    extraCols = `<div class="survivor-cell">${survivorHtml}</div>`;
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
          <div class="nick">${placeNickname(rank, total, isLast, isSecondLast)}</div>
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
  // Must rank on the same number the Overall table shows, or the header claims
  // a place the table contradicts.
  const sorted = teams.slice().sort((a, b) => seasonPoints(b) - seasonPoints(a));
  const idx = sorted.findIndex(t => t.teamName === store.state.account.teamName);
  if(idx === -1){ el.textContent = ''; return; }
  const ranks = competitionRanks(sorted, seasonPoints);
  const myRank = ranks[idx];
  // "2nd place" reads as sole possession of it. Say so when it isn't.
  const shared = ranks.filter(r => r === myRank).length > 1;
  el.textContent = shared
    ? 'You\u2019re tied for ' + ordinal(myRank) + ' place'
    : 'You\u2019re in ' + ordinal(myRank) + ' place';
  el.classList.toggle('top', myRank === 1);
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
  // A shared top score means joint kings, not whichever row happened to sort
  // first. And if everybody is level there is no bottom of the week.
  const topPts = rows.length ? rows[0].pts : null;
  const bottomPts = rows.length ? rows[rows.length - 1].pts : null;
  const kings = rows.filter(r => r.pts === topPts);
  const bottoms = (rows.length > 1 && bottomPts !== topPts)
    ? rows.filter(r => r.pts === bottomPts) : [];
  const names = (list) => list.map(r => escapeHtml(r.teamName)).join(' & ');

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
      ${kings.length ? `<div class="recap-line">👑 <b>King${kings.length > 1 ? 's' : ''} of the Week:</b> ${names(kings)} (${topPts} pts)</div>` : ''}
      ${bottoms.length ? `<div class="recap-line">🚽 <b>Bottom of the Week:</b> ${names(bottoms)} (${bottomPts} pts)</div>` : ''}
      ${casualtyLine}
      ${closestLine}
      ${upsetLine}
    </div>`;
}


/**
 * Reads the money flags off the league doc and resolves them to team names.
 *
 * Stored by member doc id rather than team name, so a rename doesn't drop the
 * flag; resolved to names here because this is the one place the roster and the
 * league document are both in hand.
 */
async function loadMoneyFlags(teams){
  try{
    const meta = await getLeagueMeta(store.state.account.leagueSlug);
    const flags = (meta && meta.playsForMoney) || {};
    moneyNames = new Set(teams.filter(t => flags[t.key]).map(t => t.teamName));
  }catch(e){
    // A league doc we couldn't read just means no dollar signs on this render.
    moneyNames = new Set();
  }
}

/** The season's three best single weeks, shown above the Overall table. */
function renderBestWeeks(el, teams){
  const best = bestWeeks(teams, 3);
  if(!best.length) return;
  const medals = ['🥇', '🥈', '🥉'];
  // Equal scores share a medal, so two 91s are both silver and nothing is
  // bronze -- the same rule as the standings.
  const ranks = competitionRanks(best, b => b.pts);
  el.innerHTML = `
    <div class="best-weeks">
      <div class="best-weeks-title">🔥 Best Weeks of the Season</div>
      <div class="best-weeks-list">
        ${best.map((b, i) => `
          <div class="best-week-row${b.teamName === store.state.account.teamName ? ' me' : ''}">
            <span class="bw-medal">${medals[ranks[i] - 1] || ''}</span>
            <span class="bw-team">${escapeHtml(b.teamName)}</span>
            <span class="bw-week">Week ${b.week}</span>
            <span class="bw-pts">${b.pts}<span class="bw-pts-label">pts</span></span>
          </div>`).join('')}
      </div>
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

  await loadMoneyFlags(teams);
  updateHeaderRank(teams);
  renderSurvivorList(teams);

  if(!teams.length){
    listEl.innerHTML = '<div class="empty">No teams have joined the league yet.<br>Set a Team Name in Account to show up here.</div>';
    return;
  }

  listEl.innerHTML = '';

  if(ui.standingsFilter === 'overall'){
    document.getElementById('weekRecapCard').innerHTML = '';
    teams.forEach(t => { t._seasonPoints = seasonPoints(t); });
    teams.sort((a, b) => b._seasonPoints - a._seasonPoints);
    renderBestWeeks(highlightEl, teams);
    const achievements = computeAchievements(teams);
    const colHeader = document.createElement('div');
    colHeader.className = 'standings-col-header';
    colHeader.innerHTML = `<span></span><span>Team</span><span>Points</span><span>Survivor</span>`;
    listEl.appendChild(colHeader);
    const ranks = competitionRanks(teams, t => t._seasonPoints);
    const shape = placeShape(ranks);
    teams.forEach((t, i) => {
      listEl.appendChild(buildStandingsRow({
        teamName: t.teamName,
        pts: t._seasonPoints,
        rank: ranks[i],
        total: teams.length,
        survivorAlive: !!t.survivorAlive,
        isWeekly: false,
        badges: achievements[t.teamName],
        isLast: ranks[i] === shape.lastRank,
        // Only meaningful once there are more than two places to be in.
        isSecondLast: shape.places > 2 && ranks[i] === shape.secondLastRank,
      }));
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
      const ranks = competitionRanks(rows, r => r.pts);
      const shape = placeShape(ranks);
      rows.forEach((t, i) => {
        listEl.appendChild(buildStandingsRow({
          teamName: t.teamName,
          pts: t.pts,
          rank: ranks[i],
          total: rows.length,
          survivorAlive: undefined,
          isWeekly: true,
          isLast: ranks[i] === shape.lastRank,
          isSecondLast: shape.places > 2 && ranks[i] === shape.secondLastRank,
        }));
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

