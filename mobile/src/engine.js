// DataStrap analytics engine (JavaScript port of process_fitbit_openstrap.assemble
// and sleep_score.py), so the Android app can compute everything on the phone.
//
// It must produce exactly what the Python pipeline produces from the same
// inputs; mobile/test/parity.mjs checks that against real data. Python's
// round() rounds exact halves to even, so pyRound() reproduces that.

// Recovery baselines (see process_fitbit_openstrap.py): a vital's most recent
// BASELINE_READINGS values from the previous BASELINE_MAX_AGE days.
export const BASELINE_READINGS = 14;
export const BASELINE_MAX_AGE = 28;
const MIN_INPUTS = 2;
const MIN_WEIGHT = 0.5;

// ---------- Python-compatible numerics ----------
export function pyRound(x, n = 0) {
  if (x == null || !Number.isFinite(x)) return x;
  const fixed = x.toFixed(n);
  // toFixed picks the larger candidate on an exact tie; Python picks the even one.
  const probe = Math.abs(x).toFixed(Math.min(100, n + 25));
  const tail = probe.slice(probe.indexOf('.') + 1 + n);
  if (/^50*$/.test(tail)) {
    const scaled = Number(fixed) * 10 ** n;
    const lastDigit = Math.abs(Math.round(scaled)) % 2;
    if (lastDigit === 1) {
      const down = (Math.abs(Math.round(scaled)) - 1) / 10 ** n;
      return Number((Math.sign(x) * down).toFixed(n));
    }
  }
  return Number(fixed);
}

const pyInt = x => pyRound(x, 0);

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function std(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

function meanOf(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

const truthy = v => v !== null && v !== undefined && v !== 0 && !Number.isNaN(v);

// ---------- Analytics ----------
export function robustZ(val, baseline) {
  if (val == null || baseline.length < 2) return 0.0;
  const arr = baseline.filter(x => x != null && !Number.isNaN(x));
  if (arr.length < 2) return 0.0;
  const med = median(arr);
  const mad = median(arr.map(x => Math.abs(x - med)));
  if (mad > 1e-4) return (val - med) / (1.4826 * mad);
  const sd = std(arr);
  if (sd > 1e-4) return (val - med) / sd;
  return 0.0;
}

// Banister TRIMP weighting y = a·exp(b·HRR): coefficients for men and women,
// their midpoint when sex isn't known.
const TRIMP_COEF = { male: [0.64, 1.92], female: [0.86, 1.67], null: [0.75, 1.795] };
// Only minutes at or above light activity (30% of heart-rate reserve, ACSM) count towards strain.
const ACTIVE_HRR = 0.30;
// Fitbit's Active Zone Minutes cut-offs (share of heart-rate reserve).
const ZONES = [['peak', 0.85], ['vigorous', 0.60], ['moderate', 0.40], ['light', 0.0]];
export const hrZone = hrr => ZONES.find(([, lo]) => hrr >= lo)[0];

export function trimpAndStrain(minuteHr, restingHr, maxHr = 190, sex = null, zoneMaxHr = null) {
  const [a, b] = TRIMP_COEF[sex] || TRIMP_COEF.null;
  if (!minuteHr.length || restingHr == null || restingHr >= maxHr) {
    return [0.0, 0.0, { light: 100, moderate: 0, vigorous: 0, peak: 0 }];
  }
  const reserve = maxHr - restingHr;
  const zoneReserve = Math.max((zoneMaxHr || maxHr) - restingHr, 1);
  let trimp = 0.0;
  const zones = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  for (const pt of minuteHr) {
    const hr = pt.bpm;
    if (hr <= restingHr) { zones.light += 1; continue; }
    const hrr = Math.min(1.0, Math.max(0.0, (hr - restingHr) / reserve));
    zones[hrZone(Math.min(1.0, (hr - restingHr) / zoneReserve))] += 1;
    if (hrr < ACTIVE_HRR) continue;
    trimp += 1.0 * hrr * (a * Math.exp(b * hrr));
  }
  let strain = 21.0 * Math.log(1.0 + trimp) / Math.log(7201.0);
  strain = Math.min(21.0, Math.max(0.0, pyRound(strain, 1)));
  const total = Math.max(1, zones.light + zones.moderate + zones.vigorous + zones.peak);
  const pct = {};
  for (const k of ['light', 'moderate', 'vigorous', 'peak']) pct[k] = pyRound(zones[k] / total * 100, 1);
  return [pyRound(trimp, 1), strain, pct];
}

// See asleep_minutes in process_fitbit_openstrap.py. Times are local wall
// clock, so they're handled as UTC to keep the arithmetic free of DST.
export function asleepMinutes(dt, sleepOf) {
  const next = new Date(Date.parse(`${dt}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const out = new Set();
  for (const entry of [sleepOf(dt), sleepOf(next)]) {
    if (!entry || !entry.startTime || !entry.timeInBed) continue;
    const start = Date.parse(`${entry.startTime.slice(0, 16)}:00Z`);
    for (let m = 0; m < Math.trunc(entry.timeInBed); m++) {
      const iso = new Date(start + m * 60000).toISOString();
      if (iso.slice(0, 10) === dt) out.add(iso.slice(11, 16));
    }
  }
  return out;
}

// See awake_zone_minutes in process_fitbit_openstrap.py.
export function awakeZoneMinutes(minuteHr, restingHr, maxHr = 190, zoneMaxHr = null, asleep = new Set()) {
  if (!minuteHr.length) return null;
  const zones = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  const zoneReserve = restingHr != null ? Math.max((zoneMaxHr || maxHr) - restingHr, 1) : null;
  for (const pt of minuteHr) {
    if (asleep.has(pt.time)) continue;
    const hr = pt.bpm;
    if (zoneReserve === null || hr <= restingHr) zones.light += 1;
    else zones[hrZone(Math.min(1.0, (hr - restingHr) / zoneReserve))] += 1;
  }
  return zones;
}

// ---------- Workouts (see analyse_workout in process_fitbit_openstrap.py) ----------
export const WORKOUT_TAIL_S = 150;
const MAX_SAMPLE_GAP_S = 10;

export function workoutWindow(w) {
  const parts = String(w.time || '').split(':');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const start = Number(parts[0]) * 3600 + Number(parts[1]) * 60;
  return [start, Math.min(86400, start + Math.max(1, Math.trunc(w.duration_minutes || 0)) * 60)];
}

function meanBpm(samples, lo, hi) {
  let sum = 0;
  let n = 0;
  for (const [t, b] of samples) if (lo <= t && t < hi) { sum += b; n++; }
  return n ? sum / n : null;
}

export function analyseWorkout(w, minuteHr, samples, restingHr, maxHr = 190, sex = null, zoneMaxHr = null) {
  const out = { ...w, hr_resolution: null, hr_t: [], hr_bpm: [], peak_hr: null, avg_hr_measured: null, zone_minutes: null, trimp: null, strain: null, hr_recovery: null, hr_recovery_60: null };
  const win = workoutWindow(w);
  if (!win) return out;
  const [start, end] = win;
  const [a, b] = TRIMP_COEF[sex] || TRIMP_COEF.null;
  const raw = (samples || []).filter(([t]) => start <= t && t < end);
  let times;
  let bpms;
  let durs;
  if (raw.length >= 10) {
    times = raw.map(([t]) => t);
    bpms = raw.map(([, x]) => x);
    durs = [];
    for (let i = 0; i < times.length - 1; i++) durs.push(Math.min(times[i + 1] - times[i], MAX_SAMPLE_GAP_S));
    durs.push(Math.min(end - times[times.length - 1], MAX_SAMPLE_GAP_S));
    out.hr_resolution = 'second';
    out.hr_t = times.map(t => t - start);
    out.hr_bpm = bpms;
    const endBpm = meanBpm(samples, end - 10, end);
    for (const [key, lag] of [['hr_recovery_60', 60], ['hr_recovery', 120]]) {
      const later = meanBpm(samples, end + lag - 5, end + lag + 5);
      if (endBpm !== null && later !== null) out[key] = pyInt(endBpm - later);
    }
  } else {
    const byMin = new Map();
    for (const pt of minuteHr) {
      const [hh, mm] = pt.time.split(':');
      byMin.set(Number(hh) * 3600 + Number(mm) * 60, pt.bpm);
    }
    const series = [];
    for (let t = start - (start % 60); t < end; t += 60) if (byMin.has(t) && t >= start) series.push([t, byMin.get(t)]);
    if (!series.length) return out;
    times = series.map(([t]) => t);
    bpms = series.map(([, x]) => x);
    durs = bpms.map(() => 60);
    out.hr_resolution = 'minute';
    out.hr_t = times.map(t => t - start);
    out.hr_bpm = bpms;
    const after = byMin.get(end + 60);
    const last = byMin.get(end - 60);
    if (after !== undefined && last !== undefined) out.hr_recovery = last - after;
  }
  const total = durs.reduce((x, y) => x + y, 0);
  out.peak_hr = Math.max(...bpms);
  out.avg_hr_measured = total
    ? pyInt(bpms.reduce((acc, x, i) => acc + x * durs[i], 0) / total)
    : pyInt(bpms.reduce((x, y) => x + y, 0) / bpms.length);
  if (restingHr == null || restingHr >= maxHr || !total) return out;
  const reserve = maxHr - restingHr;
  const zoneReserve = Math.max((zoneMaxHr || maxHr) - restingHr, 1);
  const zoneS = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  let trimp = 0.0;
  bpms.forEach((x, i) => {
    const d = durs[i];
    const hrr = Math.min(1.0, Math.max(0.0, (x - restingHr) / reserve));
    zoneS[hrZone(Math.min(1.0, Math.max(0.0, (x - restingHr) / zoneReserve)))] += d;
    if (x > restingHr && hrr >= ACTIVE_HRR) trimp += hrr * (a * Math.exp(b * hrr)) * d / 60.0;
  });
  out.trimp = pyRound(trimp, 1);
  out.strain = Math.min(21.0, Math.max(0.0, pyRound(21.0 * Math.log(1.0 + trimp) / Math.log(7201.0), 1)));
  out.zone_minutes = Object.fromEntries(Object.entries(zoneS).map(([k, v]) => [k, pyRound(v / 60.0, 1)]));
  return out;
}

// ---------- Recovery (OpenStrap readiness composite) ----------
const RECOVERY_INPUTS = [
  ['hrv', 'HRV (RMSSD)', 0.40, 'higher'],
  ['rhr', 'Resting Heart Rate', 0.30, 'lower'],
  ['resp', 'Respiratory Rate', 0.20, 'steady'],
  ['temp', 'Skin Temperature', 0.10, 'steady'],
];
// Breathing rate and skin temperature: a change either way is a warning sign, a
// rise twice as much as a fall, centred so an ordinary night adds nothing on average.
const STEADY_CENTER = 1.5 / Math.sqrt(2 * Math.PI);

function shiftIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function baselineFor(history, dt) {
  const cutoff = shiftIso(dt, -BASELINE_MAX_AGE);
  const vals = history.filter(([d]) => cutoff <= d && d < dt).map(([, v]) => v);
  return vals.length >= BASELINE_READINGS ? vals.slice(-BASELINE_READINGS) : null;
}

function orient(z, how) {
  if (how === 'higher') return z;
  if (how === 'lower') return -z;
  return STEADY_CENTER - Math.max(z, 0.0) - 0.5 * Math.max(-z, 0.0);
}

export function recoveryComposite(values, histories, dt) {
  const used = [];
  for (const [key, label, weight, how] of RECOVERY_INPUTS) {
    const v = values[key];
    if (!truthy(v)) continue;
    const base = baselineFor(histories[key], dt);
    if (base === null) continue;
    if (key === 'rhr' && std(base) < 1.0) continue;
    used.push([label, weight, orient(robustZ(v, base), how)]);
  }
  const weightSum = used.reduce((a, [, w]) => a + w, 0);
  if (used.length < MIN_INPUTS || weightSum < MIN_WEIGHT) return [null, null, [], used.length];
  const composite = used.reduce((a, [, w, o]) => a + w * o, 0) / weightSum;
  const score = 100.0 / (1.0 + Math.exp(-composite));
  const drivers = used.map(([label, weight, o]) => {
    const share = weight * o / weightSum;
    const points = Math.abs(composite) > 1e-9 ? (score - 50.0) * share / composite : 25.0 * share;
    return { metric: label, weight, z: pyRound(o, 2), impact: pyRound(points, 1), direction: o > 0 ? 'positive' : 'negative' };
  });
  drivers.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return [pyInt(score), composite, drivers, used.length];
}

export function nightlyStress(rmssd, rhr, histories, dt) {
  if (!truthy(rmssd) || !truthy(rhr)) return null;
  const baseHrv = baselineFor(histories.hrv, dt);
  const baseRhr = baselineFor(histories.rhr, dt);
  if (baseHrv === null || baseRhr === null) return null;
  const s = (robustZ(rhr, baseRhr) - robustZ(rmssd, baseHrv)) / 2.0;
  return pyInt(100.0 / (1.0 + Math.exp(-s)));
}

// ---------- Fitness age (VO2max against population norms) ----------
// Loe et al. 2013, PLOS ONE 8(5): e64319 (HUNT3), Table 2: VO2max mean and SD by age group.
const VO2_NORMS = [
  // age, men mean, men SD, women mean, women SD
  [25, 54.4, 8.4, 43.0, 7.7],
  [35, 49.1, 7.5, 40.0, 6.8],
  [45, 47.2, 7.7, 38.4, 6.9],
  [55, 42.6, 7.4, 34.4, 5.7],
  [65, 39.2, 6.7, 31.1, 5.1],
  [75, 35.3, 6.5, 28.3, 5.2],
];
const VO2_CARRY_DAYS = 30;

function normRow(row, sex) {
  const [, mm, ms, wm, ws] = row;
  if (sex === 'male') return [mm, ms];
  if (sex === 'female') return [wm, ws];
  return [(mm + wm) / 2.0, (ms + ws) / 2.0];
}

export function vo2Norm(age, sex) {
  if (age <= VO2_NORMS[0][0]) return normRow(VO2_NORMS[0], sex);
  for (let i = 0; i + 1 < VO2_NORMS.length; i++) {
    const lo = VO2_NORMS[i];
    const hi = VO2_NORMS[i + 1];
    if (age <= hi[0]) {
      const f = (age - lo[0]) / (hi[0] - lo[0]);
      const [m0, s0] = normRow(lo, sex);
      const [m1, s1] = normRow(hi, sex);
      return [m0 + f * (m1 - m0), s0 + f * (s1 - s0)];
    }
  }
  return normRow(VO2_NORMS[VO2_NORMS.length - 1], sex);
}

// Abramowitz & Stegun 7.1.26, written exactly as in the Python pipeline.
function erf(x) {
  const sign = x < 0 ? -1.0 : 1.0;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

export function fitnessProfile(age, sex, vo2) {
  const out = { fitness_age: null, fitness_age_limit: null, age_delta: null, percentile: null, tier: null };
  if (vo2 == null) return out;
  const means = VO2_NORMS.map(r => normRow(r, sex)[0]);
  const ages = VO2_NORMS.map(r => r[0]);
  let fitAge = null;
  let limit = null;
  if (vo2 >= means[0]) { fitAge = ages[0]; limit = 'lower'; }
  else if (vo2 <= means[means.length - 1]) { fitAge = ages[ages.length - 1]; limit = 'upper'; }
  else {
    for (let i = 0; i + 1 < ages.length; i++) {
      if (means[i] >= vo2 && vo2 >= means[i + 1]) {
        fitAge = ages[i] + (means[i] - vo2) / (means[i] - means[i + 1]) * (ages[i + 1] - ages[i]);
        break;
      }
    }
  }
  out.fitness_age = pyRound(fitAge, 1);
  out.fitness_age_limit = limit;
  if (age != null) {
    if (limit === null) out.age_delta = pyRound(fitAge - age, 1);
    const [mean, sd] = vo2Norm(age, sex);
    const pct = 50.0 * (1.0 + erf((vo2 - mean) / sd / Math.sqrt(2.0)));
    const p = Math.trunc(Math.min(99, Math.max(1, pyInt(pct))));
    out.percentile = p;
    out.tier = p >= 90 ? 'Elite for your age' : p >= 75 ? 'Excellent for your age'
      : p >= 50 ? 'Above average for your age' : p >= 25 ? 'Below average for your age' : 'Low for your age';
  }
  return out;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayName(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DAY_NAMES[dt.getUTCDay()]}, ${MONTH_NAMES[m - 1]} ${String(d).padStart(2, '0')}`;
}

function firstMaxBy(arr, f) {
  let best = arr[0];
  for (const x of arr) if (f(x) > f(best)) best = x;
  return best;
}

/** Per-day analytics from loaded sources. Mirrors process_fitbit_openstrap.assemble. */
export function assemble(src, profile, labels, { today } = {}) {
  const get = (name, dt) => src[name][dt];
  const keys = new Set([...Object.keys(src.hrv), ...Object.keys(src.sleep), ...Object.keys(src.temp),
    ...Object.keys(src.spo2), ...Object.keys(src.vo2), ...Object.keys(src.intraday_hr)]);
  const now = new Date();
  const todayIso = today || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const allDates = [...keys].sort().filter(d => d <= todayIso);
  if (!allDates.length) throw new Error('No data yet.');

  const histories = { hrv: [], rhr: [], resp: [], temp: [] };
  let lastVo2 = null;
  let lastVo2Date = null;
  const records = [];

  for (const dt of allDates) {
    const hrvEntry = get('hrv', dt) || {};
    const rmssd = hrvEntry.rmssd ?? null;
    const sleepEntry = get('sleep', dt) || {};
    const rhr = (truthy(get('rhr', dt)) ? get('rhr', dt) : null) ?? (truthy(sleepEntry.resting_heart_rate) ? sleepEntry.resting_heart_rate : null);
    const temp = get('temp', dt) ?? null;
    const spo2Entry = get('spo2', dt) ?? null;
    if (dt in src.vo2) { lastVo2 = src.vo2[dt]; lastVo2Date = dt; }
    const vo2Age = lastVo2Date ? Math.round((Date.parse(`${dt}T00:00:00Z`) - Date.parse(`${lastVo2Date}T00:00:00Z`)) / 86400000) : null;
    const vo2 = vo2Age !== null && vo2Age <= VO2_CARRY_DAYS ? lastVo2 : null;
    const steps = get('steps', dt) ?? null;
    const cals = get('cal', dt) ?? null;
    const workouts = get('workouts', dt) || [];
    const resp = get('resp', dt) ?? null;

    const [recoveryScore, compositeZ, drivers, inputsUsed] = recoveryComposite({ hrv: rmssd, rhr, resp, temp }, histories, dt);
    let tier;
    if (recoveryScore === null) tier = ['Calibrating', '#6B7280', null, `Recovery starts once at least two vitals have ${BASELINE_READINGS} nights of data in the last ${BASELINE_MAX_AGE} days.`];
    else if (recoveryScore >= 67) tier = ['Optimal', '#10B981', '14.0 – 18.0', 'Body is well-recovered. High cardiovascular tolerance today—great day for strenuous training.'];
    else if (recoveryScore >= 34) tier = ['Adequate', '#F59E0B', '10.0 – 14.0', 'Moderate recovery. Maintain steady volume without excessive overreaching.'];
    else tier = ['Low / Recovery', '#EF4444', '< 10.0', 'Autonomic indicators show elevated fatigue. Prioritize sleep and active recovery.'];

    const minuteHr = get('intraday_hr', dt) || [];
    const [trimp, strain, zones] = trimpAndStrain(minuteHr, rhr, profile.max_hr, profile.sex, profile.zone_max_hr);
    const daySamples = src.workout_hr ? src.workout_hr[dt] : undefined;
    const dayWorkouts = workouts.map(w => analyseWorkout(w, minuteHr, daySamples, rhr, profile.max_hr, profile.sex, profile.zone_max_hr));

    const asleep = truthy(sleepEntry.minutesAsleep) ? sleepEntry.minutesAsleep : null;
    const hasSleep = asleep !== null;
    const inBed = hasSleep && truthy(sleepEntry.timeInBed) ? sleepEntry.timeInBed : null;
    const efficiency = hasSleep ? (truthy(sleepEntry.efficiency) ? sleepEntry.efficiency : (inBed ? pyInt(asleep / inBed * 100) : null)) : null;
    const debt = hasSleep ? Math.max(0, 480 - asleep) : null;
    const fitness = fitnessProfile(profile.chronological_age, profile.sex, vo2);
    const stress = nightlyStress(rmssd, rhr, histories, dt);
    const spark = [];
    for (let i = 0; i < minuteHr.length; i += 10) spark.push(minuteHr[i]);
    const fmtHm = m => `${Math.floor(m / 60)}h ${m % 60}m`;

    records.push({
      date: dt,
      day_name: dayName(dt),
      recovery: {
        score: recoveryScore, status: tier[0], color: tier[1], composite_z: compositeZ === null ? null : pyRound(compositeZ, 2),
        inputs_used: inputsUsed, target_strain: tier[2], coach_tip: tier[3], drivers,
      },
      sleep: {
        score: null,
        score_source: null,
        stage_source: hasSleep ? (sleepEntry.stage_source ?? null) : null,
        duration_minutes: asleep,
        duration_formatted: hasSleep ? fmtHm(asleep) : null,
        time_in_bed_minutes: inBed,
        efficiency,
        debt_minutes: debt,
        debt_formatted: hasSleep ? (debt > 0 ? fmtHm(debt) : '0m (Restored)') : null,
        deep_min: hasSleep ? (sleepEntry.deep_min ?? null) : null,
        rem_min: hasSleep ? (sleepEntry.rem_min ?? null) : null,
        light_min: hasSleep ? (sleepEntry.light_min ?? null) : null,
        wake_min: hasSleep ? (sleepEntry.wake_min ?? null) : null,
        hypnogram: sleepEntry.hypnogram || [],
      },
      cardiovascular: {
        rhr,
        hrv_rmssd: truthy(rmssd) ? pyRound(rmssd, 1) : null,
        vo2_max: vo2,
        spo2: spo2Entry ? spo2Entry.avg : null,
        temp: truthy(temp) ? pyRound(temp, 2) : null,
        respiration_rate: resp,
        stress_index: stress,
      },
      body_age: { chronological: profile.chronological_age, ...fitness },
      strain: {
        score: strain,
        trimp,
        steps,
        calories: cals,
        zones,
        zone_minutes: awakeZoneMinutes(minuteHr, rhr, profile.max_hr, profile.zone_max_hr, asleepMinutes(dt, d => get('sleep', d))),
        workouts: dayWorkouts,
        intraday_hr: spark,
        hr_stats: minuteHr.length ? (() => {
          let sum = 0;
          let lo = Infinity;
          let best = minuteHr[0];
          for (const p of minuteHr) { sum += p.bpm; lo = Math.min(lo, p.bpm); if (p.bpm > best.bpm) best = p; }
          return { avg: pyInt(sum / minuteHr.length), min: lo, max: best.bpm, max_time: best.time };
        })() : null,
        hourly_steps: get('hourly_steps', dt) ?? null,
        hourly_calories: get('hourly_cals', dt) ?? null,
      },
    });

    for (const [key, v] of [['hrv', rmssd], ['rhr', rhr], ['resp', resp], ['temp', temp]]) {
      if (truthy(v)) histories[key].push([dt, v]);
    }
  }

  const model = applySleepScore(records, labels);
  applyBodyAge(records, profile);
  const scored = records.filter(r => r.recovery.score !== null);
  const recs = scored.map(r => r.recovery.score);
  const sleeps = records.map(r => r.sleep.score).filter(truthy);
  const strains = records.map(r => r.strain.score);
  const hrvs = records.map(r => r.cardiovascular.hrv_rmssd).filter(truthy);
  const rhrs = records.map(r => r.cardiovascular.rhr).filter(truthy);
  return {
    profile,
    overview: {
      total_days_analyzed: records.length,
      date_start: records[0].date,
      date_end: records[records.length - 1].date,
      avg_recovery: recs.length ? pyRound(meanOf(recs), 1) : null,
      avg_sleep_score: sleeps.length ? pyRound(meanOf(sleeps), 1) : null,
      avg_strain: pyRound(meanOf(strains), 1),
      avg_hrv: hrvs.length ? pyRound(meanOf(hrvs), 1) : null,
      avg_rhr: rhrs.length ? pyRound(meanOf(rhrs), 1) : null,
      best_recovery_day: scored.length ? firstMaxBy(scored, r => r.recovery.score).date : null,
      highest_strain_day: firstMaxBy(records, r => r.strain.score).date,
      sleep_score_model: model,
    },
    days: records,
  };
}

// ---------- Sleep score (port of sleep_score.py) ----------
const CURRENT_STAGING = new Set(['api', 'takeout-v2']);
const MIN_SLEEP_MIN = 120;
const MIN_LABELS = 15;
const ASLEEP_CAP_MIN = 420;
const TERMS = [['asleep', 'Time asleep'], ['rem', 'REM sleep'], ['deep', 'Deep sleep'], ['awake', 'Time awake']];
const LOWER = [-Infinity, 0, 0, 0, -Infinity];
const UPPER = [Infinity, Infinity, Infinity, Infinity, 0];
const DEFAULT_MODEL = { coef: [34.21, 5.03, 2.80, 2.43, -2.63], range: { asleep: [204, 491], rem: [34, 116], deep: [58, 107], awake: [0, 90] } };

export function nightFeatures(sleep) {
  if (!sleep || !CURRENT_STAGING.has(sleep.stage_source)) return null;
  const asleep = sleep.duration_minutes;
  if (asleep == null || asleep < MIN_SLEEP_MIN) return null;
  const stages = new Set((sleep.hypnogram || []).map(h => h.stage));
  if (!['light', 'deep', 'rem'].some(s => stages.has(s))) return null;
  const f = { asleep, rem: sleep.rem_min, deep: sleep.deep_min, awake: sleep.wake_min };
  if (Object.values(f).some(v => v == null)) return null;
  return f;
}

function bounded(f, rng) {
  const out = {};
  for (const [k] of TERMS) out[k] = Math.min(Math.max(f[k], rng[k][0]), rng[k][1]);
  return out;
}

function terms(coef, f, rng) {
  const v = bounded(f, rng);
  return {
    asleep: coef[1] * Math.min(v.asleep, ASLEEP_CAP_MIN) / 60,
    rem: coef[2] * v.rem / 30,
    deep: coef[3] * v.deep / 30,
    awake: coef[4] * Math.log1p(v.awake),
  };
}

function designRow(f, rng) {
  const t = terms([1, 1, 1, 1, 1], f, rng);
  return [1.0, t.asleep, t.rem, t.deep, t.awake];
}

function solve(A, b) {
  // Gaussian elimination with partial pivoting.
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Least squares with box constraints at zero (b1..b3 >= 0, b4 <= 0): the
// optimum has some constrained coefficients fixed at 0 and the rest free, so
// try every such subset and keep the feasible fit with the smallest error.
function boundedLeastSquares(X, y) {
  const nCoef = X[0].length;
  const constrained = [1, 2, 3, 4];
  let best = null;
  for (let mask = 0; mask < 1 << constrained.length; mask++) {
    const fixed = new Set(constrained.filter((_, i) => mask & (1 << i)));
    const free = [...Array(nCoef).keys()].filter(j => !fixed.has(j));
    const AtA = free.map(a => free.map(b => X.reduce((s, row) => s + row[a] * row[b], 0)));
    const Aty = free.map(a => X.reduce((s, row, i) => s + row[a] * y[i], 0));
    const sol = solve(AtA, Aty);
    if (!sol) continue;
    const coef = Array(nCoef).fill(0);
    free.forEach((j, k) => { coef[j] = sol[k]; });
    if (coef.some((c, j) => c < LOWER[j] - 1e-9 || c > UPPER[j] + 1e-9)) continue;
    const sse = X.reduce((s, row, i) => s + (row.reduce((a, x, j) => a + x * coef[j], 0) - y[i]) ** 2, 0);
    if (!best || sse < best.sse - 1e-12) best = { coef, sse };
  }
  return best.coef;
}

export function fitModel(features, scores) {
  const rng = {};
  for (const [k] of TERMS) rng[k] = [Math.min(...features.map(f => f[k])), Math.max(...features.map(f => f[k]))];
  return { coef: boundedLeastSquares(features.map(f => designRow(f, rng)), scores), range: rng };
}

export function predict(model, f) {
  const t = terms(model.coef, f, model.range);
  return model.coef[0] + t.asleep + t.rem + t.deep + t.awake;
}

const toScore = v => pyInt(Math.min(100.0, Math.max(0.0, v)));

function leaveOneOut(features, scores) {
  return scores.map((s, i) => {
    const m = fitModel([...features.slice(0, i), ...features.slice(i + 1)], [...scores.slice(0, i), ...scores.slice(i + 1)]);
    return predict(m, features[i]) - s;
  });
}

function scoreDrivers(model, f, typical) {
  const mine = terms(model.coef, f, model.range);
  const usual = terms(model.coef, typical, model.range);
  return TERMS.map(([key, label]) => ({
    key, label,
    minutes: pyInt(f[key]),
    typical_minutes: pyInt(typical[key]),
    points: pyRound(mine[key] - usual[key], 1),
  }));
}

/** Fill each record's sleep score in place; `labels` maps 'YYYY-MM-DD' -> app score. */
export function applySleepScore(records, labels) {
  const feats = Object.fromEntries(records.map(r => [r.date, nightFeatures(r.sleep)]));
  const train = Object.keys(labels).sort().filter(d => feats[d]).map(d => [feats[d], labels[d]]);
  const summary = { labels: Object.keys(labels).length, training_nights: train.length, min_sleep_minutes: MIN_SLEEP_MIN, asleep_cap_minutes: ASLEEP_CAP_MIN };
  let model;
  if (train.length >= MIN_LABELS) {
    const F = train.map(t => t[0]);
    const y = train.map(t => t[1]);
    model = fitModel(F, y);
    const errs = leaveOneOut(F, y).map(Math.abs);
    Object.assign(summary, {
      method: 'fit',
      mae: pyRound(meanOf(errs), 1),
      within3: pyInt(errs.filter(e => e <= 3).length / errs.length * 100),
      within5: pyInt(errs.filter(e => e <= 5).length / errs.length * 100),
      max_error: pyRound(Math.max(...errs), 1),
    });
  } else {
    model = { coef: [...DEFAULT_MODEL.coef], range: { ...DEFAULT_MODEL.range } };
    summary.method = 'default';
  }
  const usable = Object.values(feats).filter(Boolean);
  const typical = usable.length ? Object.fromEntries(TERMS.map(([k]) => [k, median(usable.map(f => f[k]))])) : null;
  const c = model.coef;
  Object.assign(summary, {
    coefficients: { intercept: pyRound(c[0], 2), per_hour_asleep: pyRound(c[1], 2), per_30_min_rem: pyRound(c[2], 2), per_30_min_deep: pyRound(c[3], 2), per_ln_awake_minute: pyRound(c[4], 2) },
    learned_range: Object.fromEntries(Object.entries(model.range).map(([k, [lo, hi]]) => [k, [pyInt(lo), pyInt(hi)]])),
    typical_night: typical ? Object.fromEntries(Object.entries(typical).map(([k, v]) => [k, pyInt(v)])) : null,
    typical_score: typical ? toScore(predict(model, typical)) : null,
  });

  let appNights = 0;
  let estimated = 0;
  for (const r of records) {
    const s = r.sleep;
    const f = feats[r.date];
    s.score_estimate = f ? toScore(predict(model, f)) : null;
    s.score_drivers = f && typical ? scoreDrivers(model, f, typical) : [];
    if (r.date in labels) {
      s.score = pyInt(labels[r.date]);
      s.score_source = 'app';
      appNights += 1;
    } else if (s.score_estimate !== null) {
      s.score = s.score_estimate;
      s.score_source = 'estimate';
      estimated += 1;
    } else {
      s.score = null;
      s.score_source = null;
    }
  }
  summary.app_nights = appNights;
  summary.estimated_nights = estimated;
  return summary;
}

// ---------- Body age (port of body_age.py; design: docs/BODY_AGE_DESIGN.md) ----------
const BA_GAMMA = Math.log(2) / 8.0;
const BA_WINDOW = 180; // six months, like WHOOP Age
const BA_UPDATE_WEEKDAY = 1; // Monday (JS getUTCDay); recomputed then and held for the week
const BA_MIN_RECOVERIES = 21, BA_RECOVERY_SPAN = 31;
const BA_MIN_DAYS = 14;
const BA_FLOOR = 17.0;
const PACE_SHORT = 30;
const PACE_LONG = 180;
const PACE_MIN_HISTORY = 90;
const PACE_DEADBAND = 0.3;
const STRENGTH_RE = /weight|strength|machine|lift|resistance|crossfit|kettlebell|calisthenic/i;
const BMI_POINTS = [[15.0, 1.51], [18.5, 1.51], [19.25, 1.13], [21.25, 1.0], [23.75, 1.0], [26.25, 1.07], [28.75, 1.20], [32.5, 1.45], [37.5, 1.94]];
const AREM_POINTS = [[0.0, 1.0], [0.5, 0.80], [1.5, 0.69], [2.5, 0.63], [4.0, 0.61], [10.0, 0.61]];
const BA_KEYS = ['vo2', 'rhr', 'steps', 'zone', 'strength', 'sleep', 'sri', 'bmi'];
const BA_LABELS = { vo2: 'VO₂ max', rhr: 'Resting heart rate', steps: 'Daily steps', zone: 'Zone minutes', strength: 'Strength training', sleep: 'Sleep duration', sri: 'Sleep regularity', bmi: 'BMI' };
const BA_GROUP = { vo2: 'fitness', rhr: 'fitness', steps: 'activity', zone: 'activity', strength: 'activity', sleep: 'sleep', sri: 'sleep', bmi: 'body' };
const BA_GROUP_FACTOR = { fitness: 1.0, activity: 0.5, sleep: 0.8, body: 1.0 };
const BA_DRIVER_FACTOR = { rhr: 0.6, bmi: 0.5 };
const BA_REL_SE = { vo2: 0.15, rhr: 0.2, steps: 0.2, zone: 0.3, strength: 0.3, sleep: 0.25, sri: 0.1, bmi: 0.1 };
const PEER_ZONE = 75.0;
const PEER_SRI = 61.0;

function interpLog(points, x) {
  if (x <= points[0][0]) return Math.log(points[0][1]);
  for (let i = 0; i + 1 < points.length; i++) {
    const [x0, h0] = points[i];
    const [x1, h1] = points[i + 1];
    if (x <= x1) {
      if (x1 === x0) return Math.log(h1);
      return Math.log(h0) + (x - x0) / (x1 - x0) * (Math.log(h1) - Math.log(h0));
    }
  }
  return Math.log(points[points.length - 1][1]);
}

const peerVo2 = (age, sex) => vo2Norm(age, sex)[0];
const peerRhr = (age, sex) => (age < 40 ? (sex === 'male' ? 68.0 : sex === 'female' ? 74.0 : 71.0) : 72.0);
const peerSteps = (age, sex) => (age < 40 ? (sex === 'male' ? 8300.0 : sex === 'female' ? 7100.0 : 7600.0) : 7700.0);
const perMet = sex => (sex === 'male' ? 0.85 : sex === 'female' ? 0.92 : 0.885);

const lnVo2 = (v, sex) => Math.log(perMet(sex)) * v / 3.5;
const lnRhr = v => Math.log(1.12) * (v - 45.0) / 10.0;
const lnSteps = v => Math.log(0.85) * Math.min(Math.max(v, 4000.0), 10000.0) / 1000.0;
const lnZone = m => interpLog(AREM_POINTS, m / 150.0);
function lnStrength(m) {
  if (m <= 0) return 0.0;
  if (m < 30) return Math.log(0.85) * m / 30.0;
  if (m <= 60) return Math.log(0.85);
  if (m <= 140) return Math.log(0.85) + (m - 60.0) / 80.0 * (Math.log(0.92) - Math.log(0.85));
  return Math.log(0.92);
}
function lnSleep(h) {
  const short = h <= 6 ? 1.0 : h < 7 ? 7.0 - h : 0.0;
  const long = h >= 9 ? 1.0 : h > 8 ? h - 8.0 : 0.0;
  return short * Math.log(1.12) + 0.5 * long * Math.log(1.30);
}
function lnSri(sri) {
  if (sri < PEER_SRI) return Math.log(1.53) * (PEER_SRI - Math.max(sri, 41.0)) / 20.0;
  return Math.log(0.90) * (Math.min(sri, 75.0) - PEER_SRI) / 14.0;
}
const lnBmi = b => interpLog(BMI_POINTS, b);

function baMean(vals) {
  const v = vals.filter(x => x !== null && x !== undefined);
  if (!v.length) return [null, 0];
  let s = 0;
  for (const x of v) s += x;
  return [s / v.length, v.length];
}

const naiveMs = ts => Date.parse(`${ts.slice(0, 19)}Z`);
const shiftDay = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function sleepPairs(records) {
  const byDate = new Map(records.map(r => [r.date, r]));
  const asleep = new Map();
  for (const r of records) {
    const h = (r.sleep.hypnogram || []).filter(x => x.time && x.seconds);
    if (!h.length || r.sleep.duration_minutes == null) continue;
    const a = naiveMs(h[0].time);
    const b = naiveMs(h[h.length - 1].time) + h[h.length - 1].seconds * 1000;
    for (let t = Math.floor(a / 60000) * 60000; t < b; t += 60000) {
      const d = new Date(t);
      const key = d.toISOString().slice(0, 10);
      if (!asleep.has(key)) asleep.set(key, new Set());
      asleep.get(key).add(d.getUTCHours() * 60 + d.getUTCMinutes());
    }
  }
  const out = new Map();
  const recorded = iso => byDate.has(iso) && byDate.get(iso).sleep.duration_minutes != null;
  for (const r of records) {
    const d1 = shiftDay(r.date, 1);
    const d2 = shiftDay(r.date, 2);
    if (!recorded(r.date) || !recorded(d1) || !recorded(d2)) continue;
    const a0 = asleep.get(r.date) || new Set();
    const a1 = asleep.get(d1) || new Set();
    let same = 0;
    for (let m = 0; m < 1440; m++) if (a0.has(m) === a1.has(m)) same++;
    out.set(r.date, [same, 1440]);
  }
  return out;
}

function baInputs(records, i, profile, pairs, window) {
  const lo = Math.max(0, i - window + 1);
  const win = records.slice(lo, i + 1);
  const before = records.slice(lo, i);
  const r = records[i];
  const out = {};
  if (r.cardiovascular.vo2_max != null) out.vo2 = r.cardiovascular.vo2_max;
  let [v, n] = baMean(win.map(x => x.cardiovascular.rhr));
  if (n >= BA_MIN_DAYS) out.rhr = v;
  [v, n] = baMean(before.map(x => x.strain.steps));
  if (n >= BA_MIN_DAYS) out.steps = v;
  const zm = before.map(x => x.strain.zone_minutes).filter(Boolean);
  if (zm.length >= BA_MIN_DAYS) {
    let total = 0;
    for (const z of zm) total += (z.moderate || 0) + 2 * ((z.vigorous || 0) + (z.peak || 0));
    out.zone = total / (zm.length / 7.0);
    let strength = 0;
    for (const x of before) for (const w of x.strain.workouts || []) if (STRENGTH_RE.test(w.name || '')) strength += w.duration_minutes || 0;
    out.strength = strength / (zm.length / 7.0);
  }
  [v, n] = baMean(win.map(x => x.sleep.duration_minutes));
  if (n >= BA_MIN_DAYS) out.sleep = v / 60.0;
  const p = win.filter(x => pairs.has(x.date)).map(x => pairs.get(x.date));
  if (p.length >= BA_MIN_DAYS) {
    let s = 0;
    let t = 0;
    for (const [a, b] of p) { s += a; t += b; }
    out.sri = 200.0 * s / t - 100.0;
  }
  if (profile.bmi) out.bmi = profile.bmi;
  return out;
}

function baDriverYears(key, value, age, sex) {
  const tau = key === 'vo2' || age >= 30 ? 1.0 : 0.7;
  let lnYou;
  let lnPeer = 0.0;
  if (key === 'vo2') { lnYou = lnVo2(value, sex); lnPeer = lnVo2(peerVo2(age, sex), sex); }
  else if (key === 'rhr') { lnYou = lnRhr(value); lnPeer = lnRhr(peerRhr(age, sex)); }
  else if (key === 'steps') { lnYou = lnSteps(value); lnPeer = lnSteps(peerSteps(age, sex)); }
  else if (key === 'zone') { lnYou = lnZone(value); lnPeer = lnZone(PEER_ZONE); }
  else if (key === 'strength') lnYou = lnStrength(value);
  else if (key === 'sleep') lnYou = lnSleep(value);
  else if (key === 'sri') lnYou = lnSri(value);
  else lnYou = lnBmi(value);
  const factor = (BA_DRIVER_FACTOR[key] ?? 1.0) * BA_GROUP_FACTOR[BA_GROUP[key]];
  const base = (lnYou - lnPeer) / BA_GAMMA;
  const years = tau * factor * base;
  const sEffect = BA_REL_SE[key] * Math.abs(years);
  const sTransfer = (1.0 - tau) * factor * Math.abs(base);
  let sMeas = 0.0;
  if (key === 'vo2') sMeas = tau * factor * Math.abs(Math.log(perMet(sex))) / BA_GAMMA;
  else if (key === 'rhr') sMeas = tau * factor * Math.log(1.12) * 0.2 / BA_GAMMA;
  return [years, Math.sqrt(sEffect ** 2 + sTransfer ** 2 + sMeas ** 2)];
}

function baEvaluate(values, age, sex) {
  const per = {};
  let variance = 0.0;
  for (const key of BA_KEYS) {
    if (key in values) {
      const [y, s] = baDriverYears(key, values[key], age, sex);
      per[key] = y;
      variance += s * s;
    }
  }
  const model = age < 30 ? 3.0 : 2.0;
  let total = 0;
  for (const y of Object.values(per)) total += y;
  return [total, Math.sqrt(variance + model * model), per];
}

function baBounded(age, delta) {
  const cap = age < 30 ? 8.0 : 10.0;
  return Math.max(BA_FLOOR, age + Math.min(cap, Math.max(-cap, delta)));
}

const BA_PEER = { vo2: peerVo2, rhr: peerRhr, steps: peerSteps, zone: () => PEER_ZONE, strength: () => 0.0, sleep: () => 7.5, sri: () => PEER_SRI, bmi: () => 23.75 };

function leverTarget(key, v) {
  const targets = {
    vo2: v + 3.5, rhr: v - 5.0, steps: Math.max(v, 10000.0), zone: Math.max(v, 300.0),
    strength: v < 30 || v > 140 ? 45.0 : null, sleep: v < 7 || v > 8 ? 7.5 : null,
    sri: Math.max(v, 75.0), bmi: v < 20 ? 21.25 : v > 25 ? 24.9 : null,
  };
  return targets[key] ?? null;
}

function bodyAgeForDay(records, i, profile, pairs, window = BA_WINDOW, withDetail = true) {
  const age = profile.chronological_age;
  const sex = profile.sex ?? null;
  if (age == null) return null;
  const values = baInputs(records, i, profile, pairs, window);
  const haveCore = 'vo2' in values || 'rhr' in values;
  if (Object.keys(values).length < 3 || !haveCore) {
    const missing = ['vo2', 'rhr', 'steps', 'zone', 'sleep', 'sri'].filter(k => !(k in values)).map(k => BA_LABELS[k]);
    return { status: 'calibrating', value: null, delta: null, raw_delta: null, chronological: age, sigma: null, pace: null, pace_change: null, missing, floored: false, drivers: [], levers: [] };
  }
  const [delta, sigma, per] = baEvaluate(values, age, sex);
  const value = pyRound(baBounded(age, delta), 1);
  const out = {
    status: 'ok', value, delta: pyRound(value - age, 1), raw_delta: pyRound(delta, 2), chronological: age,
    sigma: Math.max(2, Math.trunc(pyInt(sigma))), pace: null, pace_change: null, missing: [], floored: value <= BA_FLOOR && age + delta < BA_FLOOR, drivers: [], levers: [],
  };
  if (!withDetail) return out;
  const drivers = Object.entries(per).map(([k, y]) => ({ key: k, label: BA_LABELS[k], value: pyRound(values[k], 2), peer: pyRound(BA_PEER[k](age, sex), 2), years: pyRound(y, 1) }));
  drivers.sort((a, b) => Math.abs(b.years) - Math.abs(a.years));
  out.drivers = drivers;
  const levers = [];
  for (const k of Object.keys(per)) {
    const t = leverTarget(k, values[k]);
    if (t === null) continue;
    const gain = baEvaluate({ ...values, [k]: t }, age, sex)[0] - delta;
    if (gain < -0.05) levers.push({ key: k, label: BA_LABELS[k], from: pyRound(values[k], 2), to: pyRound(t, 2), years: pyRound(gain, 1) });
  }
  levers.sort((a, b) => a.years - b.years);
  out.levers = levers.slice(0, 3);
  return out;
}

/** Fill record.bio_age for every day; pace from the last 30 vs 180 days (body_age.apply). */
// See _calibrating, _recoveries, weekly_value and apply in body_age.py.
function baCalibrating(age, missing, recoveries = null) {
  return { status: 'calibrating', value: null, delta: null, raw_delta: null, chronological: age,
    sigma: null, pace: null, pace_change: null, missing, floored: false, drivers: [], levers: [], recoveries };
}

function baRecoveries(records, i) {
  let n = 0;
  for (let j = Math.max(0, i - BA_RECOVERY_SPAN + 1); j <= i; j++) if (records[j].recovery?.score != null) n++;
  return n;
}

function baWeekly(records, i, profile, pairs, first) {
  const ba = bodyAgeForDay(records, i, profile, pairs);
  if (!ba) return null;
  const n = baRecoveries(records, i);
  if (ba.status === 'ok' && n < BA_MIN_RECOVERIES) return baCalibrating(ba.chronological, [], n);
  if (ba.status === 'ok') {
    const span = Math.round((Date.parse(`${records[i].date}T00:00:00Z`) - first) / 86400000) + 1;
    if (span >= PACE_MIN_HISTORY) {
      const longW = Math.min(PACE_LONG, span);
      const short = bodyAgeForDay(records, i, profile, pairs, PACE_SHORT, false);
      const longb = bodyAgeForDay(records, i, profile, pairs, longW, false);
      if (short && longb && short.status === 'ok' && longb.status === 'ok') {
        const dt = (longW - PACE_SHORT) / 2.0 / 365.0;
        const change = short.raw_delta - longb.raw_delta;
        const pace = Math.abs(change) < PACE_DEADBAND ? 1.0 : 1.0 + change / dt;
        ba.pace = pyRound(Math.min(3.0, Math.max(-1.0, pace)), 1);
        ba.pace_change = pyRound(change, 1);
      }
    }
  }
  return ba;
}

export function applyBodyAge(records, profile) {
  const pairs = sleepPairs(records);
  const first = records.length ? Date.parse(`${records[0].date}T00:00:00Z`) : null;
  let current = null;
  let updated = null;
  records.forEach((r, i) => {
    if (new Date(`${r.date}T00:00:00Z`).getUTCDay() === BA_UPDATE_WEEKDAY) {
      const ba = baWeekly(records, i, profile, pairs, first);
      if (ba && (ba.status === 'ok' || current === null || current.status !== 'ok')) { current = ba; updated = r.date; }
    }
    if (current === null) {
      const age = profile.chronological_age;
      r.bio_age = age == null ? null : { ...baCalibrating(age, [], baRecoveries(records, i)), updated: null };
    } else {
      r.bio_age = { ...current, updated };
    }
  });
}
