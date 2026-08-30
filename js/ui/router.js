// Page switching, the week picker, and the top-level render pass.
import { store, ui } from '../core/state.js';
import { TOTAL_WEEKS } from '../core/data.js';
import { refreshWeek } from '../core/refresh.js';
import { renderLockPanel, renderGames, renderSummary } from './week.js';
import { renderStandingsPage } from './standings.js';
import { renderAccount } from './account.js';
import { renderTrashTalkFeed } from './trashtalk.js';
import { renderRulesContent } from './rules.js';
import { renderAdminPage } from './admin.js';
import { renderPicksPage } from './picks.js';
import { renderResearchPage } from './research.js';

const ALL_PAGES = ['weekPage', 'standingsPage', 'accountPage', 'trashTalkPage', 'rulesPage', 'adminPage', 'researchPage', 'picksPage'];
export function showPage(id){
  if(id !== 'accountPage') ui.accountFormDirty = false;
  ALL_PAGES.forEach(p => { document.getElementById(p).style.display = (p === id) ? 'block' : 'none'; });
}

export function showWeekPage(){ showPage('weekPage'); }

export function showStandingsPage(){ showPage('standingsPage'); renderStandingsPage(); }

export function showAccountPage(){ showPage('accountPage'); }

export function showTrashTalkPage(){ showPage('trashTalkPage'); renderTrashTalkFeed(); }

export function showRulesPage(){ showPage('rulesPage'); renderRulesContent(); }

export function showPicksPage(){ showPage('picksPage'); renderPicksPage(); }

export function showAdminPage(){ showPage('adminPage'); renderAdminPage(); }

export function showResearchPage(){ showPage('researchPage'); renderResearchPage(); }


export function renderWeekPicker(){
  document.getElementById('weekPickerLabel').textContent = 'Week ' + store.currentWeek;
  const dot = document.getElementById('weekPickerDot');
  const curWeekHasGames = !!(store.state.weeks[store.currentWeek] && store.state.weeks[store.currentWeek].games.length);
  dot.style.display = curWeekHasGames ? 'inline-block' : 'none';

  const list = document.getElementById('weekList');
  list.innerHTML = '';
  for(let i=1;i<=TOTAL_WEEKS;i++){
    const btn = document.createElement('button');
    btn.className = 'week-item' + (i===store.currentWeek ? ' active' : '') + ((store.state.weeks[i] && store.state.weeks[i].games.length) ? ' has-games' : '');
    btn.textContent = i;
    btn.onclick = () => {
      store.currentWeek = i;
      ui.showIncompleteWarning = false;
      document.getElementById('weekPanel').style.display = 'none';
      document.getElementById('weekPickerBtn').classList.remove('open');
      showWeekPage();
      render();
      refreshWeek(i).then(() => render());
    };
    list.appendChild(btn);
  }
}

export function setSyncStatus(msg){
  const el = document.getElementById('syncStatus');
  if(el) el.textContent = msg;
}

export function render(){
  renderWeekPicker();
  renderLockPanel();
  renderGames();
  renderSummary();
  renderAccount();
}



