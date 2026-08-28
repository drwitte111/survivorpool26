// The "finish your profile" gate.
//
// syncToLeague() skips anyone without a team name, so a user who joins a league
// and never fills in their profile is invisible on the leaderboard. This blocks
// the board with a forced modal until team name, display name and favourite team
// are set -- then it points them at the Account page and the rules.
//
// It shows whenever the profile is incomplete, not just once: clearing a field
// later (or an older account that predates this) gets prompted again.
import { store } from '../core/state.js';
import { TEAM_LIST } from '../core/data.js';
import { applyTeamTheme } from '../core/theme.js';
import { saveState } from '../core/persist.js';
import { showAccountPage, showRulesPage, showWeekPage } from './router.js';
import { escapeHtml } from './dom.js';

function profileComplete(){
  const a = store.state.account;
  return !!(a.leagueSlug
    && a.teamName && a.teamName.trim()
    && a.yourName && a.yourName.trim()
    && a.favTeam);
}

export function maybeShowProfileGate(){
  const gate = document.getElementById('profileGate');
  if(!gate) return;
  if(profileComplete() || !store.state.account.leagueSlug){
    gate.style.display = 'none';
    return;
  }
  renderForm(gate);
  gate.style.display = 'flex';
}

export function hideProfileGate(){
  const gate = document.getElementById('profileGate');
  if(gate) gate.style.display = 'none';
}

function renderForm(gate){
  const a = store.state.account;
  gate.innerHTML = `
    <div class="league-gate-stack">
      <div class="league-gate-eyebrow">🏈 Hungry Dawgs Run Faster</div>
      <div class="league-gate-card">
        <h1 class="league-gate-title">Finish Your Profile</h1>
        <p class="league-gate-sub">Set these three so you show up on the
          <b>${escapeHtml(a.leagueName || 'league')}</b> leaderboard. You can change
          them any time on the Account page.</p>
        <div class="field">
          <label>Team Name</label>
          <input type="text" id="onbTeamName" placeholder="e.g. The Basement Boys" maxlength="40" autocomplete="off">
        </div>
        <div class="field">
          <label>Your Name</label>
          <input type="text" id="onbYourName" placeholder="e.g. Alex" maxlength="40" autocomplete="off">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Favorite NFL Team</label>
          <select id="onbFavTeam"><option value="">Select a team…</option></select>
        </div>
        <div class="league-gate-error" id="onbError"></div>
        <button class="submit-btn complete league-gate-btn" id="onbSaveBtn" type="button">Save &amp; Continue</button>
      </div>
    </div>`;

  const teamInput = gate.querySelector('#onbTeamName');
  const nameInput = gate.querySelector('#onbYourName');
  const favSelect = gate.querySelector('#onbFavTeam');
  const errorEl = gate.querySelector('#onbError');

  teamInput.value = a.teamName || '';
  nameInput.value = a.yourName || '';
  TEAM_LIST.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    if(name === a.favTeam) opt.selected = true;
    favSelect.appendChild(opt);
  });
  favSelect.onchange = () => { if(favSelect.value) applyTeamTheme(favSelect.value); };

  gate.querySelector('#onbSaveBtn').onclick = () => {
    const team = teamInput.value.trim();
    const you = nameInput.value.trim();
    const fav = favSelect.value;
    if(!team || !you || !fav){
      errorEl.textContent = 'Fill in all three so everyone can find you on the board.';
      return;
    }
    a.teamName = team;
    a.yourName = you;
    a.favTeam = fav;
    applyTeamTheme(fav);
    saveState(); // pushes users/{uid} and syncs the league roster
    renderNudge(gate);
  };
}

function renderNudge(gate){
  gate.innerHTML = `
    <div class="league-gate-stack">
      <div class="league-gate-eyebrow">🏈 Hungry Dawgs Run Faster</div>
      <div class="league-gate-card">
        <h1 class="league-gate-title">You're on the board 🎉</h1>
        <p class="league-gate-sub">Two things worth a look before you dive in:</p>
        <ul class="onboard-nudge-list">
          <li><b>Account</b> — add a profile picture, make your Super Bowl pick, join another league.</li>
          <li><b>Rules</b> — how confidence points, the survivor lock and the Monday-night tiebreaker work.</li>
        </ul>
        <button class="submit-btn complete league-gate-btn" id="onbToAccount" type="button">Open Account Settings</button>
        <button class="league-gate-btn secondary" id="onbToRules" type="button">Read the Rules</button>
        <button class="league-gate-btn secondary" id="onbStart" type="button">Start Picking</button>
      </div>
    </div>`;
  const close = () => { gate.style.display = 'none'; };
  gate.querySelector('#onbToAccount').onclick = () => { close(); showAccountPage(); };
  gate.querySelector('#onbToRules').onclick = () => { close(); showRulesPage(); };
  gate.querySelector('#onbStart').onclick = () => { close(); showWeekPage(); };
}
