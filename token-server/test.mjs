// Checks the Worker's rules with Google's token endpoint stubbed out.
import worker from './src/index.js';
const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', ALLOWED_ORIGINS: 'https://app.example' };
let sent = null;
globalThis.fetch = async (url, init) => { sent = Object.fromEntries(init.body); return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599, refresh_token: 'rt', scope: 's' })); };
const call = (path, body, origin = 'https://app.example', method = 'POST') =>
  worker.fetch(new Request(`https://w.example${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
let r = await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://app.example/fitbit-advance/' });
let b = await r.json();
check('token exchange returns tokens', r.status === 200 && b.refresh_token === 'rt' && b.access_token === 'at');
check('secret and PKCE sent to Google', sent.client_secret === 'sec' && sent.code_verifier === 'v' && sent.grant_type === 'authorization_code');
check('CORS header for the app', r.headers.get('Access-Control-Allow-Origin') === 'https://app.example');
r = await call('/refresh', { refresh_token: 'rt' }); b = await r.json();
check('refresh returns an access token', r.status === 200 && b.access_token === 'at' && sent.grant_type === 'refresh_token');
check('other sites are refused', (await call('/token', {}, 'https://evil.example')).status === 403);
check('foreign redirect refused', (await call('/token', { code: 'c', code_verifier: 'v', redirect_uri: 'https://evil.example/' })).status === 400);
check('preflight allowed', (await call('/token', null, 'https://app.example', 'OPTIONS')).status === 204);
check('unknown path 404', (await call('/nope', {})).status === 404);
process.exit(results.every(Boolean) ? 0 : 1);
