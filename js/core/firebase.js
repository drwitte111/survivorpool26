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

export async function saveUserState(uid, stateObj){
  try{
    await db.collection('users').doc(uid).set(stateObj);
    return true;
  }catch(e){ console.error('saveUserState failed', e); return false; }
}
