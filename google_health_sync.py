"""Google Health API sync: sign-in, profile, and data download into api_data/.

    python3 google_health_sync.py            # sync the last 30 days
    python3 google_health_sync.py --days 90  # more history
    python3 google_health_sync.py --auth     # sign in again

Sign-in uses the OAuth client in credentials.json (your own Google Cloud
project) if present, otherwise the project's shared oauth_client.json. It
follows Google's flow for desktop apps: a one-time local callback on
127.0.0.1 with PKCE. Tokens stay on this computer in google_tokens.json.
"""
import base64
import glob
import hashlib
import json
import os
import secrets
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, date, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler

import profile_store

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, 'google_tokens.json')
OUT_DIR = os.path.join(HERE, 'api_data')
SHARED_CLIENT_FILE = os.path.join(HERE, 'oauth_client.json')

AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.profile.readonly',
    'https://www.googleapis.com/auth/googlehealth.settings.readonly',
]


class NotConnected(Exception):
    """No usable Google sign-in; run setup.py (or this script with --auth)."""


# ---------- OAuth client ----------
def load_client():
    """The OAuth client to sign in with: your own credentials.json first, else the shared one."""
    candidates = [os.path.join(HERE, 'credentials.json')] + sorted(glob.glob(os.path.join(HERE, 'client_secret_*.json'))) + [SHARED_CLIENT_FILE]
    for path in candidates:
        if os.path.exists(path):
            with open(path) as fh:
                data = json.load(fh)
            kind = 'installed' if 'installed' in data else 'web'
            cfg = data.get(kind, {})
            if cfg.get('client_id'):
                return {'id': cfg['client_id'], 'secret': cfg.get('client_secret', ''), 'kind': kind,
                        'redirects': cfg.get('redirect_uris', []), 'file': os.path.basename(path)}
    raise NotConnected('No OAuth client found: oauth_client.json is missing from the project.')


def _redirect_for(client):
    """(redirect_uri, host, port, path) for the local callback."""
    if client['kind'] == 'installed':
        # Desktop clients accept any loopback port.
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        return f'http://127.0.0.1:{port}/', '127.0.0.1', port, '/'
    # Web clients only accept registered redirect URIs; use the registered http://localhost one.
    for uri in client['redirects']:
        u = urllib.parse.urlparse(uri)
        if u.scheme == 'http' and u.hostname in ('localhost', '127.0.0.1'):
            return uri, u.hostname, u.port or 80, u.path or '/'
    return 'http://localhost:8080/callback', 'localhost', 8080, '/callback'


def _post(url, fields):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(),
                                 headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def _save_tokens(tokens, client):
    tokens['updated_at'] = datetime.now().isoformat()
    tokens['client_id'] = client['id']
    with open(TOKEN_FILE, 'w') as fh:
        json.dump(tokens, fh, indent=2)
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return tokens


PAGE = """<!doctype html><meta charset=utf-8><title>DataStrap</title>
<body style="font-family:system-ui;background:#0D0F12;color:#ECEEF1;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-weight:500">{title}</h1><p style="color:#B9BFC8">{body}</p></div>"""


def authorize(client=None):
    """Open Google's consent page and wait for the one-time callback."""
    client = client or load_client()
    redirect_uri, host, port, path = _redirect_for(client)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    state = secrets.token_urlsafe(16)
    url = AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id': client['id'], 'redirect_uri': redirect_uri, 'response_type': 'code',
        'scope': ' '.join(SCOPES), 'access_type': 'offline', 'prompt': 'consent',
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': state,
    })
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path != path or q.get('state', [''])[0] != state:
                self.send_response(404)
                self.end_headers()
                return
            if 'code' in q:
                result['code'] = q['code'][0]
                page = PAGE.format(title='Connected', body='You can close this tab. Your dashboard is being built in the terminal.')
            else:
                result['error'] = q.get('error', ['unknown'])[0]
                page = PAGE.format(title='Not connected', body=f"Google returned: {result['error']}. Close this tab and try again.")
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(page.encode())

        def log_message(self, *args):
            pass

    server = HTTPServer((host if host != 'localhost' else '127.0.0.1', port), Handler)
    server.timeout = 1
    print('\nOpening Google sign-in in your browser. If it doesn\'t open, visit:\n  ' + url + '\n')
    webbrowser.open(url)
    deadline = datetime.now() + timedelta(minutes=5)
    while not result and datetime.now() < deadline:
        server.handle_request()
    server.server_close()
    if 'code' not in result:
        raise NotConnected(f"Sign-in didn't complete ({result.get('error', 'timed out')}).")
    tokens = _post(TOKEN_URL, {'client_id': client['id'], 'client_secret': client['secret'], 'code': result['code'],
                               'code_verifier': verifier, 'grant_type': 'authorization_code', 'redirect_uri': redirect_uri})
    return _save_tokens(tokens, client)


def get_valid_tokens(interactive=False):
    """A current access token, refreshing it when needed.

    With interactive=True a missing or revoked sign-in opens the browser;
    otherwise NotConnected is raised (e.g. in the scheduled daily sync).
    """
    client = load_client()
    tokens = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as fh:
            tokens = json.load(fh)
        if tokens.get('client_id') not in (None, client['id']):
            tokens = None  # signed in through a different OAuth client
    if tokens:
        updated = datetime.fromisoformat(tokens.get('updated_at', '1970-01-01T00:00:00'))
        if (datetime.now() - updated).total_seconds() < tokens.get('expires_in', 0) - 300:
            return tokens
        refresh = tokens.get('refresh_token')
        if refresh:
            try:
                new = _post(TOKEN_URL, {'client_id': client['id'], 'client_secret': client['secret'],
                                        'refresh_token': refresh, 'grant_type': 'refresh_token'})
                new.setdefault('refresh_token', refresh)  # Google omits it on refresh
                return _save_tokens(new, client)
            except urllib.error.HTTPError as e:
                if e.code not in (400, 401):
                    raise
                # invalid_grant: revoked, or expired (apps in Google's "Testing" mode expire after 7 days)
    if interactive:
        return authorize(client)
    raise NotConnected('Google sign-in is missing or has expired. Run: python3 google_health_sync.py --auth')


# ---------- Profile ----------
def _get(path, token):
    req = urllib.request.Request(f'https://health.googleapis.com/v4/users/me/{path}', headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


def _latest(token, data_type, field, value_key):
    points, page = [], None
    while True:
        q = {'pageSize': 1000, **({'pageToken': page} if page else {})}
        body = _get(f'dataTypes/{data_type}/dataPoints?' + urllib.parse.urlencode(q), token)
        points += body.get('dataPoints', [])
        page = body.get('nextPageToken')
        if not page:
            break
    if not points:
        return None
    p = max(points, key=lambda x: x[field]['sampleTime']['physicalTime'])
    return float(p[field][value_key])


def sync_profile(token):
    """Age, time zone, units, height and weight -> profile.json (best effort)."""
    found = {}
    for label, fn in [
        ('profile', lambda: _get('profile', token)),
        ('settings', lambda: _get('settings', token)),
    ]:
        try:
            body = fn()
        except urllib.error.HTTPError:
            continue
        if label == 'profile':
            # The profile's `name` field is the resource ID (users/…/profile),
            # not a display name, so only the age is used.
            found.update(age=body.get('age'))
        else:
            found.update(timezone=body.get('timeZone'), temperature_unit=body.get('temperatureUnit'))
    for key, args, scale in [('weight_kg', ('weight', 'weight', 'weightGrams'), 1000.0),
                             ('height_cm', ('height', 'height', 'heightMillimeters'), 10.0)]:
        try:
            v = _latest(token, *args)
            if v:
                found[key] = round(v / scale, 1)
        except (urllib.error.HTTPError, KeyError, ValueError):
            pass
    return profile_store.save(found)


API_BASE = 'https://health.googleapis.com/v4/users/me/dataTypes'
OUT_DIR = 'api_data'

# data type id -> (filter field, filter kind). Kind decides the value format:
# 'date' = YYYY-MM-DD, 'civil' = YYYY-MM-DDT00:00:00, 'utc' = RFC-3339.
DATA_TYPES = {
    'heart-rate':                          ('heart_rate.sample_time.physical_time', 'utc'),
    'daily-heart-rate-variability':        ('daily_heart_rate_variability.date', 'date'),
    'daily-resting-heart-rate':            ('daily_resting_heart_rate.date', 'date'),
    'daily-oxygen-saturation':             ('daily_oxygen_saturation.date', 'date'),
    'daily-sleep-temperature-derivations': ('daily_sleep_temperature_derivations.date', 'date'),
    'daily-respiratory-rate':              ('daily_respiratory_rate.date', 'date'),
    'sleep':                               ('sleep.interval.end_time', 'utc'),
    'exercise':                            ('exercise.interval.civil_start_time', 'civil'),
    'steps':                               ('steps.interval.start_time', 'utc'),
    'total-calories':                      ('total_calories.interval.start_time', 'utc'),
    'vo2-max':                             ('vo2_max.sample_time.physical_time', 'utc'),
}

# Fitbit device + workouts logged in the Fitbit app. Excludes other apps syncing
# through Health Connect (e.g. Samsung Health), which otherwise double-count steps
# and add conflicting SpO2 readings.
SOURCE_FAMILY = 'users/me/dataSourceFamilies/google-sources'
ALL_SOURCES_ONLY = {'sleep'}  # API rejects source filtering here; filtered in api_ingest

def fmt_bound(d, kind):
    if kind == 'date':
        return d.isoformat()
    if kind == 'civil':
        return f"{d.isoformat()}T00:00:00"
    return f"{d.isoformat()}T00:00:00Z"

def fetch_data_type(access_token, data_type, start, end):
    field, kind = DATA_TYPES[data_type]
    flt = f'{field} >= "{fmt_bound(start, kind)}" AND {field} < "{fmt_bound(end, kind)}"'
    if data_type == 'sleep':
        flt = f'{field} >= "{fmt_bound(start, kind)}"'  # sleep only supports >= on end_time
    points, page_token = [], None
    while True:
        params = {'filter': flt, 'pageSize': 10000}
        if data_type not in ALL_SOURCES_ONLY:
            params['dataSourceFamily'] = SOURCE_FAMILY
        if page_token:
            params['pageToken'] = page_token
        url = f"{API_BASE}/{data_type}/dataPoints?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={'Authorization': f"Bearer {access_token}"})
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode('utf-8'))
        points.extend(body.get('dataPoints', []))
        page_token = body.get('nextPageToken')
        if not page_token:
            return points

# High-frequency types (a sample every ~2 s) are pulled at full resolution, one
# file per UTC day under api_data/<type>/, several days in parallel. Days already
# on disk are skipped except the most recent ones, which may still be filling in.
DAILY_FILE_TYPES = ['heart-rate', 'steps', 'total-calories']
# total-calories has no list endpoint, only rollups. Fitbit records calories per
# minute, so a 60 s window is the device's native resolution.
ROLLUP_ONLY_TYPES = {'total-calories': '60s'}
REFRESH_RECENT_DAYS = 2
WORKERS = 6

def fetch_rollup_day(access_token, data_type, day, window):
    body = {
        'range': {'startTime': f"{day.isoformat()}T00:00:00Z",
                  'endTime': f"{(day + timedelta(days=1)).isoformat()}T00:00:00Z"},
        'windowSize': window,
        'pageSize': 10000,
        'dataSourceFamily': SOURCE_FAMILY,
    }
    req = urllib.request.Request(
        f"{API_BASE}/{data_type}/dataPoints:rollUp",
        data=json.dumps(body).encode('utf-8'),
        headers={'Authorization': f"Bearer {access_token}", 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8')).get('rollupDataPoints', [])

# Compact storage: each reading becomes one CSV row with only the values that
# vary, gzipped. Every sample is kept at its original timestamp.
COMPACT_COLUMNS = {
    'heart-rate':     ['time', 'bpm', 'device'],
    'steps':          ['start', 'end', 'count', 'device'],
    'total-calories': ['start', 'end', 'kcal'],
}

def compact_rows(data_type, points):
    rows = []
    for p in points:
        device = p.get('dataSource', {}).get('device', {}).get('displayName', '')
        if data_type == 'heart-rate':
            hr = p['heartRate']
            rows.append((hr['sampleTime']['physicalTime'], hr['beatsPerMinute'], device))
        elif data_type == 'steps':
            st = p['steps']
            rows.append((st['interval']['startTime'], st['interval']['endTime'], st['count'], device))
        elif data_type == 'total-calories':
            rows.append((p['startTime'], p['endTime'], p['totalCalories']['kcalSum']))
    return rows

def write_compact(path, data_type, points):
    import csv, gzip
    with gzip.open(path, 'wt', newline='') as f:
        w = csv.writer(f)
        w.writerow(COMPACT_COLUMNS[data_type])
        w.writerows(compact_rows(data_type, points))

def sync_daily_files(access_token, data_type, start, end):
    from concurrent.futures import ThreadPoolExecutor
    type_dir = os.path.join(OUT_DIR, data_type)
    os.makedirs(type_dir, exist_ok=True)
    fresh_cutoff = date.today() - timedelta(days=REFRESH_RECENT_DAYS)
    days = []
    d = start
    while d < end:
        path = os.path.join(type_dir, f"{d.isoformat()}.csv.gz")
        if d >= fresh_cutoff or not os.path.exists(path):
            days.append(d)
        d += timedelta(days=1)

    def pull(day):
        if data_type in ROLLUP_ONLY_TYPES:
            points = fetch_rollup_day(access_token, data_type, day, ROLLUP_ONLY_TYPES[data_type])
        else:
            points = fetch_data_type(access_token, data_type, day, day + timedelta(days=1))
        write_compact(os.path.join(type_dir, f"{day.isoformat()}.csv.gz"), data_type, points)
        return len(points)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        counts = list(pool.map(pull, days))
    return len(days), sum(counts)

def point_key(p):
    # Sessions (sleep, exercise) carry a stable resource name; daily summaries
    # are unique per source + day.
    if p.get('name'):
        return p['name']
    body = next(v for k, v in p.items() if k != 'dataSource')
    return json.dumps([p.get('dataSource'), body.get('date')], sort_keys=True)

def merge_into_file(path, points):
    # Each run only pulls a recent window, so merge it into what is already
    # stored rather than overwriting older history. Newly fetched points win.
    merged = {}
    if os.path.exists(path):
        with open(path) as f:
            for p in json.load(f):
                merged[point_key(p)] = p
    for p in points:
        merged[point_key(p)] = p
    with open(path, 'w') as f:
        json.dump(list(merged.values()), f, indent=1)
    return len(merged)

def sync(days, interactive=False, log=print):
    """Refresh the profile and download the last `days` days into api_data/."""
    tokens = get_valid_tokens(interactive=interactive)
    token = tokens['access_token']
    sync_profile(token)
    end = date.today() + timedelta(days=1)
    start = end - timedelta(days=days + 1)
    os.makedirs(OUT_DIR, exist_ok=True)
    log(f"Syncing {start} -> {end}")
    for data_type in DATA_TYPES:
        try:
            if data_type in DAILY_FILE_TYPES:
                n_days, n_points = sync_daily_files(token, data_type, start, end)
                log(f"  {data_type:38s} {n_points:8d} points ({n_days} days fetched)")
                continue
            points = fetch_data_type(token, data_type, start, end)
        except urllib.error.HTTPError as e:
            log(f"  {data_type:38s} FAILED {e.code}: {e.read().decode('utf-8')[:300]}")
            continue
        total = merge_into_file(os.path.join(OUT_DIR, f"{data_type}.json"), points)
        log(f"  {data_type:38s} {len(points):8d} points ({total} stored)")


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description='Google Health API sync')
    ap.add_argument('--auth', action='store_true', help='sign in to Google again')
    ap.add_argument('--days', type=int, default=30, help='days of history to pull (default 30)')
    args = ap.parse_args()
    try:
        if args.auth:
            authorize()
        # Only open a browser when someone is at the keyboard, never from the scheduler.
        sync(args.days, interactive=sys.stdin.isatty())
    except NotConnected as e:
        print(f'Not connected: {e}')
        sys.exit(2)
