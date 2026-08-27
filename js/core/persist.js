// Saving personal state. Kept deliberately small and dependency-light because
// almost every UI module calls saveState() after a change.
import { store } from './state.js';
import { saveUserState } from './firebase.js';
import { syncToLeague } from './league.js';

/** Fire-and-forget: pushes personal state to users/{uid} and the league roster. */
export function saveState(){
  if(store.currentUser) saveUserState(store.currentUser.uid, store.state).catch(() => {});
  syncToLeague().catch(() => {});
}
