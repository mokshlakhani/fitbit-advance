// DataStrap sign-in helper (Cloudflare Worker).
//
// Google only gives long-lasting sign-in (a refresh token) to apps that can
// keep a client secret, which a web page can't. This Worker holds the secret
// and does exactly two things for the web app:
//   POST /token    {code, code_verifier, redirect_uri}  -> access + refresh token
//   POST /refresh  {refresh_token}                      -> new access token
// It stores nothing and logs nothing, never sees health data, and only
// answers the web app's own addresses (ALLOWED_ORIGINS).
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, origin) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) },
});

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (!allowed.includes(origin)) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'not_configured' }, 500, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, origin); }
    const path = new URL(request.url).pathname;
    const form = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });

    if (path === '/token') {
      const redirect = String(body.redirect_uri || '');
      // The redirect must be one of the app's own pages.
      if (!allowed.some(o => redirect === `${o}/` || redirect.startsWith(`${o}/`))) return json({ error: 'bad_redirect' }, 400, origin);
      if (!body.code || !body.code_verifier) return json({ error: 'bad_request' }, 400, origin);
      form.set('grant_type', 'authorization_code');
      form.set('code', String(body.code));
      form.set('code_verifier', String(body.code_verifier));
      form.set('redirect_uri', redirect);
    } else if (path === '/refresh') {
      if (!body.refresh_token) return json({ error: 'bad_request' }, 400, origin);
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', String(body.refresh_token));
    } else {
      return json({ error: 'not_found' }, 404, origin);
    }

    const res = await fetch(GOOGLE_TOKEN, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: data.error || 'google_error' }, res.status === 400 ? 400 : 502, origin);
    const out = { access_token: data.access_token, expires_in: data.expires_in, scope: data.scope };
    if (data.refresh_token) out.refresh_token = data.refresh_token;
    return json(out, 200, origin);
  },
};
