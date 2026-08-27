// The League Admin page: roster management and admin-only controls.
import { store } from '../core/state.js';
import { db, saveUserState } from '../core/firebase.js';
import { fetchLeagueTeams, getLeagueMeta } from '../core/league.js';
import { saveState } from '../core/persist.js';
import { escapeHtml } from './dom.js';

export async function renderAdminPage(){
  const el = document.getElementById('adminContent');
  if(!store.state.account.isLeagueAdmin){
    el.innerHTML = `
      <div class="panel">
        <div class="admin-locked-msg">\ud83d\udd12 Only the league's admin can view this page.<br>You joined ${escapeHtml(store.state.account.leagueName || 'this league')} as a member, not the admin.</div>
        <div class="add-league-block">
          <div class="add-league-title">Claim Admin</div>
          <p class="tt-post-msg" style="margin-bottom:10px;">If you're supposed to be the admin (e.g. you created this league under a different login), enter the league password again to claim admin on this account.</p>
          <div class="field" style="margin-bottom:8px;">
            <input type="password" id="claimAdminPassword" placeholder="League password">
          </div>
          <div class="league-gate-error" id="claimAdminError"></div>
          <button class="submit-btn complete" id="claimAdminBtn" style="width:100%;">Claim Admin</button>
        </div>
      </div>`;
    document.getElementById('claimAdminBtn').onclick = async () => {
      const pwInput = document.getElementById('claimAdminPassword');
      const errorEl = document.getElementById('claimAdminError');
      const btn = document.getElementById('claimAdminBtn');
      btn.disabled = true;
      errorEl.textContent = '';
      try{
        const meta = await getLeagueMeta(store.state.account.leagueSlug);
        if(!meta){ errorEl.textContent = 'Couldn\u2019t find this league.'; btn.disabled = false; return; }
        if(meta.password !== pwInput.value){ errorEl.textContent = 'Incorrect password.'; btn.disabled = false; return; }
        await db.collection('leagues').doc(store.state.account.leagueSlug).update({ creatorUid: store.currentUser.uid });
        store.state.account.isLeagueAdmin = true;
        const idx = (store.state.leagues || []).findIndex(l => l.slug === store.state.account.leagueSlug);
        if(idx >= 0) store.state.leagues[idx].isAdmin = true;
        await saveUserState(store.currentUser.uid, store.state);
        renderAdminPage();
      }catch(e){
        console.error('claim admin failed', e);
        errorEl.textContent = 'Something went wrong \u2014 try again.';
      }
      btn.disabled = false;
    };
    return;
  }
  el.innerHTML = '<div class="panel"><div class="empty">Loading league roster…</div></div>';
  const teams = await fetchLeagueTeams();
  const aliveCount = teams.filter(t => t.survivorAlive).length;

  let leaguePassword = '\u2022\u2022\u2022\u2022\u2022\u2022';
  try{
    const meta = await getLeagueMeta(store.state.account.leagueSlug);
    if(meta && meta.password) leaguePassword = meta.password;
  }catch(e){ /* leave placeholder */ }

  el.innerHTML = `
    <div class="panel">
      <div class="league-info-row">League: <b>${escapeHtml(store.state.account.leagueName || '')}</b> &nbsp;\u00b7&nbsp; Password: <b>${escapeHtml(leaguePassword)}</b></div>
      <div class="admin-summary-row">
        <div class="admin-stat-card"><div class="admin-stat-num">${teams.length}</div><div class="admin-stat-label">Members</div></div>
        <div class="admin-stat-card"><div class="admin-stat-num">${aliveCount}</div><div class="admin-stat-label">Alive in Survivor</div></div>
        <div class="admin-stat-card"><div class="admin-stat-num">${teams.length - aliveCount}</div><div class="admin-stat-label">Eliminated</div></div>
      </div>
      <div id="adminMemberList"></div>
    </div>`;

  const listEl = document.getElementById('adminMemberList');
  if(!teams.length){
    listEl.innerHTML = '<div class="empty">No one has joined yet \u2014 share the league name and password to get your friends in.</div>';
    return;
  }
  teams.sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0));
  teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'admin-member-row';
    const joined = t.joinedAt ? new Date(t.joinedAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : 'unknown';
    row.innerHTML = `
      <div>
        <div class="admin-member-name">${escapeHtml(t.teamName)}${t.yourName ? ' \u2014 ' + escapeHtml(t.yourName) : ''}</div>
        <div class="admin-member-sub">${t.total || 0} pts \u00b7 ${t.survivorAlive ? 'Alive' : 'Eliminated Wk ' + (t.survivorEliminatedWeek || '?')} \u00b7 joined ${joined}</div>
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
}

