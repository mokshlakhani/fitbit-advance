// Google sign-in for the web version (iPhone home-screen app, any browser).
//
// Uses Google's browser OAuth flow with a full-page redirect: popups don't
// work reliably in home-screen apps on iPhone. Google gives browser apps
// access tokens that last an hour and no refresh token, so when a token runs
// out the app redirects again with prompt=none, which returns immediately
// without any screen while the person is still signed in to Google.
//
// With a sign-in helper configured (config.json tokenServer, the Worker in
// token-server/), it uses the authorization-code flow with PKCE instead: the
// helper adds the client secret, so Google returns a refresh token and the
// app renews its pass in the background without leaving the page. The
// helper hands back the refresh token sealed and bound to a signing key this
// browser made and can't export (webKey), so a copy of the stored token is
// useless anywhere else.
//
// Tokens are kept in IndexedDB only (never localStorage); they never leave the
// device except to call Google or the sign-in helper. Without a helper, the
// implicit flow (token in the address) is used only if config.json sets
// allowImplicitFlow.
import * as store from './store.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];
// Asked for only when someone first logs a workout (Log +).
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.writeonly';
const EARLY_MS = 2 * 60 * 1000; // treat tokens as expired 2 minutes early

let config = null;
async function loadConfig() {
  config ||= await fetch('config.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  return config;
}
async function clientId() { return (await loadConfig()).googleClientId || null; }
async function tokenServer() { return (await loadConfig()).tokenServer || null; }
const SEALED = 'ds1.';

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function pkce() {
  const v = new Uint8Array(32);
  crypto.getRandomValues(v);
  const verifier = b64url(v);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function callServer(path, body) {
  const server = await tokenServer();
  const res = await fetch(`${server.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `sign-in helper ${res.status}`), { status: res.status, reason: data.error, now: data.now });
  return data;
}

// This browser's signing key: the private half can't be exported, even by
// the app itself. null where the browser can't make or store one.
async function deviceKey() {
  const saved = await store.get('webKey').catch(() => null);
  if (saved && saved.privateKey) return saved;
  try {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await store.set('webKey', k);
    return k;
  } catch {
    return null;
  }
}
async function publicJwk(k) {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', k.publicKey);
  return { kty, crv, x, y };
}

// Calls the helper with proof that this browser holds the key the refresh
// token is bound to. Retries once on the helper's clock if the phone's is off.
async function callWithProof(path, refreshToken) {
  const k = await deviceKey();
  if (!k) return callServer(path, { refresh_token: refreshToken });
  const send = async (skew = 0) => {
    const ts = Math.floor(Date.now() / 1000) + skew;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, new TextEncoder().encode(`${path}.${ts}.${refreshToken}`));
    return callServer(path, { refresh_token: refreshToken, key: await publicJwk(k), ts, sig: b64url(sig) });
  };
  try {
    return await send();
  } catch (err) {
    if (err.reason !== 'stale_proof' || !Number.isFinite(err.now)) throw err;
    return send(Math.round(err.now - Date.now() / 1000));
  }
}

function saveTokens(data, prev = {}) {
  const granted = (data.scope || '').split(' ').filter(Boolean);
  return store.set('webToken', {
    token: data.access_token,
    expires: Date.now() + Number(data.expires_in || 3600) * 1000,
    refresh: data.refresh_token || prev.refresh || null,
    missing: granted.length ? SCOPES.filter(x => !granted.includes(x)) : (prev.missing || []),
    canWrite: granted.length ? granted.includes(WRITE_SCOPE) : Boolean(prev.canWrite),
  });
}

function redirectUri() {
  return location.origin + location.pathname;
}

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

/** Send the page to Google. Resolves never (the page navigates away). */
async function redirect({ silent, write = false }) {
  const id = await clientId();
  if (!id) throw Object.assign(new Error('This copy of DataStrap has no Google client ID set up (config.json).'), { code: 'NO_CLIENT' });
  const state = randomState();
  // Remember where the person was, to come back to the same page.
  // localStorage, not sessionStorage: iOS can reopen a home-screen app fresh
  // on the way back from Google, which loses sessionStorage and with it the
  // returning sign-in.
  const server = await tokenServer();
  if (!server && !(await loadConfig()).allowImplicitFlow) {
    throw Object.assign(new Error('This copy of DataStrap has no sign-in helper set up (config.json tokenServer).'), { code: 'NO_CLIENT' });
  }
  const codes = server ? await pkce() : null;
  localStorage.setItem('ds-oauth', JSON.stringify({ state, hash: location.hash, silent, at: Date.now(), verifier: codes && codes.verifier }));
  const q = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: codes ? 'code' : 'token',
    scope: (write ? [...SCOPES, WRITE_SCOPE] : SCOPES).join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (codes) {
    q.set('code_challenge', codes.challenge);
    q.set('code_challenge_method', 'S256');
    q.set('access_type', 'offline');
    // Google returns a refresh token only on a consent screen.
    if (!silent) q.set('prompt', 'consent');
  }
  if (silent) q.set('prompt', 'none');
  location.assign(`${AUTH_URL}?${q}`);
  return new Promise(() => {});
}

/**
 * Handle Google's redirect back, if this page load is one. Must run before the
 * dashboard reads location.hash. Returns 'signed-in', 'needs-consent', 'error' or null.
 */
export async function completeRedirect() {
  const saved = localStorage.getItem('ds-oauth');
  const query = new URLSearchParams(location.search);
  const isCode = query.has('code') || (query.has('error') && query.has('state'));
  if (!saved || !(isCode || /(^#|&)(access_token|error)=/.test(location.hash))) return null;
  localStorage.removeItem('ds-oauth');
  const { state, hash, silent, verifier } = JSON.parse(saved);
  const p = isCode ? query : new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + (hash || ''));
  if (isCode) {
    if (p.get('state') !== state) return 'error';
    if (p.get('error')) {
      await store.set('webAuthError', silent ? null : p.get('error'));
      return ['interaction_required', 'login_required', 'consent_required'].includes(p.get('error')) ? 'needs-consent' : 'error';
    }
    try {
      const prev = (await store.get('webToken')) || {};
      const k = await deviceKey();
      const body = { code: p.get('code'), code_verifier: verifier, redirect_uri: redirectUri() };
      if (k) body.key = await publicJwk(k);
      await saveTokens(await callServer('/token', body), prev);
    } catch (err) {
      await store.set('webAuthError', String(err.reason || err.message || 'token_exchange'));
      return 'error';
    }
    await store.set('webAuthError', null);
    return 'signed-in';
  }
  if (p.get('state') !== state) return 'error';
  if (p.get('error')) {
    await store.set('webAuthError', silent ? null : p.get('error'));
    return ['interaction_required', 'login_required', 'consent_required'].includes(p.get('error')) ? 'needs-consent' : 'error';
  }
  const granted = (p.get('scope') || '').split(' ');
  const missing = SCOPES.filter(s => !granted.includes(s));
  await store.set('webToken', {
    token: p.get('access_token'),
    expires: Date.now() + Number(p.get('expires_in') || 3600) * 1000,
    missing,
    canWrite: granted.includes(WRITE_SCOPE),
  });
  await store.set('webAuthError', null);
  return 'signed-in';
}

/** A valid access token, or an error with code NEEDS_REDIRECT (silent) / NEEDS_CONSENT. */
let renewing = null;
export async function getToken({ refresh = false } = {}) {
  const t = await store.get('webToken');
  if (t && !refresh && t.expires - EARLY_MS > Date.now()) return t.token;
  // Long-lasting sign-in: renew in the background, no redirect.
  if (t && t.refresh && (await tokenServer())) {
    renewing ||= (async () => {
      try {
        await saveTokens(await callWithProof('/refresh', t.refresh), t);
        return (await store.get('webToken')).token;
      } catch (err) {
        if (err.reason === 'invalid_grant') {
          // Access was revoked or has expired: a real sign-in is needed.
          await store.del('webToken');
          throw Object.assign(new Error('Google sign-in has expired.'), { code: 'NEEDS_CONSENT' });
        }
        throw err; // offline or the helper is down: try again next sync
      } finally { renewing = null; }
    })();
    return renewing;
  }
  if (refresh) await store.del('webToken'); // Google rejected it
  throw Object.assign(new Error('Google sign-in needs refreshing.'), { code: 'NEEDS_REDIRECT' });
}

export const signIn = () => redirect({ silent: false });
/** Adds permission to log workouts (leaves the page; comes back signed in). */
export const signInToWrite = () => redirect({ silent: false, write: true });

/** Whether the current token may log workouts. */
export async function canWrite() {
  const t = await store.get('webToken');
  return Boolean(t && t.canWrite && (t.refresh || t.expires - EARLY_MS > Date.now()));
}
export const refreshSilently = () => redirect({ silent: true });

// A refresh token counts: getToken renews the pass without leaving the page.
export async function hasValidToken() {
  const t = await store.get('webToken');
  return Boolean(t && (t.expires - EARLY_MS > Date.now() || (t.refresh && (await tokenServer()))));
}

export async function signOut() {
  const t = await store.get('webToken');
  await store.del('webToken');
  // Revokes this app's access to the Google account. A sealed refresh token
  // only the helper can open; revoking the access token also ends the sign-in.
  const sealed = t?.refresh?.startsWith(SEALED);
  if (sealed) callWithProof('/revoke', t.refresh).catch(() => {});
  const token = sealed ? t.token : (t?.refresh || t?.token);
  if (token) {
    fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }) }).catch(() => {});
  }
}
