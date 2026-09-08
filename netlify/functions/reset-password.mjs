// Password reset with no email round-trip.
//
// Firebase's client SDK cannot change a password you can't already sign in
// with -- the only client-side route is sendPasswordResetEmail, which means
// waiting on an email and clicking a link. This pool is a friend group, so the
// rule here is simpler: give the email, give the new password, done.
//
// That needs privileged credentials, which cannot ship in the page, so it runs
// server-side as a Netlify Function. It talks to Google's Identity Toolkit
// admin REST API directly -- signing its own service-account JWT with node's
// built-in crypto -- so the repo stays dependency-free with nothing to install.
//
// Setup (once, in Netlify -> Site settings -> Environment variables):
//   FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON, pasted as one
//   value. Firebase console -> Project settings -> Service accounts ->
//   "Generate new private key".
//
// Note this endpoint deliberately has no verification: anyone who knows a
// league member's email address can set that account's password. That is the
// trade that was asked for, and it is why nothing sensitive lives in the pool.
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IDENTITY_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';
const MIN_PASSWORD_LENGTH = 6;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

const b64url = (input) => Buffer.from(input).toString('base64url');

function serviceAccount(){
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set on this site.');
  const sa = JSON.parse(raw);
  if(!sa.client_email || !sa.private_key || !sa.project_id){
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing client_email, private_key or project_id.');
  }
  // Pasted into an env var, the key's newlines usually arrive escaped.
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return sa;
}

// Service-account JWT -> OAuth access token. Standard two-legged flow: sign a
// short-lived assertion with the private key and trade it for a bearer token.
async function accessToken(sa){
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: IDENTITY_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || !data.access_token){
    throw new Error(`Could not authenticate with Google (${data.error_description || res.status}).`);
  }
  return data.access_token;
}

async function identityToolkit(sa, token, method, body){
  const url = `https://identitytoolkit.googleapis.com/v1/projects/${sa.project_id}/accounts:${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok){
    const detail = (data.error && data.error.message) || res.status;
    throw new Error(`Identity Toolkit ${method} failed (${detail}).`);
  }
  return data;
}

export default async (req) => {
  if(req.method !== 'POST') return json(405, { ok: false, error: 'Use POST.' });

  let payload;
  try{ payload = await req.json(); }
  catch(e){ return json(400, { ok: false, error: 'Malformed request.' }); }

  const email = String(payload && payload.email || '').trim().toLowerCase();
  const password = String(payload && payload.password || '');
  if(!email || !password){
    return json(400, { ok: false, error: 'Enter your email and a new password.' });
  }
  if(password.length < MIN_PASSWORD_LENGTH){
    return json(400, { ok: false, error: `Password should be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  try{
    const sa = serviceAccount();
    const token = await accessToken(sa);
    const found = await identityToolkit(sa, token, 'lookup', { email: [email] });
    const user = found.users && found.users[0];
    if(!user){
      return json(404, { ok: false, error: 'No account found with that email.' });
    }
    await identityToolkit(sa, token, 'update', { localId: user.localId, password });
    return json(200, { ok: true });
  }catch(e){
    console.error('reset-password failed', e);
    return json(500, { ok: false, error: e.message || 'Couldn’t reset the password — try again.' });
  }
};
