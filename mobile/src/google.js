// Google Health API sync on the phone (port of google_health_sync.sync).
// Downloads into the IndexedDB store; nothing leaves the phone except the
// requests to Google.
import * as store from './store.js';
import { minuteAggregateSeconds, isDatastrap } from './ingest.js';
import { pyRound } from './engine.js';

const API = 'https://health.googleapis.com/v4/users/me';
const SOURCE_FAMILY = 'users/me/dataSourceFamilies/google-sources';

// data type -> [filter field, bound kind]: 'date' YYYY-MM-DD, 'civil' local midnight, 'utc' RFC-3339.
const SUMMARY_TYPES = {
  'daily-heart-rate-variability': ['daily_heart_rate_variability.date', 'date'],
  'daily-resting-heart-rate': ['daily_resting_heart_rate.date', 'date'],
  'daily-oxygen-saturation': ['daily_oxygen_saturation.date', 'date'],
  'daily-sleep-temperature-derivations': ['daily_sleep_temperature_derivations.date', 'date'],
  'daily-respiratory-rate': ['daily_respiratory_rate.date', 'date'],
  sleep: ['sleep.interval.end_time', 'utc'],
  exercise: ['exercise.interval.civil_start_time', 'civil'],
  'vo2-max': ['vo2_max.sample_time.physical_time', 'utc'],
};
export const SUMMARY_TYPE_NAMES = Object.keys(SUMMARY_TYPES);
const ALL_SOURCES_ONLY = new Set(['sleep']); // filtered to Fitbit sessions in ingest
const REFRESH_RECENT_DAYS = 2;
const WORKERS = 16; // each request waits ~2 s on Google; HTTP/2 runs them side by side

const pad = n => String(n).padStart(2, '0');
const localIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function bound(iso, kind) {
  if (kind === 'date') return iso;
  if (kind === 'civil') return `${iso}T00:00:00`;
  return `${iso}T00:00:00Z`;
}

class Api {
  constructor(getToken) {
    this.getToken = getToken;
    this.token = null;
  }

  async request(path, { method = 'GET', body } = {}) {
    for (let attempt = 0; ; attempt++) {
      this.token ||= await this.getToken({ refresh: false });
      const res = await fetch(`${API}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();
      if (res.status === 401 && attempt === 0) {
        this.token = await this.getToken({ refresh: true, stale: this.token });
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const err = new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
  }

  async list(type, filter, { sources = true, pageSize = 10000 } = {}) {
    const points = [];
    let page = null;
    do {
      const q = new URLSearchParams({ pageSize: String(pageSize) });
      if (filter) q.set('filter', filter);
      if (sources && !ALL_SOURCES_ONLY.has(type)) q.set('dataSourceFamily', SOURCE_FAMILY);
      if (page) q.set('pageToken', page);
      const body = await this.request(`dataTypes/${type}/dataPoints?${q}`);
      points.push(...(body.dataPoints || []));
      page = body.nextPageToken;
    } while (page);
    return points;
  }

  async rollup(type, fromMs, toMs, windowSize) {
    const body = await this.request(`dataTypes/${type}/dataPoints:rollUp`, {
      method: 'POST',
      body: {
        range: { startTime: rfc(fromMs), endTime: rfc(toMs) },
        windowSize, pageSize: 10000, dataSourceFamily: SOURCE_FAMILY,
      },
    });
    return body.rollupDataPoints || [];
  }
}

// Sign-in problems stop the whole sync; anything else skips just that request.
const isAuthError = err => err.status === 401 || err.status === 403 || ['NEEDS_REDIRECT', 'NEEDS_CONSENT'].includes(err.code);

async function pool(items, n, fn) {
  let next = 0;
  let failed = false;
  const run = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try { await fn(items[i], i); } catch (err) { failed = true; throw err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function pointKey(p) {
  if (p.name) return p.name;
  const body = Object.entries(p).find(([k]) => k !== 'dataSource')?.[1] || {};
  return JSON.stringify([p.dataSource, body.date]);
}

// ---------- Profile ----------
async function latest(api, type, field, valueKey) {
  const points = await api.list(type, null, { sources: false, pageSize: 1000 });
  if (!points.length) return null;
  const p = points.reduce((a, b) => (b[field].sampleTime.physicalTime > a[field].sampleTime.physicalTime ? b : a));
  return Number(p[field][valueKey]);
}

async function syncProfile(api) {
  const found = {};
  try { found.age = (await api.request('profile')).age; } catch { /* best effort */ }
  try {
    const s = await api.request('settings');
    found.timezone = s.timeZone;
    found.temperature_unit = s.temperatureUnit;
  } catch { /* best effort */ }
  for (const [key, type, valueKey, scale] of [['weight_kg', 'weight', 'weightGrams', 1000], ['height_cm', 'height', 'heightMillimeters', 10]]) {
    try {
      const v = await latest(api, type, type, valueKey);
      if (v) found[key] = pyRound(v / scale, 1);
    } catch { /* best effort */ }
  }
  const current = (await store.get('profile')) || {};
  for (const [k, v] of Object.entries(found)) if (v != null) current[k] = v;
  await store.set('profile', current);
  return current;
}

/** Profile fields the dashboard uses (profile_store.dashboard_profile). */
export function dashboardProfile(p) {
  const age = p.age ?? null;
  const h = p.height_cm;
  const w = p.weight_kg;
  return {
    name: p.name || '',
    chronological_age: age,
    sex: p.sex ?? null,
    height_cm: h ?? null,
    weight_kg: w ?? null,
    bmi: h && w ? pyRound(w / (h / 100) ** 2, 2) : null,
    max_hr: age ? pyRound(208 - 0.7 * age, 0) : 190,
    zone_max_hr: age ? 220 - age : 190,
    timezone: p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    temperature_unit: p.temperature_unit || 'CELSIUS',
  };
}

// ---------- High-frequency days ----------
// Each request to the Health API takes ~2 s however small it is, and a full
// day of heart rate is ~5 pages fetched one after another. So recent days are
// fetched incrementally: only what arrived after the last stored reading.
const rfc = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

async function syncHeartRateDay(api, day) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const end = start + 86400000;
  const prev = await store.get(`hr:${day}`);
  const lastSec = prev && prev.t.length ? prev.t[prev.t.length - 1] : null;
  const from = lastSec === null ? start : start + (lastSec + 1) * 1000;
  const points = await api.list('heart-rate',
    `heart_rate.sample_time.physical_time >= "${rfc(from)}" AND heart_rate.sample_time.physical_time < "${rfc(end)}"`);
  if (prev && !points.length) return 0;
  const fresh = points
    .map(p => [Math.round((Date.parse(p.heartRate.sampleTime.physicalTime) - start) / 1000), Math.min(255, Number(p.heartRate.beatsPerMinute))])
    .filter(([sec]) => lastSec === null || sec > lastSec)
    .sort((a, b) => a[0] - b[0]);
  const n0 = prev ? prev.t.length : 0;
  const t = new Int32Array(n0 + fresh.length);
  const bpm = new Uint8Array(n0 + fresh.length);
  if (prev) { t.set(prev.t); bpm.set(prev.bpm); }
  fresh.forEach(([sec, v], i) => { t[n0 + i] = sec; bpm[n0 + i] = v; });
  await store.set(`hr:${day}`, { t, bpm });
  await store.set(`hrmin:${day}`, minuteAggregateSeconds(t, bpm));
  return fresh.length;
}

// Steps and calories: keep stored rows before the last one, refetch from there
// (the last minute may still have been filling in).
async function mergeRows(key, from, fetchRows) {
  const prev = (await store.get(key)) || [];
  const keep = prev.filter(r => Date.parse(r[0]) < from);
  const fresh = (await fetchRows()).filter(r => Date.parse(r[0]) >= from);
  const merged = [...keep, ...fresh].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  await store.set(key, merged);
  // The re-fetched last row isn't news; count only rows past it.
  return Math.max(0, merged.length - prev.length);
}

// The API returns rows newest-first, so resume from the latest start, not the last row.
function resumeFrom(rows, start) {
  return rows && rows.length ? Math.max(...rows.map(r => Date.parse(r[0]))) : start;
}

async function syncStepsDay(api, day) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const key = `rows:steps:${day}`;
  const from = resumeFrom(await store.get(key), start);
  return mergeRows(key, from, async () => (await api.list('steps',
    `steps.interval.start_time >= "${rfc(from)}" AND steps.interval.start_time < "${rfc(start + 86400000)}"`))
    .map(p => [p.steps.interval.startTime, p.steps.interval.endTime, Number(p.steps.count)]));
}

async function syncCaloriesDay(api, day) {
  // total-calories has only rollups; 60 s is the device's own resolution.
  const start = Date.parse(`${day}T00:00:00Z`);
  const key = `rows:total-calories:${day}`;
  const from = resumeFrom(await store.get(key), start);
  return mergeRows(key, from, async () => (await api.rollup('total-calories', from, start + 86400000, '60s'))
    .map(p => [p.startTime, p.endTime, Number(p.totalCalories.kcalSum)]));
}

const DAILY = [
  ['heart-rate', 'hrmin:', syncHeartRateDay],
  ['steps', 'rows:steps:', syncStepsDay],
  ['total-calories', 'rows:total-calories:', syncCaloriesDay],
];

const PROFILE_EVERY_MS = 24 * 3600 * 1000;
// Daily summaries (sleep, HRV, resting HR...) change about once a day, and
// yesterday's readings rarely change. Recheck those at most this often; a
// refresh in between only fetches what's new today.
const SLOW_EVERY_MS = 15 * 60 * 1000;

/**
 * One sync, in two phases:
 *  - 'recent': daily summaries for the last `days` days, plus anything new for
 *    the last few days of heart rate, steps and calories. Everything runs in
 *    parallel; this is what the person waits for.
 *  - 'history': the profile (at most daily) and older high-frequency days that
 *    are missing within `historyDays` (heart rate capped by backfillLimit per
 *    sync, newest first). Runs after the dashboard has updated.
 * Returns {errors, fetched, pending}.
 */
export async function sync({ getToken, phase = 'recent', days = 7, historyDays = days, backfillLimit = {}, onProgress = () => {} }) {
  const api = new Api(getToken);
  const today = localIso(new Date());
  const end = addDays(today, 1);
  // Heart rate, steps and calories are stored per UTC day. Recheck today,
  // yesterday (late uploads) and every day since the last sync.
  const utcToday = new Date().toISOString().slice(0, 10);
  const utcEnd = addDays(utcToday, 1);
  const lastSync = await store.get('lastSync');
  const sinceLast = lastSync ? new Date(lastSync).toISOString().slice(0, 10) : addDays(utcToday, -REFRESH_RECENT_DAYS);
  const fresh = [addDays(utcToday, -1), sinceLast].sort()[0];
  const report = { errors: [], fetched: 0, pending: 0 };
  const tasks = [];
  const guard = fn => async () => {
    try {
      // Await first: `report.fetched += await fn()` would read the total before
      // the wait and lose counts from tasks finishing in parallel.
      const n = (await fn()) || 0;
      report.fetched += n;
    } catch (err) {
      if (isAuthError(err)) throw err;
      report.errors.push(String(err.message || err));
    }
  };

  const profileAt = (await store.get('profileSyncedAt')) || 0;
  if (phase === 'history' ? Date.now() - profileAt > PROFILE_EVERY_MS : !profileAt) {
    tasks.push(guard(async () => { await syncProfile(api); await store.set('profileSyncedAt', Date.now()); return 0; }));
  }

  const slowDue = Date.now() - ((await store.get('slowSyncAt')) || 0) > SLOW_EVERY_MS;
  if (phase === 'recent' && slowDue) {
    const start = addDays(end, -(days + 1));
    for (const [type, [field, kind]] of Object.entries(SUMMARY_TYPES)) {
      tasks.push(guard(async () => {
        const filter = type === 'sleep'
          ? `${field} >= "${bound(start, kind)}"` // sleep only supports >= on end_time
          : `${field} >= "${bound(start, kind)}" AND ${field} < "${bound(end, kind)}"`;
        const points = await api.list(type, filter);
        const merged = (await store.get(`points:${type}`)) || {};
        let changed = 0;
        if (type === 'exercise') {
          // The source filter leaves out workouts logged from apps, DataStrap's
          // own included: fetch those separately, and drop ones deleted since.
          const own = (await api.list(type, filter, { sources: false })).filter(isDatastrap);
          const keep = new Set(own.map(pointKey));
          const lo = bound(start, kind), hi = bound(end, kind);
          for (const [k, p] of Object.entries(merged)) {
            const civil = civilStart(p);
            if (isDatastrap(p) && civil && civil >= lo && civil < hi && !keep.has(k)) { delete merged[k]; changed++; }
          }
          points.push(...own);
        }
        for (const p of points) {
          const k = pointKey(p);
          if (JSON.stringify(merged[k]) !== JSON.stringify(p)) changed++;
          merged[k] = p;
        }
        if (changed) await store.set(`points:${type}`, merged);
        return changed;
      }));
    }
  }
  if (phase === 'recent') {
    const from = slowDue ? fresh : utcToday;
    for (const [, , fn] of DAILY) {
      for (let d = from; d < utcEnd; d = addDays(d, 1)) { const day = d; tasks.push(guard(() => fn(api, day))); }
    }
  } else {
    for (const [type, prefix, fn] of DAILY) {
      const have = new Set((await store.keysWithPrefix(prefix)).map(k => k.slice(prefix.length)));
      const missing = [];
      for (let d = addDays(utcEnd, -(historyDays + 1)); d < fresh; d = addDays(d, 1)) if (!have.has(d)) missing.push(d);
      missing.reverse(); // newest first
      const cap = backfillLimit[type] ?? Infinity;
      if (missing.length > cap) report.pending += missing.length - cap;
      for (const day of missing.slice(0, cap)) tasks.push(guard(() => fn(api, day)));
    }
  }

  let done = 0;
  await pool(tasks, WORKERS, async task => { await task(); onProgress(++done, tasks.length); });
  if (phase === 'recent') {
    await store.set('lastSync', Date.now());
    if (slowDue && !report.errors.length) await store.set('slowSyncAt', Date.now());
  }
  return report;
}

// A workout's local start, 'YYYY-MM-DDTHH:MM:SS' (what the API filters on).
function civilStart(p) {
  const iv = p.exercise?.interval;
  if (!iv?.startTime) return null;
  const off = parseInt(String(iv.startUtcOffset || '0s'), 10) || 0;
  return new Date(Date.parse(iv.startTime) + off * 1000).toISOString().slice(0, 19);
}

// ---------- Logging workouts (Log +) ----------
/**
 * Writes a workout to Google Health (it appears in the Fitbit app too) and
 * stores Google's copy, so it shows here straight away.
 * `start` is the local start time as a Date; `utcOffsetS` the offset there.
 */
export async function logWorkout(getToken, { type, label, start, minutes, utcOffsetS, calories, distanceKm }) {
  const api = new Api(getToken);
  const end = new Date(start.getTime() + minutes * 60000);
  const metrics = {};
  if (calories > 0) metrics.caloriesKcal = calories;
  if (distanceKm > 0) metrics.distanceMillimeters = Math.round(distanceKm * 1e6);
  const res = await api.request('dataTypes/exercise/dataPoints', {
    method: 'POST',
    body: {
      dataSource: { recordingMethod: 'MANUAL' },
      exercise: {
        interval: { startTime: rfc(start.getTime()), startUtcOffset: `${utcOffsetS}s`, endTime: rfc(end.getTime()), endUtcOffset: `${utcOffsetS}s` },
        exerciseType: type,
        displayName: label,
        activeDuration: `${minutes * 60}s`,
        ...(Object.keys(metrics).length ? { metricsSummary: metrics } : {}),
      },
    },
  });
  const point = res.response || res;
  if (point?.name) {
    const merged = (await store.get('points:exercise')) || {};
    merged[point.name] = point;
    await store.set('points:exercise', merged);
  }
  return point;
}

/** Deletes a workout this app logged, from Google and from the phone. */
export async function deleteWorkout(getToken, name) {
  const api = new Api(getToken);
  await api.request('dataTypes/exercise/dataPoints:batchDelete', { method: 'POST', body: { names: [name] } });
  const merged = (await store.get('points:exercise')) || {};
  delete merged[name];
  await store.set('points:exercise', merged);
}

/** Everything stored, in the shape ingest.loadApiSources reads. */
export async function loadRaw() {
  const raw = { points: {}, rows: { steps: {}, 'total-calories': {} }, hrMinutes: {} };
  for (const type of SUMMARY_TYPE_NAMES) raw.points[type] = Object.values((await store.get(`points:${type}`)) || {});
  for (const [key, rows] of Object.entries(await store.getPrefix('rows:'))) {
    const [, type, day] = key.split(':');
    raw.rows[type][day] = rows;
  }
  for (const [key, agg] of Object.entries(await store.getPrefix('hrmin:'))) raw.hrMinutes[key.slice(6)] = agg;
  return raw;
}
