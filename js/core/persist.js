// Saving personal state.
//
// Every UI action calls saveState(), and the state document is large -- all 18
// weeks of games with every field, around 80 KB once a season is filled in.
// Writing that on each click meant a phone re-uploading 80 KB every time someone
// tapped a team, which is what made the app feel like it was struggling.
//
// So saves are coalesced: a burst of changes produces one write shortly after
// the burst stops, and anything still pending is flushed if the page is about to
// go away. Nothing calling saveState() had to change.
import { store } from './state.js';
import { saveUserState } from './firebase.js';
import { syncToLeague } from './league.js';

const SAVE_DEBOUNCE_MS = 1200;

let timer = null;
let pending = false;
let inFlight = null;

async function flush(){
  if(!pending) return;
  pending = false;
  if(timer){ clearTimeout(timer); timer = null; }
  if(!store.currentUser) return;

  // Serialise: a save already running finishes before the next one starts, so a
  // slow connection can't stack up overlapping writes of the same document.
  const run = async () => {
    try{
      await saveUserState(store.currentUser.uid, store.state);
      await syncToLeague();
    }catch(e){ console.error('save failed', e); }
  };
  inFlight = inFlight ? inFlight.then(run, run) : run();
  return inFlight;
}

/**
 * Queues a save. Returns immediately -- the write happens once the changes stop.
 */
export function saveState(){
  pending = true;
  if(timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; flush(); }, SAVE_DEBOUNCE_MS);
}

/** Writes anything queued right now. */
export function saveStateNow(){
  return flush();
}

// A queued save must not be lost to a closed tab, a backgrounded app, or a
// phone locking. visibilitychange is the reliable one on mobile; pagehide
// covers the desktop close.
if(typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', () => { flush(); });
}
