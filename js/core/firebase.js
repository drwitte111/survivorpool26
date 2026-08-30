// Firebase wiring. Personal data (your picks, points, profile) lives under
// users/{uid} so it follows you to any device once you're logged in. Shared
// league data (roster, trash talk, spreads, results) lives under leagues/{slug}.
import { CONFIG } from './data.js';

export let db = null;
export let auth = null;

export function initFirebase(){
  firebase.initializeApp(CONFIG.firebase);
  db = firebase.firestore();
  auth = firebase.auth();

  // Offline durability, and it has to be switched on before any other Firestore
  // call. With this, a pick made on a bad connection is written to IndexedDB
  // immediately and replayed when the signal comes back -- including across a
  // reload or a phone locking. Without it, a failed write was simply lost.
  //
  // Neither failure mode is fatal: the app just behaves as it did before.
  //   failed-precondition -- another tab already holds persistence
  //   unimplemented       -- browser has no IndexedDB (private mode, old iOS)
  db.enablePersistence({ synchronizeTabs: true }).catch(e => {
    if(e.code !== 'failed-precondition' && e.code !== 'unimplemented'){
      console.error('offline persistence failed', e);
    }
  });
  // Stay signed in on this device until the person explicitly logs out. The app
  // is meant to live on a phone home screen, where SESSION persistence meant
  // retyping a password every single launch. "Log Out" on the Account page is
  // the way back out.
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .catch(e => console.error('setPersistence failed', e));
}

export async function loadUserState(uid){
  try{
    const docSnap = await db.collection('users').doc(uid).get();
    if(docSnap.exists) return docSnap.data();
  }catch(e){ console.error('loadUserState failed', e); }
  return null;
}

/**
 * Writes personal state.
 *
 * The returned promise settles when the SERVER has the write, which offline
 * means not for a long time. The write itself is already durable well before
 * then -- persistence above puts it in IndexedDB synchronously -- so a caller
 * that only cares whether the pick is safe does not need to wait on this. What
 * it's good for is telling someone whether they're caught up.
 */
export function saveUserState(uid, stateObj){
  return db.collection('users').doc(uid).set(stateObj);
}
