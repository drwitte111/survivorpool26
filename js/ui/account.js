// The Account page: profile, favorite team, Super Bowl pick and league list.
import { store, ui } from '../core/state.js';
import { TEAM_LIST } from '../core/data.js';
import { teamLogoUrl } from '../core/teams.js';
import { applyTeamTheme } from '../core/theme.js';
import { saveUserState } from '../core/firebase.js';
import { isSuperBowlPickLocked, superBowlLockTime } from '../core/locks.js';
import { saveState } from '../core/persist.js';
import { switchActiveLeague, syncToLeague } from '../core/league.js';
import { escapeHtml } from './dom.js';
import { render, showWeekPage } from './router.js';
import { enterApp } from '../core/session.js';

export function renderAccount(){
  const acct = store.state.account;
  applyTeamTheme(acct.favTeam);

  // Super Bowl pick (for fun only, locks with Week 1)
  const sbEl = document.getElementById('sbPickContent');
  if(sbEl){
    if(isSuperBowlPickLocked()){
      sbEl.innerHTML = acct.superBowlPick
        ? `<div class="sb-locked-msg">Your pick is locked in: <b>${escapeHtml(acct.superBowlPick)}</b></div>`
        : `<div class="sb-locked-msg">Locked \u2014 you didn\u2019t make a pick before Week 1 started.</div>`;
    } else {
      const currentVal = acct.superBowlPick || '';
      let options = '<option value="">Select a team...</option>';
      TEAM_LIST.forEach(t => { options += `<option value="${escapeHtml(t)}"${t === currentVal ? ' selected' : ''}>${escapeHtml(t)}</option>`; });
      sbEl.innerHTML = `<select id="sbPickSelect" class="sb-pick-select">${options}</select>`;
      document.getElementById('sbPickSelect').onchange = (e) => {
        store.state.account.superBowlPick = e.target.value || null;
        saveState();
      };
    }
  }

  // League info
  const leagueInfoEl = document.getElementById('accountLeagueInfo');
  if(leagueInfoEl){
    leagueInfoEl.innerHTML = acct.leagueName
      ? `You're in <b>${escapeHtml(acct.leagueName)}</b>${acct.isLeagueAdmin ? ' (you\u2019re the admin)' : ''}`
      : 'Not in a league.';
  }

  // My Leagues list (switcher)
  const myLeaguesEl = document.getElementById('myLeaguesList');
  if(myLeaguesEl){
    const leagues = store.state.leagues || [];
    if(!leagues.length){
      myLeaguesEl.innerHTML = '<div class="empty">No leagues yet.</div>';
    } else {
      myLeaguesEl.innerHTML = '';
      leagues.forEach(l => {
        const isActive = l.slug === acct.leagueSlug;
        const row = document.createElement('div');
        row.className = 'my-league-row' + (isActive ? ' active' : '');
        row.innerHTML = `<div class="my-league-name">${escapeHtml(l.name)}${l.isAdmin ? '<span class="admin-tag">ADMIN</span>' : ''}</div>`;
        if(isActive){
          const tag = document.createElement('span');
          tag.className = 'my-league-active-tag';
          tag.textContent = 'Current';
          row.appendChild(tag);
        } else {
          const btn = document.createElement('button');
          btn.className = 'my-league-switch-btn';
          btn.textContent = 'Switch';
          btn.onclick = async () => {
            btn.disabled = true; btn.textContent = 'Switching…';
            switchActiveLeague(l.slug, l.name, l.isAdmin);
            await saveUserState(store.currentUser.uid, store.state);
            showWeekPage();
            await enterApp();
          };
          row.appendChild(btn);
        }
        myLeaguesEl.appendChild(row);
      });
    }
  }

  // Account email
  const emailInfoEl = document.getElementById('accountEmailInfo');
  if(emailInfoEl && store.currentUser){
    emailInfoEl.innerHTML = `Logged in as <b>${escapeHtml(store.currentUser.email || '')}</b>`;
  }

  // Header identity line
  const idEl = document.getElementById('headerIdentity');
  idEl.innerHTML = acct.teamName ? `Welcome, <b style="color:var(--amber)">${escapeHtml(acct.teamName)}</b>` : '';

  // Menu button avatar
  const menuAvatar = document.getElementById('menuAvatarImg');
  if(acct.profilePic){ menuAvatar.src = acct.profilePic; menuAvatar.classList.add('show'); }
  else { menuAvatar.classList.remove('show'); menuAvatar.src=''; }

  // Dropdown avatar preview
  const preview = document.getElementById('avatarPreview');
  const placeholder = document.getElementById('avatarPlaceholder');
  if(acct.profilePic){
    preview.src = acct.profilePic; preview.style.display = 'block'; placeholder.style.display = 'none';
  } else {
    preview.style.display = 'none'; placeholder.style.display = 'flex';
  }

  // Text field values (only set if not currently focused/dirty, to avoid clobbering unsaved edits)
  const teamNameInput = document.getElementById('teamNameInput');
  const yourNameInput = document.getElementById('yourNameInput');
  const favTeamInput = document.getElementById('favTeamInput');

  if(!favTeamInput.dataset.built){
    TEAM_LIST.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      favTeamInput.appendChild(opt);
    });
    favTeamInput.dataset.built = '1';
  }

  if(document.activeElement !== teamNameInput && !ui.accountFormDirty) teamNameInput.value = acct.teamName || '';
  if(document.activeElement !== yourNameInput && !ui.accountFormDirty) yourNameInput.value = acct.yourName || '';
  if(document.activeElement !== favTeamInput && !ui.accountFormDirty) favTeamInput.value = acct.favTeam || '';
}

