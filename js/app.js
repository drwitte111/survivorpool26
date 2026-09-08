// Entry point. Loads /data, boots Firebase, wires up the DOM, then hands off to
// the auth listener. Everything below is event wiring -- the actual work lives
// in the core/ and ui/ modules.
import { loadAppData } from './core/data.js';
import { initFirebase, auth, enterWithEmail, retireOldPassword } from './core/firebase.js';
import { store, ui, peekWeek } from './core/state.js';
import { applyTeamTheme } from './core/theme.js';
import { saveState, onSaveStatus } from './core/persist.js';
import { createLeague, joinLeague } from './core/league.js';
import { refreshWeek } from './core/refresh.js';
import { onBackOnline } from './core/net.js';
import { loadState, enterApp } from './core/session.js';
import {
  render, showPage, showWeekPage, showAccountPage,
  showStandingsPage, showTrashTalkPage, showRulesPage, showAdminPage, showPicksPage,
  showResearchPage,
} from './ui/router.js';
import { hideProfileGate } from './ui/onboarding.js';
import { renderAccount } from './ui/account.js';
import { postTrashTalk, renderTrashTalkFeed } from './ui/trashtalk.js';
import { updateSeasonRank } from './ui/standings.js';

const $ = (id) => document.getElementById(id);

const RANK_REFRESH_MS = 60000;
const RESULTS_POLL_MS = 30000;
const AUTH_SPLASH_TIMEOUT_MS = 8000;
const MIN_PASSWORD_LENGTH = 6;  // Firebase's own minimum.

// ---------- Dropdown panels (week picker + account menu) ----------
// Both behave the same way: opening one closes the other, an outside click
// closes both, and a click inside a panel doesn't bubble out and close it.
function wireDropdowns(){
  const accountMenuBtn = $('accountMenuBtn'), accountPanel = $('accountPanel');
  const weekPickerBtn = $('weekPickerBtn'), weekPanel = $('weekPanel');

  const closeAccount = () => { accountPanel.style.display = 'none'; accountMenuBtn.classList.remove('open'); };
  const closeWeek = () => { weekPanel.style.display = 'none'; weekPickerBtn.classList.remove('open'); };

  accountMenuBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = accountPanel.style.display !== 'none';
    closeWeek();
    accountPanel.style.display = isOpen ? 'none' : 'block';
    accountMenuBtn.classList.toggle('open', !isOpen);
  };
  weekPickerBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = weekPanel.style.display !== 'none';
    closeAccount();
    weekPanel.style.display = isOpen ? 'none' : 'block';
    weekPickerBtn.classList.toggle('open', !isOpen);
  };

  document.addEventListener('click', (e) => {
    if(!accountPanel.contains(e.target) && e.target !== accountMenuBtn) closeAccount();
    if(!weekPanel.contains(e.target) && e.target !== weekPickerBtn && !weekPickerBtn.contains(e.target)) closeWeek();
  });
  accountPanel.addEventListener('click', e => e.stopPropagation());
  weekPanel.addEventListener('click', e => e.stopPropagation());

  return { closeAccount };
}

// ---------- Menu navigation ----------
function wireNav(closeAccount){
  const go = (id, fn) => { $(id).onclick = () => { closeAccount(); fn(); }; };
  go('navAccountBtn', showAccountPage);
  go('navStandingsBtn', showStandingsPage);
  go('navPicksBtn', showPicksPage);
  go('navTrashTalkBtn', showTrashTalkPage);
  go('navRulesBtn', showRulesPage);
  go('navResearchBtn', showResearchPage);
  go('navAdminBtn', showAdminPage);

  $('backFromTrashTalkBtn').onclick = () => showWeekPage();
  $('backFromRulesBtn').onclick = () => showWeekPage();
  $('backFromResearchBtn').onclick = () => showWeekPage();
  $('backFromAdminBtn').onclick = () => showWeekPage();
  $('backFromStandingsBtn').onclick = () => showWeekPage();
  $('backFromPicksBtn').onclick = () => showWeekPage();
  $('backFromAccountBtn').onclick = () => { ui.accountFormDirty = false; showWeekPage(); };
}

// ---------- Trash talk composer ----------
function wireTrashTalk(){
  $('trashTalkPostBtn').onclick = async () => {
    const input = $('trashTalkInput'), statusEl = $('trashTalkStatus'), btn = $('trashTalkPostBtn');
    btn.disabled = true;
    statusEl.className = 'tt-status';
    statusEl.textContent = 'Posting…';
    const result = await postTrashTalk(input.value);
    btn.disabled = false;
    if(result.ok){
      input.value = '';
      statusEl.className = 'tt-status';
      statusEl.textContent = '';
      renderTrashTalkFeed();
    } else {
      statusEl.className = 'tt-status tt-error';
      statusEl.textContent = '⚠️ ' + result.error;
    }
  };
  $('trashTalkInput').addEventListener('keydown', e => {
    if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('trashTalkPostBtn').click();
  });
}

// ---------- Profile form ----------
function wireProfile(){
  $('teamNameInput').addEventListener('input', () => { ui.accountFormDirty = true; });
  $('yourNameInput').addEventListener('input', () => { ui.accountFormDirty = true; });
  $('favTeamInput').addEventListener('change', (e) => {
    ui.accountFormDirty = true;
    applyTeamTheme(e.target.value);
  });

  $('saveProfileBtn').onclick = () => {
    store.state.account.teamName = $('teamNameInput').value;
    store.state.account.yourName = $('yourNameInput').value;
    store.state.account.favTeam = $('favTeamInput').value;
    applyTeamTheme(store.state.account.favTeam);
    ui.accountFormDirty = false;
    saveState(); render();
    const statusEl = $('profileSaveStatus');
    statusEl.textContent = '✓ Profile saved';
    statusEl.classList.add('show');
    setTimeout(() => statusEl.classList.remove('show'), 2500);
  };

  // Profile picture is a link the person pastes -- a direct URL to the image,
  // typically copied out of Google Photos -- not an uploaded file. The image
  // itself stays on Google's servers; we only store the string.
  const applyAvatarUrl = () => {
    const url = $('avatarUrlInput').value.trim();
    $('avatarStatus').textContent = url ? 'Checking the link…' : '';
    store.state.account.profilePic = url || null;
    saveState(); renderAccount();
  };
  $('setAvatarBtn').onclick = applyAvatarUrl;
  $('avatarUrlInput').addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); applyAvatarUrl(); }
  });

  $('removeAvatarBtn').onclick = () => {
    store.state.account.profilePic = null;
    $('avatarUrlInput').value = '';
    $('avatarStatus').textContent = '';
    saveState(); renderAccount();
  };
}

// ---------- League controls on the Account page ----------
function wireLeagueControls(){
  // Two-step confirm: the first click arms the button for 3 seconds.
  $('leaveLeagueBtn').onclick = () => {
    const btn = $('leaveLeagueBtn');
    if(btn.dataset.armed !== '1'){
      btn.dataset.armed = '1';
      btn.textContent = 'Confirm Leave?';
      setTimeout(() => {
        if(btn.dataset.armed === '1'){ btn.dataset.armed = '0'; btn.textContent = 'Leave Current League'; }
      }, 3000);
      return;
    }
    const s = store.state;
    const leavingSlug = s.account.leagueSlug;
    s.leagues = (s.leagues || []).filter(l => l.slug !== leavingSlug);
    if(!s.leagueData) s.leagueData = {};
    if(!s.leagueProfiles) s.leagueProfiles = {};
    if(leavingSlug){
      // Stash this league's picks so rejoining later restores them.
      s.leagueData[leavingSlug] = s.weeks;
      s.leagueProfiles[leavingSlug] = { teamName: s.account.teamName, yourName: s.account.yourName };
    }
    s.weeks = {};
    Object.assign(s.account, {
      teamName: '', yourName: '', leagueSlug: null, leagueName: '',
      leagueAdminSecret: null, leagueJoinedAt: null,
    });
    // isLeagueAdmin is derived from the signed-in email (core/roles.js), not
    // league membership, so leaving a league doesn't change it.
    saveState();
    $('leagueGate').style.display = 'flex';
    ['createLeagueNameInput', 'createLeaguePasswordInput', 'joinLeagueNameInput', 'joinLeaguePasswordInput']
      .forEach(id => { $(id).value = ''; });
    ['createLeagueError', 'joinLeagueError'].forEach(id => { $(id).textContent = ''; });
    showWeekPage();
  };

  $('toggleAddLeagueBtn').onclick = () => {
    const forms = $('addLeagueForms');
    forms.style.display = (forms.style.display === 'none') ? 'block' : 'none';
  };

  const wireForm = (btnId, nameId, passId, errorId, action) => {
    $(btnId).onclick = async () => {
      const nameInput = $(nameId), passInput = $(passId), errorEl = $(errorId), btn = $(btnId);
      btn.disabled = true;
      errorEl.textContent = '';
      const result = await action(nameInput.value, passInput.value);
      btn.disabled = false;
      if(!result.ok){ errorEl.textContent = result.error; return; }
      nameInput.value = ''; passInput.value = '';
      $('addLeagueForms').style.display = 'none';
      showWeekPage();
      await enterApp();
    };
  };
  wireForm('acctCreateLeagueBtn', 'acctCreateLeagueName', 'acctCreateLeaguePass', 'acctCreateLeagueError', createLeague);
  wireForm('acctJoinLeagueBtn', 'acctJoinLeagueName', 'acctJoinLeaguePass', 'acctJoinLeagueError', joinLeague);
}

// ---------- League gate (shown when you belong to no league yet) ----------
function wireLeagueGate(){
  const wireForm = (btnId, nameId, passId, errorId, action) => {
    $(btnId).onclick = async () => {
      const nameInput = $(nameId), passInput = $(passId), errorEl = $(errorId), btn = $(btnId);
      btn.disabled = true;
      errorEl.textContent = '';
      const result = await action(nameInput.value, passInput.value);
      btn.disabled = false;
      if(!result.ok){ errorEl.textContent = result.error; return; }
      $('leagueGate').style.display = 'none';
      await enterApp();
    };
    $(passId).addEventListener('keydown', e => { if(e.key === 'Enter') $(btnId).click(); });
  };
  wireForm('createLeagueBtn', 'createLeagueNameInput', 'createLeaguePasswordInput', 'createLeagueError', createLeague);
  wireForm('joinLeagueBtn', 'joinLeagueNameInput', 'joinLeaguePasswordInput', 'joinLeagueError', joinLeague);
}

// ---------- Logging in ----------
// There's no password: an email is the whole login (see enterWithEmail). The
// only wrinkle is an account made back when this app had real passwords, which
// asks for that password once so it can retire it.
function friendlyAuthError(e){
  const code = e && e.code;
  if(code === 'auth/invalid-email') return 'That doesn\u2019t look like a valid email address.';
  if(code === 'auth/wrong-password' || code === 'auth/invalid-credential'
     || code === 'auth/invalid-login-credentials') return 'That password doesn\u2019t match \u2014 ask an admin to reset it for you.';
  if(code === 'auth/too-many-requests') return 'Too many tries. Wait a minute and go again.';
  if(code === 'auth/network-request-failed') return 'Couldn\u2019t reach the server \u2014 check your connection.';
  return (e && e.message) ? e.message : 'Something went wrong \u2014 try again.';
}

function showMigrateStep(on){
  $('migrateBlock').style.display = on ? '' : 'none';
  if(!on) $('migratePasswordInput').value = '';
}

function wireAuth(){
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmailInput').value.trim();
    const errorEl = $('loginError');
    const btn = $('loginBtn');
    const migrating = $('migrateBlock').style.display !== 'none';
    errorEl.textContent = '';
    if(!email){ errorEl.textContent = 'Enter your email.'; return; }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Hold on\u2026';
    try{
      if(migrating){
        const oldPassword = $('migratePasswordInput').value;
        if(!oldPassword){ errorEl.textContent = 'Enter the password you used to use.'; return; }
        await retireOldPassword(email, oldPassword);
      }else{
        const { needsOldPassword } = await enterWithEmail(email);
        if(needsOldPassword){
          showMigrateStep(true);
          $('migratePasswordInput').focus();
          return;
        }
      }
      // onAuthStateChanged picks up from here. A real <form> submit (rather than
      // a plain button click) is what lets the browser reliably offer to save
      // and autofill the address next visit.
      showMigrateStep(false);
    }catch(err){
      errorEl.textContent = friendlyAuthError(err);
    }finally{
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  $('logoutBtn').onclick = () => auth.signOut();

  // Drop the splash once we know whether there's a saved session. Belt-and-braces
  // timeout so a wedged auth call can never leave someone stuck on it.
  const clearAuthPending = () => document.documentElement.classList.remove('auth-pending');
  setTimeout(clearAuthPending, AUTH_SPLASH_TIMEOUT_MS);

  auth.onAuthStateChanged(async (user) => {
    if(user){
      store.currentUser = user;
      $('loginGate').style.display = 'none';
      // Render the board before revealing it, so the splash gives way to the
      // week page rather than to an empty shell.
      await loadState();
      clearAuthPending();
    } else {
      store.currentUser = null;
      showMigrateStep(false);
      $('loginGate').style.display = 'flex';
      $('leagueGate').style.display = 'none';
      hideProfileGate();
      showPage(null); // hide all app pages behind the login gate
      clearAuthPending();
    }
  });
}

// ---------- Recover a stalled page ----------
// A read that stalls leaves a page on its loading state. Each page offers a
// retry button, but coming back online should fix it without being asked.
function wireStallRecovery(){
  onBackOnline(() => {
    if(!store.currentUser || !store.state.account.leagueSlug) return;
    const visible = ['standingsPage', 'picksPage', 'trashTalkPage', 'adminPage']
      .find(id => { const el = $(id); return el && el.style.display !== 'none'; });
    if(!visible) return;
    // Only re-run for a page still showing a loading or failure state; a page
    // that loaded fine shouldn't flicker every time the app is foregrounded.
    const el = $(visible);
    if(!/Loading|Couldn’t load|You’re offline/.test(el.textContent)) return;
    if(visible === 'standingsPage') showStandingsPage();
    else if(visible === 'picksPage') showPicksPage();
    else if(visible === 'trashTalkPage') showTrashTalkPage();
    else if(visible === 'adminPage') showAdminPage();
  });
}

// ---------- Background refresh ----------
function startPolling(){
  setInterval(() => { updateSeasonRank().catch(() => {}); }, RANK_REFRESH_MS);

  // Quietly re-pull the current week: live scores and final results from ESPN,
  // then anything the admin corrected by hand. Scores tick over on their own
  // during games without anyone reloading or switching weeks and back.
  setInterval(async () => {
    if(!store.currentUser || !store.state.account.leagueSlug) return;
    if(document.hidden) return; // don't poll a backgrounded tab
    const week = peekWeek(store.currentWeek);
    if(!week.games.length) return;
    const snapshot = () => JSON.stringify(
      week.games.map(g => [g.actualWinner, g.liveAway, g.liveHome, g.gameState,
                           g.pick, g.confidence]));
    const before = snapshot();
    await refreshWeek(store.currentWeek);
    if(snapshot() !== before){
      saveState();
      render();
    }
  }, RESULTS_POLL_MS);
}

// ---------- Save status ----------
// Silent while everything is up to date. It exists for the case where a pick was
// made on a bad connection: the pick is safe -- Firestore has it on disk and
// replays it -- but people reasonably want to be told that, not left guessing.
function wireSaveStatus(){
  const el = $('saveStatus');
  if(!el) return;
  const text = {
    saving:  'Saving…',
    offline: 'Offline — your picks are saved on this device and will sync when you’re back.',
    error:   'Couldn’t reach the server — your picks are saved here and will retry.',
  };
  onSaveStatus(status => {
    el.className = 'save-status' + (status === 'saved' ? '' : ' ' + status);
    el.textContent = text[status] || '';
  });
}

// ---------- Boot ----------
await loadAppData();
initFirebase();
wireSaveStatus();

const { closeAccount } = wireDropdowns();
wireNav(closeAccount);
wireTrashTalk();
wireProfile();
wireLeagueControls();
wireLeagueGate();
wireAuth();
wireStallRecovery();
startPolling();
