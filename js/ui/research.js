// The Research tab: NFL team standings and against-the-spread records for the
// season, with a toggle between this year and last. Purely a reference view --
// nothing here feeds the pool. Data comes from core/nflstats.js (ESPN).
import { ui } from '../core/state.js';
import { CONFIG } from '../core/data.js';
import { getSeasonRecords } from '../core/nflstats.js';
import { getTeamAbbr, teamLogoUrl } from '../core/teams.js';
import { escapeHtml } from './dom.js';

function atsPct(r){
  const decided = r.atsW + r.atsL;
  return decided ? Math.round((r.atsW / decided) * 100) : null;
}

export async function renderResearchPage(){
  const el = document.getElementById('researchContent');
  if(!el) return;

  const current = CONFIG.seasonYear;
  const season = ui.researchSeason || current;
  const isCurrent = season === current;
  const years = [current, current - 1];

  el.innerHTML = `
    <div class="panel">
      <div class="research-toggle">
        ${years.map(y => `<button class="research-season-btn${y === season ? ' active' : ''}" data-year="${y}" type="button">${y}</button>`).join('')}
      </div>
      <p class="research-note">Straight-up standings and against-the-spread records, from ESPN's
        closing lines and final scores. ${isCurrent ? 'Fills in as the season goes on.' : `Final ${season} regular season.`}</p>
      <div id="researchTable"><div class="empty">Loading ${season} results…</div></div>
    </div>`;

  el.querySelectorAll('.research-season-btn').forEach(btn => {
    btn.onclick = () => {
      const y = parseInt(btn.dataset.year, 10);
      if(y === (ui.researchSeason || current)) return;
      ui.researchSeason = y;
      renderResearchPage();
    };
  });

  const tableEl = document.getElementById('researchTable');
  let records;
  try{
    records = await getSeasonRecords(season, isCurrent);
  }catch(e){
    tableEl.innerHTML = `<div class="empty">Couldn't reach ESPN for ${season} — try again in a bit.</div>`;
    return;
  }
  // A slow response for a season the user has since toggled away from: drop it.
  if((ui.researchSeason || current) !== season) return;

  const played = records.filter(r => r.games > 0);
  if(!played.length){
    tableEl.innerHTML = `<div class="empty">${isCurrent
      ? `The ${season} season hasn't kicked off yet — check back after Week 1.`
      : `No ${season} results found.`}</div>`;
    return;
  }

  const rows = played.map((r, i) => {
    const abbr = (getTeamAbbr(r.name) || '').toUpperCase();
    const logo = teamLogoUrl(r.name);
    const diff = r.pf - r.pa;
    const pct = atsPct(r);
    return `
      <tr>
        <td class="research-rank">${i + 1}</td>
        <td class="research-team">
          ${logo ? `<img class="research-logo" src="${logo}" alt="" loading="lazy">` : ''}
          <span class="research-team-full">${escapeHtml(r.name)}</span>
          <span class="research-team-abbr">${escapeHtml(abbr)}</span>
        </td>
        <td class="research-num">${r.w}-${r.l}${r.t ? '-' + r.t : ''}</td>
        <td class="research-num">${r.atsW}-${r.atsL}${r.atsP ? '-' + r.atsP : ''}</td>
        <td class="research-num">${pct != null ? pct + '%' : '—'}</td>
        <td class="research-num ${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</td>
      </tr>`;
  }).join('');

  tableEl.innerHTML = `
    <div class="research-table-scroll">
      <table class="research-table">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>Record</th>
            <th>ATS</th><th>ATS%</th><th>Pt Diff</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="research-foot">ATS records skip any game ESPN never published a line for, so the
      three numbers won't always add up to games played.</p>`;
}
