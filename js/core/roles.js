// Who may edit spreads, publish results, and manage the roster.
//
// A fixed list checked against the signed-in email -- deliberately not something
// anyone can grant themselves from the app. The spread and results editors
// publish to every league at once, so the gate can't live in per-league data,
// and the old "first person to join with the password becomes admin" rule let
// the wrong person end up in charge.
//
// This is the client-side half. The real enforcement is firestore.rules, which
// carries the same two addresses -- keep them in sync.
import { store } from './state.js';

const ADMIN_EMAILS = ['cbower683@gmail.com', 'drwitte111@gmail.com'];

export function isAdmin(){
  const email = store.currentUser && store.currentUser.email;
  return !!email && ADMIN_EMAILS.includes(email.trim().toLowerCase());
}
