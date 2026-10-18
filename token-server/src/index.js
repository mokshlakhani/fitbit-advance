// DataStrap sign-in helper (Cloudflare Worker).
//
// Google only gives long-lasting sign-in (a refresh token) to apps that can
// keep a client secret, which a web page can't. This Worker holds the secret
// and does three things for the web app:
//   POST /token    {code, code_verifier, redirect_uri, key}  -> access + refresh token
//   POST /refresh  {refresh_token, key, ts, sig}             -> new access token
//   POST /revoke   {refresh_token, ts, sig}                  -> revokes the sign-in
// It also makes the optional Today portrait for both apps (src/portrait.js):
//   POST /portrait {image}  + Google token                   -> side-profile portrait
// It stores and logs no photos or health data (only a per-day count of portrait
// tries, under a salted hash), and never sees health data.
//
// With SEAL_KEY set, Google's refresh token never reaches the browser: the app
// gets it encrypted with SEAL_KEY ("ds1." + AES-GCM) and bound to a signing key
// the app made and can't export (`key`, a P-256 public JWK). Using it needs a
// fresh signature from that key (`sig` over "<path>.<ts>.<refresh_token>"), so a
// copy of the stored token is useless on its own. Rotating SEAL_KEY signs
// everyone out.
//
// The Origin check (ALLOWED_ORIGINS) only stops other websites' pages from
// calling the Worker in a browser; any other program can send any Origin. The
// real checks are the PKCE verifier for /token and the signature for /refresh.
import { portrait } from './portrait.js';

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const SEALED = 'ds1.';
const PROOF_WINDOW_S = 300; // a signature is good for 5 minutes either side

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
});

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const enc = new TextEncoder();

async function sealKey(env) {
  if (!env.SEAL_KEY) return null;
  const raw = unb64u(env.SEAL_KEY);
  if (raw.length !== 32) throw new Error('SEAL_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return SEALED + b64u(out);
}

async function unseal(key, token) {
  try {
    const raw = unb64u(token.slice(SEALED.length));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

// REQUIRE_BOUND: "true", "false", or a date (YYYY-MM-DD, UTC) from which it's on.
function boundRequired(setting, now = Date.now()) {
  const s = String(setting || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return now >= Date.parse(`${s}T00:00:00Z`);
  return s === 'true';
}

// The app's public signing key, reduced to what's needed to check signatures.
function publicKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  return { x: jwk.x, y: jwk.y };
}

// 'ok', 'stale' (clock too far off) or 'bad'.
async function checkProof(k, path, token, body) {
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || typeof body.sig !== 'string') return 'bad';
  if (Math.abs(Date.now() / 1000 - ts) > PROOF_WINDOW_S) return 'stale';
  try {
    const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: k.x, y: k.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(body.sig), enc.encode(`${path}.${ts}.${token}`));
    return ok ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

export default {
  async fetch(request, env) {
    const allowed = list(env.ALLOWED_ORIGINS);
    const origin = request.headers.get('Origin') || '';
    if (!allowed.includes(origin)) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    const path = new URL(request.url).pathname;
    if (path === '/portrait') return portrait(request, env, (b, status) => json(b, status, origin));
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'not_configured' }, 500, origin);

    let body, key;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, origin); }
    if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400, origin);
    try { key = await sealKey(env); } catch { return json({ error: 'not_configured' }, 500, origin); }
    const requireBound = boundRequired(env.REQUIRE_BOUND);
    const form = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    const appKey = publicKey(body.key);
    let bound = null; // {rt, x, y} once a sealed token checks out

    if (path === '/token') {
      const redirect = String(body.redirect_uri || '');
      // The redirect must be exactly one of the app's own sign-in pages.
      const redirects = list(env.ALLOWED_REDIRECTS);
      const okRedirect = redirects.length ? redirects.includes(redirect) : allowed.some(o => redirect === `${o}/`);
      if (!okRedirect) return json({ error: 'bad_redirect' }, 400, origin);
      if (!body.code || !body.code_verifier) return json({ error: 'bad_request' }, 400, origin);
      form.set('grant_type', 'authorization_code');
      form.set('code', String(body.code));
      form.set('code_verifier', String(body.code_verifier));
      form.set('redirect_uri', redirect);
    } else if (path === '/refresh' || path === '/revoke') {
      const token = String(body.refresh_token || '');
      if (!token) return json({ error: 'bad_request' }, 400, origin);
      if (token.startsWith(SEALED)) {
        bound = key && await unseal(key, token);
        if (!bound) return json({ error: 'invalid_grant' }, 400, origin);
        const proof = await checkProof(bound, path, token, body);
        if (proof === 'stale') return json({ error: 'stale_proof', now: Math.floor(Date.now() / 1000) }, 400, origin);
        if (proof !== 'ok') return json({ error: 'invalid_grant' }, 400, origin);
      } else if (requireBound || path === '/revoke') {
        // Plain refresh tokens from before binding: the app signs in again.
        return json({ error: 'invalid_grant' }, 400, origin);
      }
      const rt = bound ? bound.rt : token;
      if (path === '/revoke') {
        const res = await fetch(GOOGLE_REVOKE, { method: 'POST', body: new URLSearchParams({ token: rt }) });
        return json({ revoked: res.ok }, 200, origin);
      }
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', rt);
    } else {
      return json({ error: 'not_found' }, 404, origin);
    }

    const res = await fetch(GOOGLE_TOKEN, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data.error || 'google_error' }, res.status === 400 ? 400 : 502, origin);
    const out = { access_token: data.access_token, expires_in: data.expires_in, scope: data.scope };
    // A plain refresh token being renewed with a key is moved onto the sealed form.
    const rt = data.refresh_token || (path === '/refresh' && !bound && appKey ? form.get('refresh_token') : null);
    const k = bound || appKey;
    if (rt && key && k) out.refresh_token = await seal(key, { rt, x: k.x, y: k.y });
    else if (rt && data.refresh_token && !requireBound) out.refresh_token = rt;
    return json(out, 200, origin);
  },
};
