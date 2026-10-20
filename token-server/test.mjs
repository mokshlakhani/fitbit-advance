// Checks the Worker's rules with Google's token endpoint stubbed out.
import worker from './src/index.js';
import { portraitPrompt } from './src/portrait.js';
const SEAL_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const base = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_ORIGINS: 'https://app.example' };
let env = { ...base };
let sent = null, sentTo = null;
globalThis.fetch = async (url, init) => {
  sentTo = url; sent = Object.fromEntries(init.body);
  return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599, refresh_token: sent.grant_type === 'authorization_code' ? 'rt' : undefined, scope: 's' }));
};
const call = (path, body, origin = 'https://app.example', method = 'POST') =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const b64u = b => Buffer.from(b).toString('base64url');

// The app's side: a key it can't export, and a signature per request.
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keys.publicKey);
const jwk = { kty, crv, x, y };
const sign = async (k, path, token, ts = Math.floor(Date.now() / 1000)) =>
  ({ ts, sig: b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, new TextEncoder().encode(`${path}.${ts}.${token}`))) });
const redirect_uri = 'https://app.example/';

// Without SEAL_KEY: plain tokens, as before.
let r = await call('/token', { code: 'c', code_verifier: 'v', redirect_uri });
let b = await r.json();
check('token exchange returns tokens', r.status === 200 && b.refresh_token === 'rt' && b.access_token === 'at');
check('secret and PKCE sent to Google', sent.client_secret === 'sec' && sent.code_verifier === 'v' && sent.grant_type === 'authorization_code');
check('CORS header for the app', r.headers.get('Access-Control-Allow-Origin') === 'https://app.example');
r = await call('/refresh', { refresh_token: 'rt' }); b = await r.json();
check('refresh returns an access token', r.status === 200 && b.access_token === 'at' && sent.grant_type === 'refresh_token');
check('other sites are refused', (await call('/token', {}, 'https://evil.example')).status === 403);
check('foreign redirect refused', (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://evil.example/' })).status === 400);
check('other page on the same site refused', (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://app.example/other/' })).status === 400);
env = { ...base, ALLOWED_REDIRECTS: 'https://app.example/DataStrap/' };
check('listed redirect allowed', (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://app.example/DataStrap/' })).status === 200);
check('unlisted redirect refused', (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://app.example/DataStrap/x' })).status === 400);
check('preflight allowed', (await call('/token', null, 'https://app.example', 'OPTIONS')).status === 204);
check('unknown path 404', (await call('/nope', {})).status === 404);

// With SEAL_KEY: the refresh token is sealed and bound to the app's key.
env = { ...base, SEAL_KEY };
r = await call('/token', { code: 'c', code_verifier: 'v', redirect_uri, key: jwk }); b = await r.json();
const sealed = b.refresh_token;
check('bound sign-in returns a sealed token', r.status === 200 && sealed.startsWith('ds1.') && !sealed.includes('rt'));
r = await call('/refresh', { refresh_token: sealed, ...(await sign(keys, '/refresh', sealed)) }); b = await r.json();
check('signed refresh works', r.status === 200 && b.access_token === 'at' && sent.refresh_token === 'rt');
r = await call('/refresh', { refresh_token: sealed }); b = await r.json();
check('sealed token without a signature refused', r.status === 400 && b.error === 'invalid_grant');
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
r = await call('/refresh', { refresh_token: sealed, ...(await sign(other, '/refresh', sealed)) }); b = await r.json();
check('signature from another key refused', r.status === 400 && b.error === 'invalid_grant');
r = await call('/refresh', { refresh_token: sealed, ...(await sign(keys, '/revoke', sealed)) });
check('signature for another path refused', r.status === 400);
r = await call('/refresh', { refresh_token: sealed, ...(await sign(keys, '/refresh', sealed, Math.floor(Date.now() / 1000) - 3600)) }); b = await r.json();
check('old signature reported with server time', r.status === 400 && b.error === 'stale_proof' && Math.abs(b.now - Date.now() / 1000) < 5);
const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
r = await call('/refresh', { refresh_token: tampered, ...(await sign(keys, '/refresh', tampered)) });
check('tampered token refused', r.status === 400);
r = await call('/refresh', { refresh_token: sealed, ...(await sign(keys, '/refresh', sealed)) }, 'https://app.example');
check('same token still works after failures', r.status === 200);

// Older app versions: a plain token is moved onto the sealed form.
r = await call('/refresh', { refresh_token: 'rt', key: jwk }); b = await r.json();
check('plain token with a key comes back sealed', r.status === 200 && b.refresh_token.startsWith('ds1.'));
r = await call('/refresh', { refresh_token: b.refresh_token, ...(await sign(keys, '/refresh', b.refresh_token)) });
check('migrated token works with the key', r.status === 200 && sent.refresh_token === 'rt');
env = { ...base, SEAL_KEY, REQUIRE_BOUND: '2999-01-01' };
check('plain token still moved before the cut-off date', (await call('/refresh', { refresh_token: 'rt', key: jwk })).status === 200);
env = { ...base, SEAL_KEY, REQUIRE_BOUND: '2020-01-01' };
check('plain token refused after the cut-off date', (await call('/refresh', { refresh_token: 'rt', key: jwk })).status === 400);
env = { ...base, SEAL_KEY, REQUIRE_BOUND: 'true' };
check('plain token refused once binding is required', (await call('/refresh', { refresh_token: 'rt' })).status === 400);
b = await (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri })).json();
check('no plain refresh token handed out when binding is required', b.access_token === 'at' && !b.refresh_token);

r = await call('/revoke', { refresh_token: sealed, ...(await sign(keys, '/revoke', sealed)) }); b = await r.json();
check('signed revoke reaches Google', r.status === 200 && b.revoked && sentTo.endsWith('/revoke') && sent.token === 'rt');
check('unsigned revoke refused', (await call('/revoke', { refresh_token: sealed })).status === 400);
env = { ...base, SEAL_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') };
check('new SEAL_KEY signs everyone out', (await call('/refresh', { refresh_token: sealed, ...(await sign(keys, '/refresh', sealed)) })).status === 400);

env = { ...base };
// ---------- /portrait, with Google Health and Gemini stubbed ----------
const kv = new Map();
const penv = { ...env, GEMINI_API_KEY: 'gk', PORTRAIT_SALT: 'salt', PORTRAIT_WEEKLY_LIMIT: '2',
  PORTRAIT_LIMITS: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
let stub = {};
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push(url);
  const ok = b => new Response(JSON.stringify(b));
  if (url.includes('health.googleapis.com')) {
    if (init.headers.Authorization !== 'Bearer good') return new Response('{}', { status: 401 });
    return ok({ name: 'users/123/profile' });
  }
  const body = JSON.parse(init.body);
  if (init.headers['x-goog-api-key'] !== 'gk') return new Response('{}', { status: 403 });
  const text = body.contents[0].parts.find(p => p.text).text;
  if (text.startsWith('Look at this photo')) return ok(stub.check ?? { candidates: [{ content: { parts: [{ text: '{"one_person":true,"face_visible":true}' }] } }] });
  if (text.startsWith('Using the person')) {
    stub.genConfig = body.generationConfig;
    (stub.prompts ||= []).push(text);
    return ok(stub.gen ?? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'UE5H' } }] } }] });
  }
  return ok(stub.pins ?? { candidates: [{ content: { parts: [{ text: '{"brain":{"x":450,"y":200},"throat":{"x":600,"y":540},"chest":{"x":640,"y":800},"shoulder":{"x":330,"y":730}}' }] } }] });
};
const pcall = (body, token = 'good') => worker.fetch(new Request('https://w.example/portrait', {
  method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), penv);

check('portrait: not configured without a key', (await worker.fetch(new Request('https://w.example/portrait', { method: 'POST', headers: { Origin: 'https://app.example' }, body: '{}' }), env)).status === 503);
check('portrait: preflight allows Authorization', (await call('/portrait', null, 'https://app.example', 'OPTIONS')).headers.get('Access-Control-Allow-Headers').includes('Authorization'));
check('portrait: bad Google token refused', (await pcall({ image: 'QUJD' }, 'bad')).status === 401);
check('portrait: missing image refused', (await pcall({})).status === 400);
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: returns image, pins and tries left', r.status === 200 && b.image === 'UE5H' && b.mime === 'image/png' && b.pins.brain.x === 45 && b.pins.throat.y === 54 && b.remaining === 1);
check('portrait: asks for a square image', stub.genConfig.responseModalities[0] === 'IMAGE' && stub.genConfig.imageConfig.aspectRatio === '1:1');
check('portrait: no sex set gets the collarbone crop', /below the collarbones/.test(stub.prompts.at(-1)) && !/Bare-chested/.test(stub.prompts.at(-1)));
check('portrait: men bare-chested, women cropped at the collarbones', /Bare-chested/.test(portraitPrompt('male'))
  && /below the collarbones/.test(portraitPrompt('female')) && !/Bare-chested/.test(portraitPrompt('female')));
check('portrait: key never echoed', !JSON.stringify(b).includes('gk'));
check('portrait: only a salted hash is stored', [...kv.keys()].every(k => /^p:[0-9a-f]{64}$/.test(k) && !k.includes('123')));
stub.check = { candidates: [{ content: { parts: [{ text: '{"one_person":false,"face_visible":true}' }] } }] };
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: two people rejected without using a try', r.status === 422 && b.reason === 'one_person' && [...kv.values()][0] === '1');
stub = { pins: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] } };
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: pins fall back to defaults', r.status === 200 && b.pins.chest.x === 64 && b.remaining === 0);
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: weekly limit, with the reset date', r.status === 429 && b.error === 'weekly_limit' && /^\d{4}-\d\d-\d\d$/.test(b.resets));
kv.clear();
stub = { pins: { candidates: [{ content: { parts: [{ text: '{"brain":{"x":515,"y":255},"throat":{"x":624,"y":558},"chest":{"x":393,"y":807},"shoulder":{"x":260,"y":623}}' }] } }] } };
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: a chest pin on the arm moves under the throat', b.pins.chest.x === 58.4 && b.pins.chest.y === 80.8);
kv.clear();
stub = { gen: { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] } };
r = await pcall({ image: 'QUJD' }); b = await r.json();
check('portrait: safety block reported', r.status === 422 && b.error === 'portrait_blocked');
check('portrait: token routes still work', (await (async () => { globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'at' })); return (await call('/refresh', { refresh_token: 'rt' })).status; })()) === 200);

process.exit(results.every(Boolean) ? 0 : 1);
