// Google sign-in for the web version (iPhone home-screen app, any browser).
//
// Uses Google's browser OAuth flow with a full-page redirect: popups don't
// work reliably in home-screen apps on iPhone. Google gives browser apps
// access tokens that last an hour and no refresh token, so when a token runs
// out the app redirects again with prompt=none, which returns immediately
// without any screen while the person is still signed in to Google.
//
// The token is kept in IndexedDB with its expiry; it never leaves the device
// except to call Google.
import * as store from './store.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
];
const EARLY_MS = 2 * 60 * 1000; // treat tokens as expired 2 minutes early

let config = null;
async function clientId() {
  config ||= await fetch('config.json').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  return config.googleClientId || null;
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
async function redirect({ silent }) {
  const id = await clientId();
  if (!id) throw Object.assign(new Error('This copy of DataStrap has no Google client ID set up (config.json).'), { code: 'NO_CLIENT' });
  const state = randomState();
  // Remember where the person was, to come back to the same page.
  sessionStorage.setItem('ds-oauth', JSON.stringify({ state, hash: location.hash, silent }));
  const q = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (silent) q.set('prompt', 'none');
  location.assign(`${AUTH_URL}?${q}`);
  return new Promise(() => {});
}

/**
 * Handle Google's redirect back, if this page load is one. Must run before the
 * dashboard reads location.hash. Returns 'signed-in', 'needs-consent', 'error' or null.
 */
export async function completeRedirect() {
  const saved = sessionStorage.getItem('ds-oauth');
  if (!saved || !/(^#|&)(access_token|error)=/.test(location.hash)) return null;
  sessionStorage.removeItem('ds-oauth');
  const { state, hash, silent } = JSON.parse(saved);
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search + (hash || ''));
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
  });
  await store.set('webAuthError', null);
  return 'signed-in';
}

/** A valid access token, or an error with code NEEDS_REDIRECT (silent) / NEEDS_CONSENT. */
export async function getToken({ refresh = false } = {}) {
  const t = await store.get('webToken');
  if (t && !refresh && t.expires - EARLY_MS > Date.now()) return t.token;
  if (refresh) await store.del('webToken'); // Google rejected it
  throw Object.assign(new Error('Google sign-in needs refreshing.'), { code: 'NEEDS_REDIRECT' });
}

export const signIn = () => redirect({ silent: false });
export const refreshSilently = () => redirect({ silent: true });

export async function hasValidToken() {
  const t = await store.get('webToken');
  return Boolean(t && t.expires - EARLY_MS > Date.now());
}

export async function signOut() {
  const t = await store.get('webToken');
  await store.del('webToken');
  if (t?.token) {
    // Revokes this app's access to the Google account.
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: 'POST' }).catch(() => {});
  }
}
