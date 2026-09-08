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

// ---------- Signing in with nothing but an email ----------
//
// There is no password on this pool. You type your email and you're in.
//
// Firebase Auth always needs a credential, so every account carries the same
// one and the app supplies it -- nobody types it, nobody remembers it, nobody
// can forget it. It sits here in the open on purpose: publishing it changes
// nothing, because the app would hand it over to anyone who asked anyway.
//
// This is not security and is not meant to be. Anyone who knows a member's
// email address can sign in as them. That is the deal for a pool that holds
// nothing but football picks, and it is why the league password (a separate
// thing, in Firestore) is still what keeps a group's board tidy.
const SHARED_PASSWORD = 'NFL2026';

// Sign-in failures that all mean "that email + our shared password didn't
// work". Which one comes back depends on whether the project has email
// enumeration protection switched on, so don't rely on telling them apart --
// createUserWithEmailAndPassword below settles whether the account exists.
const SIGN_IN_MISSES = [
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
  'auth/wrong-password',
  'auth/user-not-found',
];

/**
 * Gets someone in from an email alone, creating the account if it's their
 * first time.
 *
 * Returns { needsOldPassword: true } for an account left over from when this
 * app had real passwords -- the shared credential won't open it until it has
 * been retired by retireOldPassword below. Anything genuinely wrong (a bad
 * address, no connection) throws, so the gate can report it.
 */
export async function enterWithEmail(email){
  try{
    await auth.signInWithEmailAndPassword(email, SHARED_PASSWORD);
    return { needsOldPassword: false };
  }catch(e){
    if(!SIGN_IN_MISSES.includes(e.code)) throw e;
  }
  try{
    await auth.createUserWithEmailAndPassword(email, SHARED_PASSWORD);
    return { needsOldPassword: false };
  }catch(e){
    // The account is real, it just still has its own password.
    if(e.code === 'auth/email-already-in-use') return { needsOldPassword: true };
    throw e;
  }
}

/**
 * One-time migration for an account created under the old email + password
 * login: sign in with the password they still remember, then swap it for the
 * shared one so they never see this again.
 *
 * Someone who has genuinely forgotten it isn't stuck -- an admin sets theirs to
 * anything from the Firebase console (Authentication -> Users), they type that
 * once, and it's retired the same way.
 */
export async function retireOldPassword(email, oldPassword){
  const credential = await auth.signInWithEmailAndPassword(email, oldPassword);
  await credential.user.updatePassword(SHARED_PASSWORD);
}
