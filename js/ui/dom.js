// Small presentation helpers shared across the UI modules: escaping, date/number
// formatting, and the confetti burst.

export function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


export function ordinal(n){
  const rem100 = n % 100;
  if(rem100 >= 11 && rem100 <= 13) return n + 'th';
  switch(n % 10){
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

export function timeAgo(iso){
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

export function isoToLocalInput(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function localInputToIso(val){
  if(!val) return null;
  const d = new Date(val);
  if(isNaN(d.getTime())) return null;
  return d.toISOString();
}


export function rankBadge(i){
  if(i === 0) return '\ud83e\udd47';
  if(i === 1) return '\ud83e\udd48';
  if(i === 2) return '\ud83e\udd49';
  return '#' + (i + 1);
}

/**
 * The label under a name in the standings.
 *
 * Last and second-to-last come in as flags rather than being derived from the
 * rank: once tied scores share a place, `rank === total` stops meaning "bottom
 * of the table" -- in a field of four ranked 1, 1, 3, 3 nobody holds rank 4.
 */
export function placeNickname(rank, total, isLast = false, isSecondLast = false){
  if(rank === 1) return 'Top Dog';
  if(total > 1 && isLast) return 'Average Browns Season';
  if(rank === 2) return 'Runner-Up Royalty';
  if(rank === 3) return 'Bronze Baller';
  if(total > 3 && isSecondLast) return 'On the Clock';
  if(rank <= Math.ceil(total / 2)) return 'Playoff Hopeful';
  return 'Rebuilding Year';
}

// Computes season-long achievement badges for every team in the league,

export function burstConfetti(count){
  count = count || 60;
  const colors = ['var(--amber)', 'var(--correct)', 'var(--incorrect)', 'var(--chalk)'];
  for(let i=0;i<count;i++){
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    el.style.animationDelay = (Math.random() * 0.35) + 's';
    el.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
}



/**
 * Replaces a "Loading…" placeholder when a fetch fails or stalls.
 *
 * The important part is the retry button: a page that hangs used to stay on
 * "Loading…" even after the connection came back, so the only way out was to
 * switch tab and return. This gives it a way out in place.
 */
export function renderLoadFailure(container, { message, onRetry }){
  container.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'load-failure';

  const text = document.createElement('div');
  text.className = 'load-failure-text';
  text.textContent = navigator.onLine === false
    ? 'You’re offline — this needs a connection.'
    : (message || 'Couldn’t load that just now.');
  box.appendChild(text);

  const btn = document.createElement('button');
  btn.className = 'load-failure-retry';
  btn.type = 'button';
  btn.textContent = 'Try again';
  btn.onclick = () => {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    onRetry();
  };
  box.appendChild(btn);

  container.appendChild(box);
}
