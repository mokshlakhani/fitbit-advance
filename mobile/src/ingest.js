// Google Health API data -> engine sources (JavaScript port of api_ingest.py).
//
// `raw` holds what the phone has stored:
//   raw.points[type]  list of API data points for the summary/session types
//   raw.rows[type]    {utcDay: rows} for the high-frequency types, rows as the
//                     desktop's compact CSVs: heart-rate [time, bpm],
//                     steps [start, end, count], total-calories [start, end, kcal]
// mobile/test/ingest_parity.mjs checks every loader against api_ingest.py.
import { pyRound, workoutWindow, WORKOUT_TAIL_S } from './engine.js';

const pyInt = x => pyRound(x, 0);
const pad = n => String(n).padStart(2, '0');

// ---------- Time zones ----------
// Offsets are cached per 15-minute block: zone transitions never fall inside one.
const offsetCache = new Map();
function zoneOffsetMs(epochMs, tz) {
  const block = Math.floor(epochMs / 900000);
  const key = tz + block;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const fmt = formatterFor(tz);
    const p = Object.fromEntries(fmt.formatToParts(new Date(block * 900000)).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    off = asUtc - block * 900000;
    offsetCache.set(key, off);
  }
  return off;
}

const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

/** A "naive local" time: a Date whose UTC fields read as local wall-clock time. */
function localWall(utcStr, tz, offset) {
  const ms = Date.parse(utcStr);
  if (offset) return new Date(ms + parseInt(offset, 10) * 1000);
  return new Date(ms + zoneOffsetMs(ms, tz));
}

const isoDate = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const isoTime = d => `${isoDate(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.000`;
const hhmm = d => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const dateIso = o => `${String(o.year).padStart(4, '0')}-${pad(o.month)}-${pad(o.day)}`;

function dropFirstPartialDay(byDate) {
  // Rows are stored per UTC day, so the earliest local day can be missing some
  // of its first hours. Drop it rather than show a short day.
  const keys = Object.keys(byDate);
  if (keys.length) delete byDate[keys.sort()[0]];
  return byDate;
}

function allRows(raw, type) {
  const days = raw.rows?.[type] || {};
  return Object.keys(days).sort().flatMap(d => days[d]);
}

// ---------- Daily summaries ----------
export function loadHrv(raw) {
  const out = {};
  for (const p of raw.points?.['daily-heart-rate-variability'] || []) {
    const d = p.dailyHeartRateVariability;
    const rmssd = d.averageHeartRateVariabilityMilliseconds;
    if (rmssd == null) continue;
    const nrem = d.nonRemHeartRateBeatsPerMinute;
    out[dateIso(d.date)] = {
      rmssd: Number(rmssd),
      nremhr: nrem && Number(nrem) > 0 ? Number(nrem) : null,
      entropy: d.entropy ?? null,
    };
  }
  return out;
}

export function loadRestingHr(raw) {
  const out = {};
  for (const p of raw.points?.['daily-resting-heart-rate'] || []) {
    const d = p.dailyRestingHeartRate;
    const v = Number(d.beatsPerMinute ?? 0);
    if (v > 30 && v < 120) out[dateIso(d.date)] = pyInt(v);
  }
  return out;
}

export function loadSpo2(raw) {
  const out = {};
  for (const p of raw.points?.['daily-oxygen-saturation'] || []) {
    const d = p.dailyOxygenSaturation;
    if (d.averagePercentage == null) continue;
    const avg = d.averagePercentage;
    out[dateIso(d.date)] = {
      avg: pyRound(avg, 1),
      lower: pyRound(d.lowerBoundPercentage ?? avg, 1),
      upper: pyRound(d.upperBoundPercentage ?? avg, 1),
    };
  }
  return out;
}

export function loadTemperature(raw) {
  const out = {};
  for (const p of raw.points?.['daily-sleep-temperature-derivations'] || []) {
    const d = p.dailySleepTemperatureDerivations;
    if (d.nightlyTemperatureCelsius != null) out[dateIso(d.date)] = Number(d.nightlyTemperatureCelsius);
  }
  return out;
}

export function loadRespiratoryRate(raw) {
  const out = {};
  for (const p of raw.points?.['daily-respiratory-rate'] || []) {
    const d = p.dailyRespiratoryRate;
    if (d.breathsPerMinute != null) out[dateIso(d.date)] = pyRound(Number(d.breathsPerMinute), 1);
  }
  return out;
}

export function loadVo2(raw, tz) {
  // The API has returned no VO2max so far; read it if it ever appears.
  const out = {};
  for (const p of raw.points?.['vo2-max'] || []) {
    const v = p.vo2Max;
    const t = v?.sampleTime?.physicalTime;
    const val = v?.vo2Max ?? v?.millilitersPerMinuteKilogram;
    if (t && val != null) out[isoDate(localWall(t, tz))] = pyRound(Number(val), 1);
  }
  return out;
}

// ---------- Sessions ----------
const STAGE_NAMES = { AWAKE: 'wake', LIGHT: 'light', DEEP: 'deep', REM: 'rem', ASLEEP: 'asleep', RESTLESS: 'restless' };

export function loadSleep(raw, tz) {
  const out = {};
  const rank = {};
  for (const p of raw.points?.sleep || []) {
    const s = p.sleep;
    if (p.dataSource?.platform !== 'FITBIT') continue;
    const flagged = Boolean(s.metadata?.mainSleep);
    const iv = s.interval;
    const start = localWall(iv.startTime, tz, iv.startUtcOffset);
    const end = localWall(iv.endTime, tz, iv.endUtcOffset);
    const dt = isoDate(end);

    const summary = s.summary || {};
    const stageMin = {};
    for (const x of summary.stagesSummary || []) stageMin[x.type] = parseInt(x.minutes ?? 0, 10);
    const asleep = parseInt(summary.minutesAsleep ?? 0, 10);
    const inBed = parseInt(summary.minutesInSleepPeriod ?? 0, 10) || Math.floor((end - start) / 60000);

    const hypno = (s.stages || []).map(st => {
      const a = localWall(st.startTime, tz, st.startUtcOffset);
      const b = localWall(st.endTime, tz, st.endUtcOffset);
      return { time: isoTime(a), stage: STAGE_NAMES[st.type] || st.type.toLowerCase(), seconds: Math.trunc((b - a) / 1000) };
    });

    const r = rank[dt];
    if (r && (r[0] > flagged || (r[0] === flagged && r[1] >= asleep))) continue;
    rank[dt] = [flagged, asleep];
    const awake = parseInt(summary.minutesAwake ?? 0, 10);
    out[dt] = {
      stage_source: 'api',
      minutesAsleep: asleep,
      minutesAwake: awake,
      timeInBed: inBed,
      efficiency: inBed ? pyInt(asleep / inBed * 100) : null,
      startTime: isoTime(start),
      endTime: isoTime(end),
      deep_min: stageMin.DEEP ?? 0,
      rem_min: stageMin.REM ?? 0,
      light_min: stageMin.LIGHT ?? 0,
      wake_min: stageMin.AWAKE ?? awake,
      hypnogram: hypno,
    };
  }
  return out;
}

const titleCase = s => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase());

// Workouts logged from DataStrap (see is_datastrap in google_health_sync.py).
export const DATASTRAP_PROJECT = '724732375940-';
export const DATASTRAP_PACKAGE = 'app.datastrap.personal';
export function isDatastrap(p) {
  const app = p?.dataSource?.application || {};
  return Object.values(app).some(v => typeof v === 'string' && (v.startsWith(DATASTRAP_PROJECT) || v === DATASTRAP_PACKAGE));
}

function fitbitZones(z) {
  if (!z) return null;
  return Object.fromEntries(['light', 'moderate', 'vigorous', 'peak'].map(k => [k, pyRound(Number(String(z[`${k}Time`] ?? '0s').replace(/s$/, '') || 0) / 60.0, 1)]));
}

export function loadWorkouts(raw, tz) {
  const out = {};
  for (const p of raw.points?.exercise || []) {
    const ex = p.exercise;
    const iv = ex.interval;
    const start = localWall(iv.startTime, tz, iv.startUtcOffset);
    const m = ex.metricsSummary || {};
    let durS = parseFloat(String(ex.activeDuration ?? '0s').replace(/s$/, '') || 0);
    if (!durS) durS = Math.trunc((Date.parse(iv.endTime) - Date.parse(iv.startTime)) / 1000);
    (out[isoDate(start)] ||= []).push({
      name: ex.displayName || titleCase((ex.exerciseType || 'Workout').replace(/_/g, ' ')),
      duration_minutes: pyInt(durS / 60),
      calories: pyInt(Number(m.caloriesKcal ?? 0)),
      avg_hr: Math.trunc(Number(m.averageHeartRateBeatsPerMinute ?? 0)),
      time: hhmm(start),
      steps: m.steps ? Math.trunc(Number(m.steps)) : null,
      distance_km: m.distanceMillimeters ? pyRound(Number(m.distanceMillimeters) / 1e6, 2) : null,
      elevation_m: m.elevationGainMillimeters ? pyInt(Number(m.elevationGainMillimeters) / 1000) : null,
      active_zone_minutes: m.activeZoneMinutes ? Math.trunc(Number(m.activeZoneMinutes)) : null,
      fitbit_zones: fitbitZones(m.heartRateZoneDurations),
      id: p.name ?? null,
      logged_in_app: isDatastrap(p),
    });
  }
  return out;
}

// ---------- High-frequency types ----------
export function loadStepsAndCalories(raw, tz) {
  const result = [{}, {}, {}, {}];
  for (const [kind, idx] of [['steps', 0], ['total-calories', 1]]) {
    const rows = allRows(raw, kind);
    if (!rows.length) continue;
    const valIdx = 2;
    const daily = {};
    const hourly = {};
    for (const row of rows) {
      const local = localWall(row[0], tz);
      const d = isoDate(local);
      const v = Number(row[valIdx]);
      daily[d] = (daily[d] || 0) + v;
      (hourly[d] ||= Array(24).fill(0))[local.getUTCHours()] += v;
    }
    const cast = kind === 'steps' ? Math.trunc : pyInt;
    const totals = {};
    for (const d of Object.keys(daily).sort()) totals[d] = cast(daily[d]);
    dropFirstPartialDay(totals);
    const hours = {};
    for (const d of Object.keys(hourly).sort()) if (d in totals) hours[d] = hourly[d].map(cast);
    result[idx] = totals;
    result[idx + 2] = hours;
  }
  return result; // [steps, calories, hourlySteps, hourlyCalories]
}

/**
 * Heart-rate samples of one UTC day -> per-minute [sums, counts]. Every time
 * zone offset is a whole number of minutes, so UTC minutes map one-to-one onto
 * local minutes and these sums give exactly the per-minute means the desktop
 * computes from the full samples, at a fraction of the memory.
 */
export function minuteAggregate(rows, utcDay) {
  const start = Date.parse(`${utcDay}T00:00:00Z`);
  const sums = new Float64Array(1440);
  const counts = new Uint16Array(1440);
  for (const [time, bpm] of rows) {
    const i = Math.floor((Date.parse(time) - start) / 60000);
    if (i < 0 || i >= 1440) continue;
    sums[i] += Number(bpm);
    counts[i] += 1;
  }
  return { sums, counts };
}

/** Same as minuteAggregate, from stored seconds-into-the-day and bpm arrays. */
export function minuteAggregateSeconds(t, bpm) {
  const sums = new Float64Array(1440);
  const counts = new Uint16Array(1440);
  for (let k = 0; k < t.length; k++) {
    const i = Math.floor(t[k] / 60);
    if (i < 0 || i >= 1440) continue;
    sums[i] += bpm[k];
    counts[i] += 1;
  }
  return { sums, counts };
}

export function loadIntradayHr(raw, tz) {
  let minutes = raw.hrMinutes;
  if (!minutes) {
    minutes = {};
    for (const [d, rows] of Object.entries(raw.rows?.['heart-rate'] || {})) minutes[d] = minuteAggregate(rows, d);
  }
  const out = {};
  for (const utcDay of Object.keys(minutes).sort()) {
    const { sums, counts } = minutes[utcDay];
    const start = Date.parse(`${utcDay}T00:00:00Z`);
    for (let i = 0; i < 1440; i++) {
      if (!counts[i]) continue;
      const ms = start + i * 60000;
      const local = new Date(ms + zoneOffsetMs(ms, tz));
      (out[isoDate(local)] ||= []).push({ time: hhmm(local), bpm: pyInt(sums[i] / counts[i]) });
    }
  }
  for (const d of Object.keys(out)) out[d].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const sorted = {};
  for (const d of Object.keys(out).sort()) sorted[d] = out[d];
  return dropFirstPartialDay(sorted);
}

// ---------- Raw heart rate around workouts ----------
export function workoutWindows(workoutsByDate) {
  const out = {};
  for (const [dt, ws] of Object.entries(workoutsByDate || {})) {
    for (const w of ws) {
      const win = workoutWindow(w);
      if (win) (out[dt] ||= []).push([win[0], win[1] + WORKOUT_TAIL_S]);
    }
  }
  return out;
}

/**
 * Raw API readings that fall in a workout window: {localDate: [[seconds, bpm], ...]}.
 * `hrDays` maps UTC day -> {t: seconds into that UTC day, bpm} (what the phone stores).
 */
export function loadWorkoutSamples(hrDays, tz, workoutsByDate) {
  const windows = workoutWindows(workoutsByDate);
  const out = {};
  for (const utcDay of Object.keys(hrDays || {}).sort()) {
    const { t, bpm } = hrDays[utcDay];
    const dayStart = Date.parse(`${utcDay}T00:00:00Z`);
    for (let i = 0; i < t.length; i++) {
      const ms = dayStart + t[i] * 1000;
      const local = new Date(ms + zoneOffsetMs(ms, tz));
      const dt = isoDate(local);
      const wins = windows[dt];
      if (!wins) continue;
      const sec = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
      if (wins.some(([lo, hi]) => lo <= sec && sec < hi)) (out[dt] ||= []).push([sec, bpm[i]]);
    }
  }
  for (const v of Object.values(out)) v.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return out;
}

/** One local day of raw readings from the stored UTC days: {t: seconds since local midnight, b: bpm}. */
export function localDayReadings(hrDays, tz, date) {
  const pairs = [];
  for (const utcDay of Object.keys(hrDays).sort()) {
    const { t, bpm } = hrDays[utcDay];
    const dayStart = Date.parse(`${utcDay}T00:00:00Z`);
    for (let i = 0; i < t.length; i++) {
      const ms = dayStart + t[i] * 1000;
      const local = new Date(ms + zoneOffsetMs(ms, tz));
      if (isoDate(local) !== date) continue;
      pairs.push([local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds(), bpm[i]]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return { t: pairs.map(p => p[0]), b: pairs.map(p => p[1]) };
}

/** UTC days whose readings can fall in these workouts' windows. */
export function workoutUtcDays(workoutsByDate) {
  const days = new Set();
  for (const dt of Object.keys(workoutWindows(workoutsByDate))) {
    for (const k of [-1, 0, 1]) {
      const d = new Date(`${dt}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + k);
      days.add(d.toISOString().slice(0, 10));
    }
  }
  return [...days];
}

/** All API-derived sources, in the shape process_fitbit_openstrap.build_dataset merges. */
export function loadApiSources(raw, tz) {
  const [steps, cal, hourlySteps, hourlyCals] = loadStepsAndCalories(raw, tz);
  return {
    hrv: loadHrv(raw), temp: loadTemperature(raw), spo2: loadSpo2(raw), rhr: loadRestingHr(raw),
    intraday_hr: loadIntradayHr(raw, tz), workouts: loadWorkouts(raw, tz),
    steps, cal, hourly_steps: hourlySteps, hourly_cals: hourlyCals,
    resp: loadRespiratoryRate(raw), vo2: loadVo2(raw, tz), sleep: loadSleep(raw, tz),
  };
}

/** Seed history (e.g. a Takeout export processed on the computer) + API data, API winning per day. */
export function mergeSources(seed, api) {
  const names = ['workout_hr', 'hrv', 'sleep', 'temp', 'spo2', 'vo2', 'steps', 'cal', 'hourly_steps', 'hourly_cals', 'resp', 'rhr', 'intraday_hr', 'workouts'];
  const src = {};
  for (const n of names) src[n] = { ...(seed?.[n] || {}) };
  for (const n of names) {
    if (n === 'sleep') continue;
    Object.assign(src[n], api[n] || {});
  }
  for (const [dt, entry] of Object.entries(api.sleep || {})) {
    const cur = { ...(src.sleep[dt] || {}) };
    // Don't let a shorter API session (a nap, when the API is missing the
    // night's main sleep) replace the export's main sleep.
    if (cur.stage_source === 'takeout-v2' && (cur.minutesAsleep ?? 0) > entry.minutesAsleep) continue;
    src.sleep[dt] = Object.assign(cur, entry);
  }
  return src;
}
