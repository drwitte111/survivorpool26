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
//
// Offline, the write is durable long before the server sees it -- Firestore's
// IndexedDB persistence (switched on in firebase.js) records it locally and
// replays it on reconnect, across a reload if need be. So nothing here waits on
// the server acknowledgement. It used to, and one write made on a bad connection
// would never settle, which stalled every save queued behind it for the rest of
// the session.
import { store } from './state.js';
import { saveUserState } from './firebase.js';
import { syncToLeague } from './league.js';

const SAVE_DEBOUNCE_MS = 1200;

let timer = null;
let pending = false;
let unacked = 0;              // writes handed to Firestore, not yet on the server
let lastError = null;
const listeners = new Set();

/**
 * 'saved'   -- the server has everything
 * 'saving'  -- a write is in flight
 * 'offline' -- writes are queued locally and will go up on reconnect
 */
export function saveStatus(){
  if(unacked > 0) return navigator.onLine === false ? 'offline' : 'saving';
  if(navigator.onLine === false) return 'offline';
  return lastError ? 'error' : 'saved';
}

/** Subscribe to save status. Fires immediately with the current value. */
export function onSaveStatus(fn){
  listeners.add(fn);
  fn(saveStatus());
  return () => listeners.delete(fn);
}

function announce(){
  const s = saveStatus();
  listeners.forEach(fn => { try{ fn(s); }catch(e){ /* a listener must not break a save */ } });
}

function flush(){
  if(!pending) return Promise.resolve();
  pending = false;
  if(timer){ clearTimeout(timer); timer = null; }
  if(!store.currentUser) return Promise.resolve();

  unacked++;
  announce();

  const ack = saveUserState(store.currentUser.uid, store.state);
  ack.then(
    () => { lastError = null; },
    (e) => { lastError = e; console.error('save failed', e); }
  ).then(() => { unacked--; announce(); });

  // The league row is derived from the same state; it rides the same queue and
  // is equally safe to leave unwaited.
  syncToLeague().catch(() => {});

  return ack;
}

/**
 * Queues a save. Returns immediately -- the write happens once the changes stop.
 */
export function saveState(){
  pending = true;
  if(timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; flush(); }, SAVE_DEBOUNCE_MS);
}

/** Hands anything queued to Firestore right now. */
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
  // Coming back online doesn't need to trigger anything -- Firestore replays the
  // queue by itself -- but the status pill should stop saying "offline".
  window.addEventListener('online', announce);
  window.addEventListener('offline', announce);
}
