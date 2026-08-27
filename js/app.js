// Entry point. Loads /data, boots Firebase, wires up the DOM, then hands off to
// the auth listener. Everything below is event wiring -- the actual work lives
// in the core/ and ui/ modules.
import { loadAppData } from './core/data.js';
import { initFirebase, auth } from './core/firebase.js';
import { store, ui, peekWeek } from './core/state.js';
import { applyTeamTheme } from './core/theme.js';
import { saveState } from './core/persist.js';
import { createLeague, joinLeague, ensureSpreadsLoaded } from './core/league.js';
import { loadState, enterApp } from './core/session.js';
import {
  render, showPage, showWeekPage, showAccountPage,
  showStandingsPage, showTrashTalkPage, showRulesPage, showAdminPage,
} from './ui/router.js';
import { renderAccount } from './ui/account.js';
import { postTrashTalk, renderTrashTalkFeed } from './ui/trashtalk.js';
import { updateSeasonRank } from './ui/standings.js';

const $ = (id) => document.getElementById(id);

const RANK_REFRESH_MS = 60000;
const RESULTS_POLL_MS = 30000;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

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
  go('navTrashTalkBtn', showTrashTalkPage);
  go('navRulesBtn', showRulesPage);
  go('navAdminBtn', showAdminPage);

  $('backFromTrashTalkBtn').onclick = () => showWeekPage();
  $('backFromRulesBtn').onclick = () => showWeekPage();
  $('backFromAdminBtn').onclick = () => showWeekPage();
  $('backFromStandingsBtn').onclick = () => showWeekPage();
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

  $('avatarInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > MAX_AVATAR_BYTES){
      alert('Please choose an image smaller than 3MB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      store.state.account.profilePic = reader.result;
      saveState(); renderAccount();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

  $('removeAvatarBtn').onclick = () => {
    store.state.account.profilePic = null;
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
      isLeagueAdmin: false, leagueAdminSecret: null, leagueJoinedAt: null,
    });
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

// ---------- Login / sign up ----------
function friendlyAuthError(e){
  const code = e && e.code;
  if(code === 'auth/email-already-in-use') return 'An account with that email already exists — try logging in instead.';
  if(code === 'auth/invalid-email') return 'That doesn’t look like a valid email address.';
  if(code === 'auth/weak-password') return 'Password should be at least 6 characters.';
  if(code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-credential') return 'Incorrect email or password.';
  return (e && e.message) ? e.message : 'Something went wrong — try again.';
}

function wireAuth(){
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isSignup = e.submitter && e.submitter.id === 'signupBtn';
    const email = $('loginEmailInput').value.trim();
    const password = $('loginPasswordInput').value;
    const errorEl = $('loginError');
    const btn = isSignup ? $('signupBtn') : $('loginBtn');
    errorEl.textContent = '';
    if(!email || !password){
      errorEl.textContent = isSignup
        ? 'Enter an email and password to create an account.'
        : 'Enter your email and password.';
      return;
    }
    btn.disabled = true;
    try{
      if(isSignup) await auth.createUserWithEmailAndPassword(email, password);
      else await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged picks up from here. A real <form> submit (rather than
      // a plain button click) is what lets the browser reliably offer to save
      // these credentials and autofill them next visit.
    }catch(err){
      errorEl.textContent = friendlyAuthError(err);
    }
    btn.disabled = false;
  });

  $('logoutBtn').onclick = () => auth.signOut();

  auth.onAuthStateChanged(async (user) => {
    if(user){
      store.currentUser = user;
      $('loginGate').style.display = 'none';
      await loadState();
    } else {
      store.currentUser = null;
      $('loginGate').style.display = 'flex';
      $('leagueGate').style.display = 'none';
      showPage(null); // hide all app pages behind the login gate
    }
  });
}

// ---------- Background refresh ----------
function startPolling(){
  setInterval(() => { updateSeasonRank().catch(() => {}); }, RANK_REFRESH_MS);

  // Quietly re-check the current week's spreads/results, so a result the admin
  // publishes shows up for everyone else without needing to reload or switch
  // weeks and back.
  setInterval(async () => {
    if(!store.currentUser || !store.state.account.leagueSlug) return;
    const week = peekWeek(store.currentWeek);
    if(!week.games.length) return;
    const before = JSON.stringify(week.games.map(g => g.actualWinner));
    await ensureSpreadsLoaded(store.currentWeek);
    const after = JSON.stringify(week.games.map(g => g.actualWinner));
    if(before !== after){
      saveState();
      render();
    }
  }, RESULTS_POLL_MS);
}

// ---------- Boot ----------
await loadAppData();
initFirebase();

const { closeAccount } = wireDropdowns();
wireNav(closeAccount);
wireTrashTalk();
wireProfile();
wireLeagueControls();
wireLeagueGate();
wireAuth();
startPolling();
