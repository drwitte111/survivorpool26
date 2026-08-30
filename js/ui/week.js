// The week page: matchup rows, the survivor lock panel, and the week summary.
// The admin spread and results editors live on the Admin page now (ui/admin.js).
import { store, ui, getWeek, peekWeek } from '../core/state.js';
import { TEAM_LIST, CONFIG } from '../core/data.js';
import { getTeamAbbr, getTeamColors, teamLogoUrl, teamAbbrEquals } from '../core/teams.js';
import { saveState } from '../core/persist.js';
import {
  isGameLocked, isWeekFullyLocked, openGames, nextLockTime,
  isWeekOpen, isWeekComplete, getMissingItems, weekUnlockTime,
} from '../core/locks.js';
import {
  maxPointsFor, weekScore, seasonScore, assignConfidence, canShiftTo, shiftCount,
  getMvpPick, isPerfectWeek, computeHotStreak,
} from '../core/scoring.js';
import {
  getLockStatusForWeek, getUsedLockTeams, getSurvivorStatus,
  getSurvivorChoices, survivorPickError,
} from '../core/survivor.js';
import { escapeHtml, burstConfetti, timeAgo } from './dom.js';
import { formatInZone, zoneLabel } from '../core/tz.js';
import { render } from './router.js';
import { refreshWeek } from '../core/refresh.js';
import { confirmDialog } from './confirm.js';

/**
 * True when the spread has moved since this pick was made. Drives the yellow
 * highlight and the offer to take the new number.
 */
export function lineMoved(game){
  return !!game.pick
    && game.pickedSpread != null
    && game.homeSpread != null
    && game.pickedSpread !== game.homeSpread;
}

/**
 * The spread this pick is judged against: the line showing when it was made.
 * Falls back to what the game closed at, then to the current number, so picks
 * from before this was recorded still work.
 */
export function spreadForPick(game){
  return game.pickedSpread ?? game.closingSpread ?? game.homeSpread ?? null;
}

export function coverStatus(game, side){
  const spread = spreadForPick(game);
  if(spread == null) return null;
  if(game.liveAway == null || game.liveHome == null || isNaN(game.liveAway) || isNaN(game.liveHome)) return null;
  const margin = side === 'home' ? (game.liveHome - game.liveAway) : (game.liveAway - game.liveHome);
  const spreadForSide = side === 'home' ? spread : -spread;
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

    // The spread rides on the button rather than in a separate bar below. Same
    // information, roughly half the row height, so more of the slate fits on
    // one screen.
    if(mode === 'pick' && game.homeSpread != null){
      const num = side === 'home' ? game.homeSpread : -game.homeSpread;
      const sp = document.createElement('span');
      sp.className = 'tb-spread' + (num < 0 ? ' fav' : '');
      sp.textContent = num > 0 ? '+' + num : String(num);
      btn.appendChild(sp);
    }
    btn.disabled = disablePicks;
    btn.onclick = () => {
      if(disablePicks) return;
      const clearing = game[field] === side;
      game[field] = clearing ? null : side;
      // Record the line as it stood the moment the pick was made. This is the
      // number that actually matters -- it's what the person was looking at --
      // and capturing it here means nothing has to be raced against kickoff.
      if(mode === 'pick'){
        if(clearing){
          game.pickedSpread = null;
          game.pickedOverUnder = null;
          game.pickedAt = null;
        } else {
          game.pickedSpread = game.homeSpread ?? null;
          game.pickedOverUnder = game.overUnder ?? null;
          game.pickedAt = new Date().toISOString();
        }
      }
      saveState(); render();
    };
  });
  wrap.appendChild(awayBtn);
  const vs = document.createElement('span'); vs.className='vs'; vs.textContent='@';
  wrap.appendChild(vs);
  wrap.appendChild(homeBtn);

  // Everything secondary -- the total, and either the kickoff time or the live
  // score -- shares one line. Stacked, they were most of the row's height.
  const meta = document.createElement('div');
  meta.className = 'game-meta';

  {
    const fmt = (v) => v > 0 ? '+' + v : String(v);
    // Spreads sit on the team buttons now; only the total needs its own slot.
    // Reference only -- nothing scores off it, but it frames the MNF tiebreaker.
    if(game.overUnder != null){
      const ou = document.createElement('span');
      ou.className = 'odds-total-line';
      ou.innerHTML = `O/U <b>${game.overUnder}</b>`;
      meta.appendChild(ou);
    }

    // The line has moved since this pick was made. Show both numbers side by
    // side and offer to take the new one -- your pick is still judged against
    // the old one until you say otherwise.
    if(mode === 'pick' && lineMoved(game)){
      const forSide = (v) => fmt(game.pick === 'home' ? v : -v);
      const moved = document.createElement('div');
      moved.className = 'line-moved-row';
      moved.innerHTML =
        `<span class="lm-label">Line moved</span>`
        + `<span class="lm-pair"><span class="lm-yours">yours <b>${forSide(game.pickedSpread)}</b></span>`
        + `<span class="lm-arrow">→</span>`
        + `<span class="lm-now">now <b>${forSide(game.homeSpread)}</b></span></span>`;

      // Only offered while the game is still open; once it kicks off, what you
      // took is settled.
      if(!locked){
        const take = document.createElement('button');
        take.type = 'button';
        take.className = 'lm-take-btn';
        take.textContent = `Take ${forSide(game.homeSpread)}`;
        take.title = 'Judge this pick against the current line instead';
        take.onclick = (e) => {
          e.stopPropagation();
          game.pickedSpread = game.homeSpread;
          game.pickedOverUnder = game.overUnder ?? game.pickedOverUnder;
          game.pickedAt = new Date().toISOString();
          saveState(); render();
        };
        moved.appendChild(take);
      }
      // Full width below the meta line -- it carries a button and matters.
      wrap.appendChild(meta);
      wrap.appendChild(moved);
      meta.dataset.placed = '1';
    }
  }

  if(game.gameState === 'in' || game.gameState === 'post'){
    const score = document.createElement('div');
    score.className = 'score-line';
    const tag = document.createElement('span');
    tag.className = 'status-tag ' + (game.gameState === 'in' ? 'live' : 'final');
    tag.textContent = game.gameState === 'in' ? (game.statusDetail || 'LIVE') : 'FINAL';
    score.appendChild(tag);

    // Bold the side that's ahead so the result reads at a glance.
    const a = game.liveAway, h = game.liveHome;
    const hasScores = a != null && h != null;
    const lead = hasScores ? (a > h ? 'away' : h > a ? 'home' : null) : null;
    // Both spellings are rendered; CSS picks one, so a phone shows "DAL 20"
    // where a desktop shows "Dallas Cowboys 20" without re-rendering.
    const sideHtml = (side, name, pts) => {
      const abbr = (getTeamAbbr(name) || name).toUpperCase();
      return `<span class="score-team${lead === side ? ' leading' : ''}">`
           + `<span class="score-team-full">${escapeHtml(name)}</span>`
           + `<span class="score-team-abbr">${escapeHtml(abbr)}</span>`
           + ` <b>${pts ?? '-'}</b></span>`;
    };
    const scoreText = document.createElement('span');
    scoreText.className = 'score-teams';
    scoreText.innerHTML = sideHtml('away', game.away, a) + '<span class="score-dash">—</span>' + sideHtml('home', game.home, h);
    score.appendChild(scoreText);

    // "who won by how much", spelled out rather than left to mental arithmetic.
    if(hasScores){
      const margin = Math.abs(a - h);
      const winner = lead === 'away' ? game.away : lead === 'home' ? game.home : null;
      const verdict = document.createElement('span');
      verdict.className = 'score-margin';
      if(!winner){
        verdict.textContent = game.gameState === 'post' ? 'Tie — no points' : 'Tied';
      } else {
        verdict.textContent = game.gameState === 'post'
          ? `${getTeamAbbr(winner)?.toUpperCase() || winner} by ${margin}`
          : `${getTeamAbbr(winner)?.toUpperCase() || winner} +${margin}`;
      }
      score.appendChild(verdict);
    }
    meta.appendChild(score);
  } else if(game.kickoff){
    const ko = document.createElement('span');
    ko.className = 'kickoff';
    try{
      ko.textContent = formatInZone(game.kickoff, { weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit' }) + ' ' + zoneLabel();
    }catch(e){ ko.textContent = ''; }
    meta.appendChild(ko);
  }

  // Placed after the line-moved banner above, if that already inserted it.
  if(!meta.dataset.placed && meta.childElementCount) wrap.appendChild(meta);

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
  header.innerHTML = `<div class="lock-title">Survivor <span>🔒</span></div>`;
  const badge = document.createElement('div');
  // Double elimination, so "alive" has two flavours: clean, or carrying a strike.
  const carryingStrike = survivor.alive && survivor.strikes > 0;
  badge.className = 'survivor-badge ' + (survivor.alive ? (carryingStrike ? 'warn' : 'alive') : 'out');
  badge.textContent = survivor.alive
    ? (carryingStrike
        ? `${survivor.strikes} strike${survivor.strikes === 1 ? '' : 's'} — ${survivor.strikesAllowed - survivor.strikes} left`
        : 'Alive')
    : (eliminatedThisWeek ? 'Eliminated this week' : `Eliminated Wk ${survivor.eliminatedWeek}`);
  header.appendChild(badge);
  panel.appendChild(header);

  if(!week.games.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Load this week’s matchups above before setting your Survivor pick.';
    panel.appendChild(empty);
    return;
  }

  if(eliminatedBeforeThisWeek){
    const msg = document.createElement('div');
    msg.className = 'lock-eliminated-msg';
    const lossList = survivor.losses
      .map(l => `<b>${escapeHtml(l.team)}</b> (Wk ${l.week})`).join(' and ');
    msg.innerHTML = `You’re out of the Survivor pool — ${survivor.strikesAllowed} losing locks: ${lossList}. `
      + `Your confidence picks keep going, but there’s no lock pick to make here anymore.`;
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
      errorEl.textContent = `"${typed}" isn’t one of this week’s teams.`;
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
    const label = status.result === 'pending' ? '⏳ Pending' : (status.result === 'win' ? '✅ Survived' : '❌ Eliminated');
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


// When the spreads and over/unders on this page were last updated, and where
// they came from -- an admin publishing them, or the automatic ESPN pull. Worth
// showing on the picks page because a stale line is the one thing that would
// quietly mislead someone mid-week.
function oddsFreshnessRow(week){
  const bar = document.createElement('div');
  bar.className = 'odds-freshness';

  const withOdds = week.games.filter(g => g.homeSpread != null || g.overUnder != null).length;
  const info = document.createElement('span');
  info.className = 'odds-freshness-text';

  if(!week.oddsUpdatedAt){
    info.textContent = withOdds
      ? 'Spreads & O/U — source unknown'
      : 'Spreads & O/U not loaded yet';
  } else {
    const when = new Date(week.oddsUpdatedAt);
    const source = week.oddsSource === 'published' ? 'published by an admin' : 'pulled from ESPN';
    info.textContent = `Spreads & O/U ${source} ${timeAgo(week.oddsUpdatedAt)}`;
    info.title = `${withOdds} of ${week.games.length} games have a line · `
      + formatInZone(when, { dateStyle: 'medium', timeStyle: 'short' }) + ' ' + zoneLabel(when);
  }
  bar.appendChild(info);

  // Manual re-check, for when a line has clearly moved and you don't want to
  // wait for the next automatic poll.
  const btn = document.createElement('button');
  btn.className = 'odds-refresh-btn';
  btn.textContent = 'Refresh';
  btn.title = 'Check ESPN for updated spreads, over/unders and scores';
  btn.onclick = async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Checking…';
    try{
      await refreshWeek(store.currentWeek);
      saveState();
      render();
    }catch(e){
      btn.textContent = original;
      btn.disabled = false;
      info.textContent = 'Couldn’t reach ESPN just now — showing the last known numbers.';
    }
  };
  bar.appendChild(btn);
  return bar;
}

/**
 * The week's games in display order. Sorting is a view concern only -- the
 * stored order stays the real slate order, so confidence values, the MNF game
 * and everything else are unaffected.
 *
 * Games with no points yet sort to the end either way; they're the ones still
 * needing attention, and burying them among numbered rows hides that.
 */
export function sortedGames(week){
  const games = week.games.slice();
  const mode = ui.gameSort || 'kickoff';
  if(mode === 'kickoff') return games;

  const dir = mode === 'points-asc' ? 1 : -1;
  return games.sort((a, b) => {
    const av = a.confidence, bv = b.confidence;
    if(av == null && bv == null) return 0;
    if(av == null) return 1;
    if(bv == null) return -1;
    return (av - bv) * dir;
  });
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
    const sortWrap = document.createElement('div');
    sortWrap.className = 'game-sort';
    [['kickoff', 'Kickoff', 'Real slate order'],
     ['points-desc', 'Pts ↓', 'Highest points first'],
     ['points-asc', 'Pts ↑', 'Lowest points first']].forEach(([mode, text, title]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'game-sort-btn' + ((ui.gameSort || 'kickoff') === mode ? ' active' : '');
      b.textContent = text;
      b.title = title;
      b.onclick = () => { ui.gameSort = mode; render(); };
      sortWrap.appendChild(b);
    });
    label.appendChild(sortWrap);
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

  if(week.games.length) panel.appendChild(oddsFreshnessRow(week));

  if(!week.games.length){
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `No matchups loaded for Week ${store.currentWeek} yet.<br>Weeks 16-18 depend on real-world flex scheduling and aren't set yet.`;
    panel.appendChild(empty);
    return;
  }

  const maxPts = maxPointsFor(week);

  sortedGames(week).forEach(game => {
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
    // Stands out in a 16-row list -- easy to miss otherwise.
    if(lineMoved(game)) row.classList.add('line-moved');

    // Left: matchup + team selection
    row.appendChild(teamButtonRow(game, 'pick', gameLocked));

    // Middle: confidence select
    //
    // Every value stays pickable. Choosing one that's already in use reorders
    // the week rather than refusing: the games between here and there each
    // shift a step, so the numbers stay 1..N with no repeats. A value is only
    // offered if that shift wouldn't have to renumber a game that has already
    // kicked off, since those points are settled.
    const canMove = (g) => !isGameLocked(g);
    const sel = document.createElement('select');
    sel.className = 'conf-select';
    sel.disabled = gameLocked;
    const noneOpt = document.createElement('option');
    noneOpt.value = ''; noneOpt.textContent = '—';
    sel.appendChild(noneOpt);
    const holderOf = (v) => week.games.find(g => g.id !== game.id && g.confidence === v);
    for(let v = maxPts; v >= 1; v--){
      const opt = document.createElement('option');
      opt.value = v;
      const holder = holderOf(v);
      // Marked so you can see at a glance which numbers are spoken for. Still
      // selectable -- the label is a reference, not a barrier.
      opt.textContent = holder ? `${v} (used)` : String(v);
      if(holder) opt.className = 'in-use';
      // Dry run on a copy, so a genuinely unreachable value is disabled rather
      // than silently doing nothing when picked.
      if(v !== game.confidence && !canShiftTo(week, game, v, canMove)) opt.disabled = true;
      if(game.confidence === v) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.onchange = async () => {
      const next = sel.value ? parseInt(sel.value) : null;
      const revert = () => { sel.value = game.confidence == null ? '' : String(game.confidence); };

      // Taking a number off another game moves rows that are usually off-screen,
      // so say what's about to happen first.
      const holder = next == null ? null : holderOf(next);
      if(holder){
        const others = shiftCount(week, game, next, canMove);
        const ok = await confirmDialog({
          title: `Give ${next} point${next === 1 ? '' : 's'} to this game?`,
          body: `${holder.away} @ ${holder.home} currently has ${next}. `
              + (others > 1
                  ? `It and ${others - 1} other game${others - 1 === 1 ? '' : 's'} will shift by one to make room.`
                  : `It will shift by one to make room.`),
          confirmText: 'Move it',
          cancelText: 'Leave it',
        });
        if(!ok){ revert(); return; }
      }

      const before = new Map(week.games.map(g => [g.id, g.confidence]));
      const result = assignConfidence(week.games, game, next, canMove);
      if(!result.ok){ revert(); return; }
      // Flag everything that shifted, so the moved rows are visible.
      ui.shiftedGameIds = week.games
        .filter(g => g.id !== game.id && before.get(g.id) !== g.confidence)
        .map(g => g.id);
      saveState(); render();
    };
    row.appendChild(sel);

    // Briefly mark rows the reorder moved -- most are off-screen.
    if(ui.shiftedGameIds && ui.shiftedGameIds.includes(game.id)){
      row.classList.add('just-shifted');
      setTimeout(() => row.classList.remove('just-shifted'), 1600);
    }

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
  const fmtLock = (d) => formatInZone(d, { weekday:'short', month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit' }) + ' ' + zoneLabel();
  if(notOpenYet){
    const unlockAt = weekUnlockTime(store.currentWeek);
    const banner = document.createElement('div');
    banner.className = 'lock-banner opens-soon';
    banner.innerHTML = `🕐 <b>Week ${store.currentWeek} hasn’t opened yet</b> — picks unlock ${formatInZone(unlockAt, { weekday:'long', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' }) + ' ' + zoneLabel()}.`;
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
    warnBox.innerHTML = `⚠️ <b>Your Week ${store.currentWeek} lineup isn’t complete</b> — you’re still missing ${missing.join(', ')}. Finish those before submitting.`;
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
    mvpEl.innerHTML = `<span class="mvp-star">🌟</span> <span><b>MVP Pick:</b> ${escapeHtml(team)} nailed you <b>+${mvp.confidence}</b> points this week.</span>`;
  } else {
    mvpEl.style.display = 'none';
    mvpEl.innerHTML = '';
  }

  // Perfect Week celebration (fires confetti once per week)
  const perfectEl = document.getElementById('perfectWeekBanner');
  if(isPerfectWeek(week)){
    perfectEl.style.display = 'block';
    perfectEl.innerHTML = `🏆 <b>PERFECT WEEK!</b> Every single pick hit in Week ${store.currentWeek}.`;
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
    streakEl.textContent = `🔥 ${streak}-week streak`;
  } else {
    streakEl.style.display = 'none';
  }
}
