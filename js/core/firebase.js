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
  // Only stay logged in for the current browser session -- closing the browser
  // (or the tab, in some browsers) sends you back to the login screen next time,
  // rather than silently staying logged in indefinitely.
  auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
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
