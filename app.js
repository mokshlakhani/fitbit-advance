// DataStrap dashboard.
// Home shows the selected day at a glance; every metric opens a detail page
// with Day / Week / Month / 3-month views over calendar periods.

const state = { data: null, idx: 0, route: { page: 'home' } };

const BASELINE_DAYS = 14;
const RANGE_DAYS = 30;
const RANGES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: '3m', label: '3 Months', short: '3M' },
];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const days = () => state.data.days;
const day = () => days()[state.idx];

function fmt(v, dp = 0) {
  if (!isNum(v)) return '--';
  return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function fmtDur(min) {
  if (!isNum(min)) return '--';
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

function mean(arr) {
  const v = arr.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function sum(arr) {
  const v = arr.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

// Dates are handled as local calendar days.
function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
const fmtDate = (iso, opts) => parseDate(iso).toLocaleDateString('en-US', opts);
const shortDate = (iso) => fmtDate(iso, { month: 'short', day: 'numeric' });
const longDate = (iso) => fmtDate(iso, { weekday: 'short', month: 'short', day: 'numeric' });
const fullDate = (iso) => fmtDate(iso, { weekday: 'long', month: 'long', day: 'numeric' });

function relativeDay(iso) {
  const now = new Date();
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - parseDate(iso)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return null;
}

function dateIndex(iso) {
  const first = parseDate(days()[0].date);
  const i = Math.round((parseDate(iso) - first) / 86400000);
  return days()[i] && days()[i].date === iso ? i : -1;
}

function clampIdx(i) {
  return Math.max(0, Math.min(days().length - 1, i));
}

function tierOf(score) {
  if (!isNum(score)) return null;
  if (score >= 67) return { cls: 'good', word: 'Ready to push', strain: '14–18', color: 'var(--good)' };
  if (score >= 34) return { cls: 'fair', word: 'Steady', strain: '10–14', color: 'var(--fair)' };
  return { cls: 'poor', word: 'Take it easy', strain: 'under 10', color: 'var(--poor)' };
}

// ---------- Icons (Phosphor, see icons.js) ----------
const ICON = {
  recovery: 'battery-charging', steps: 'footprints', energy: 'flame', strain: 'zap', zones: 'activity',
  sleep: 'moon', sleepScore: 'star', efficiency: 'gauge', rhr: 'heart', hrv: 'audio-waveform', hr: 'heart-pulse',
  stress: 'brain', temp: 'thermometer', spo2: 'droplet', resp: 'wind', vo2: 'mountain', bioAge: 'hourglass',
  chev: 'chevron-right', back: 'chevron-left',
};
// Metric icons use Phosphor's two-tone weight; arrows and controls the regular one.
const icon = (name, cls = '', weight) => ph(ICON[name] || name, cls, weight || (name === 'chev' || name === 'back' ? 'regular' : 'duotone'));

// Metric icons with a small idle animation (heart beats, lungs breathe…). The
// heart beats at the day's resting rate and the wind icon at the breathing rate.
function glyph(key, d = day(), cls = 'glyph') {
  const vars = [];
  const rhr = d && d.cardiovascular.rhr;
  const resp = d && d.cardiovascular.respiration_rate;
  if (isNum(rhr)) vars.push(`--beat:${(60 / rhr).toFixed(2)}s`);
  if (isNum(resp)) vars.push(`--breath:${(60 / resp).toFixed(2)}s`);
  return `<span class="${cls} live" data-anim="${key}" style="--accent:${accent(key)};${vars.join(';')}">${icon(key)}</span>`;
}

// ---------- Metrics ----------
const GROUPS = {
  recovery: { color: 'var(--good)' },
  activity: { label: 'Activity', color: 'var(--strain)' },
  sleep: { label: 'Sleep', color: 'var(--sleep)' },
  heart: { label: 'Heart', color: 'var(--heart)' },
  body: { label: 'Body', color: 'var(--body)' },
};

const avgHr = d => (d.strain.hr_stats ? d.strain.hr_stats.avg : d.strain.intraday_hr && d.strain.intraday_hr.length ? Math.round(mean(d.strain.intraday_hr.map(p => p.bpm))) : null);
const zoneMin = d => (d.strain.zone_minutes ? d.strain.zone_minutes.moderate + d.strain.zone_minutes.vigorous + d.strain.zone_minutes.peak : null);
// Temperatures are stored in °C; show them in the unit set in the user's Google Health settings.
const useF = () => (state.data.profile.temperature_unit || '').toUpperCase() === 'FAHRENHEIT';
const tempIn = c => (isNum(c) ? (useF() ? c * 9 / 5 + 32 : c) : null);

// kind: chart style for periods; agg: how a period headline summarises days.
const BIO_NOTE = 'Body age compares eight measures with a typical person of your age and sex: VO₂ max, resting heart rate, daily steps, zone minutes, strength training, sleep length, sleep regularity and BMI. Each one’s published link to long-term health (all-cause mortality) is turned into years, using the fact that age-related risk roughly doubles every 8 years. Related measures are discounted so they aren’t counted twice, and under 30 the effects measured in older adults count at 70%. It’s an estimate of physiological age, not a medical or genetic test. Sources: Nes 2014 (VO₂ max), Zhang 2016 (resting HR), Banach 2023 and Paluch 2022 (steps), Arem 2015 (activity), Momma 2022 (strength), Cappuccio 2010 (sleep length), Cribb 2023 (sleep regularity), Global BMI Mortality Collaboration 2016; peers from HUNT, NHANES and the All of Us Fitbit cohort.';

const M = {
  recovery: { label: 'Recovery', group: 'recovery', unit: '%', dp: 0, kind: 'line', agg: 'avg', better: 'higher', domain: [0, 100], intraday: 'drivers', defaultRange: 'day',
    pick: d => d.recovery.score,
    note: 'Each night, HRV, resting heart rate, breathing rate and skin temperature are compared with your own last 14 readings (from up to 28 days back) and combined with weights of 40%, 30%, 20% and 10%. Higher HRV and lower resting heart rate count in your favour; for breathing rate and skin temperature, steady is best and a rise counts against you more than a fall. 50 is a typical night for you. The drivers show how many points each vital moved your score from 50.' },
  steps: { label: 'Steps', group: 'activity', unit: '', dp: 0, kind: 'bar', agg: 'sum', goal: 10000, intraday: 'hourly_steps', defaultRange: 'day', pick: d => d.strain.steps },
  energy: { label: 'Energy burned', cardLabel: 'Energy', group: 'activity', unit: 'cal', dp: 0, kind: 'bar', agg: 'sum', intraday: 'hourly_calories', defaultRange: 'day', pick: d => d.strain.calories },
  strain: { label: 'Day strain', cardLabel: 'Strain', group: 'activity', unit: '/21', dp: 1, kind: 'bar', agg: 'avg', domain: [0, 21], intraday: 'hr', defaultRange: 'week', pick: d => d.strain.score,
    note: 'Cardiovascular load (Banister TRIMP) from minutes at or above light activity, 30% of your heart-rate reserve. Time spent asleep or sitting doesn’t add strain.' },
  zones: { label: 'Zone minutes', group: 'activity', unit: 'min', dp: 0, kind: 'bar', agg: 'sum', intraday: 'zones', defaultRange: 'week', pick: zoneMin },
  sleep: { label: 'Time asleep', group: 'sleep', unit: 'dur', dp: 0, kind: 'bar', agg: 'avg', goal: 480, better: 'higher', intraday: 'hypnogram', defaultRange: 'day', pick: d => d.sleep.duration_minutes },
  sleepScore: { label: 'Sleep score', cardLabel: 'Score', group: 'sleep', unit: '', dp: 0, kind: 'line', agg: 'avg', better: 'higher', intraday: 'scoreDrivers', defaultRange: 'day',
    pick: d => d.sleep.score,
    isEstimate: d => d.sleep.score_source === 'estimate',
    annotate: d => (d.sleep.score == null ? '' : d.sleep.score_source === 'app' ? ' · Fitbit app' : ' · estimated'),
    note: () => {
      const s = state.data.overview.sleep_score_model || {};
      const fit = s.method === 'fit'
        ? `It’s calibrated against the ${s.training_nights} scores you’ve recorded from the Fitbit app and is typically within ±${s.mae} points (${s.within5}% of nights within ±5). It tends to under-score your best nights by a few points.`
        : 'It uses default weights until at least 15 app scores are recorded.';
      return `Google’s Health API doesn’t provide Fitbit’s sleep score, so nights without a score copied from the app are estimated from time asleep, REM, deep sleep and time awake. ${fit} Estimated nights show as hollow points. Add scores to app_sleep_scores.csv to improve the estimate.`;
    } },
  efficiency: { label: 'Sleep efficiency', cardLabel: 'Efficiency', group: 'sleep', unit: '%', dp: 0, kind: 'line', agg: 'avg', better: 'higher', defaultRange: 'week', pick: d => d.sleep.efficiency },
  rhr: { label: 'Resting heart rate', cardLabel: 'Resting HR', group: 'heart', unit: 'bpm', dp: 0, kind: 'line', agg: 'avg', better: 'lower', defaultRange: 'month', pick: d => d.cardiovascular.rhr },
  hrv: { label: 'Heart rate variability', short: 'HRV', cardLabel: 'HRV', group: 'heart', unit: 'ms', dp: 1, kind: 'line', agg: 'avg', better: 'higher', defaultRange: 'month', pick: d => d.cardiovascular.hrv_rmssd },
  hr: { label: 'Heart rate', group: 'heart', unit: 'bpm', dp: 0, kind: 'line', agg: 'avg', intraday: 'hr', defaultRange: 'day', pick: avgHr, cardLabel: 'Avg heart rate' },
  stress: { label: 'Nightly stress', cardLabel: 'Stress', group: 'heart', unit: '', dp: 0, kind: 'line', agg: 'avg', better: 'lower', domain: [0, 100], defaultRange: 'month', pick: d => d.cardiovascular.stress_index,
    note: 'How far your resting heart rate was above, and your HRV below, your own last 14 nights. 50 is a typical night for you; higher means your body was under more strain. It needs 14 nights of both.' },
  temp: { label: 'Skin temperature', cardLabel: 'Skin temp', group: 'body', unit: '°C', dp: 1, kind: 'line', agg: 'avg', defaultRange: 'month', pick: d => tempIn(d.cardiovascular.temp),
    note: 'Nightly skin temperature measured at the wrist.' },
  spo2: { label: 'Blood oxygen', group: 'body', unit: '%', dp: 1, kind: 'line', agg: 'avg', better: 'higher', defaultRange: 'month', pick: d => d.cardiovascular.spo2 },
  resp: { label: 'Breathing rate', group: 'body', unit: 'br/min', dp: 1, kind: 'line', agg: 'avg', defaultRange: 'month', pick: d => d.cardiovascular.respiration_rate },
  bioAge: { label: 'Body age', group: 'body', unit: 'yrs', dp: 1, kind: 'line', agg: 'avg', better: 'lower', intraday: 'bioage', defaultRange: 'day',
    pick: d => (d.bio_age && d.bio_age.status === 'ok' ? d.bio_age.value : null), note: BIO_NOTE },
  vo2: { label: 'VO₂ max', group: 'body', unit: 'ml/kg/min', dp: 1, kind: 'line', agg: 'avg', better: 'higher', defaultRange: '3m', pick: d => d.cardiovascular.vo2_max,
    note: 'Fitbit’s cardio fitness estimate, carried forward for up to 30 days after it was last measured. “For your age” compares it with people of your age and sex in the HUNT3 Fitness Study (Loe et al., 2013); fitness age is the age whose average VO₂ max matches yours, and the study’s age groups run from 20–29 to 70+.' },
};


const DRIVER_KEY = { 'HRV (RMSSD)': 'hrv', 'Resting Heart Rate': 'rhr', 'Respiratory Rate': 'resp', 'Skin Temperature': 'temp' };

const accent = key => GROUPS[M[key].group].color;

function unitText(unit) {
  if (!unit || unit === 'dur') return '';
  return /^[%°/]/.test(unit) ? unit : ` ${unit}`;
}

function valueText(key, v) {
  const m = M[key];
  if (!isNum(v)) return 'No data';
  if (m.unit === 'dur') return fmtDur(v);
  return `${fmt(v, m.dp)}${unitText(m.unit)}`;
}

// Big number with a smaller unit; counts up on change.
function valueHtml(key, v, animKey) {
  const m = M[key];
  if (!isNum(v)) return '';
  if (m.unit === 'dur') {
    const mins = Math.round(v);
    return `${Math.floor(mins / 60)}<span class="u">h</span> ${mins % 60}<span class="u">m</span>`;
  }
  const n = `<span data-num="${v}" data-dp="${m.dp}" data-key="${animKey || key}">${fmt(v, m.dp)}</span>`;
  return m.unit ? `${n}<span class="u">${esc(m.unit)}</span>` : n;
}

function baselineOf(key, idx, n = BASELINE_DAYS) {
  return mean(days().slice(Math.max(0, idx - n), idx).map(M[key].pick));
}

// Personal normal range: mean ± 1 SD over the 30 days before idx (needs 7+ readings).
function normalRange(key, idx) {
  const vals = days().slice(Math.max(0, idx - RANGE_DAYS), idx).map(M[key].pick).filter(isNum);
  if (vals.length < 7) return null;
  const m = mean(vals);
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
  const half = Math.max(sd, Math.abs(m) * 0.01);
  return { lo: m - half, hi: m + half, mean: m, min: Math.min(...vals), max: Math.max(...vals) };
}

// compact: "0.6 br/min vs usual" (the arrow shows the direction), for small cards.
function deltaInfo(key, idx, compact = false) {
  const m = M[key];
  const v = m.pick(days()[idx]);
  const b = baselineOf(key, idx);
  if (!isNum(v) || !isNum(b)) return { text: '', cls: '' };
  const diff = v - b;
  const shown = m.unit === 'dur' ? fmtDur(Math.abs(diff)) : fmt(Math.abs(diff), m.dp);
  if (Number(shown) === 0 || shown === '0m') return { text: 'Right at your usual', cls: '', dir: 0 };
  const dir = diff > 0 ? 1 : -1;
  const cls = m.better ? ((dir > 0) === (m.better === 'higher') ? 'good' : 'poor') : '';
  const u = key === 'recovery' ? ' pts' : m.unit === 'dur' || (m.unit || '').startsWith('/') ? '' : unitText(m.unit);
  return { text: `${shown}${u} ${compact ? 'vs' : dir > 0 ? 'above' : 'below'} usual`, cls, dir };
}

function deltaHtml(key, idx, compact = false) {
  const d = deltaInfo(key, idx, compact);
  const arrow = d.dir ? `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${d.dir > 0 ? 'M6 2l4 5H2z' : 'M6 10 2 5h8z'}"/></svg>` : '';
  return `<div class="delta ${d.cls}">${arrow}${esc(d.text)}</div>`;
}

// ---------- Chart primitives ----------
function scale(d0, d1, r0, r1) {
  const k = (r1 - r0) / ((d1 - d0) || 1);
  return v => r0 + (v - d0) * k;
}

function niceTicks(min, max, count = 3) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

function tickLabel(key, v) {
  if (M[key] && M[key].unit === 'dur') return `${Math.round(v / 60)}h`;
  return v >= 10000 ? `${fmt(v / 1000, 0)}k` : fmt(v, v % 1 ? 1 : 0);
}

// Columns that carry tooltips (and a target date when clickable).
function hitStrips(xs, top, h, tips, hrefs, after = []) {
  const n = xs.length;
  return xs.map((x, i) => {
    const l = i === 0 ? x - ((n > 1 ? xs[1] : x + 24) - x) / 2 : (xs[i - 1] + x) / 2;
    const r = i === n - 1 ? x + (x - (n > 1 ? xs[i - 1] : x - 24)) / 2 : (x + xs[i + 1]) / 2;
    const href = hrefs && hrefs[i] ? ` data-href="${hrefs[i]}"` : '';
    return `<rect class="hit" x="${l}" y="${top}" width="${Math.max(1, r - l)}" height="${h}" data-tip="${esc(tips[i])}"${href}/>${after[i] || ''}`;
  }).join('');
}

function xLabels(xs, labels, H, selPos) {
  const gap = xs.length > 1 ? xs[1] - xs[0] : 40;
  const pw = Math.max(18, Math.min(28, gap - 2));
  return labels.map((lab, i) => {
    if (!lab) return '';
    const sel = i === selPos;
    const pill = sel ? `<rect x="${xs[i] - pw / 2}" y="${H - 24}" width="${pw}" height="22" rx="${pw / 2}" style="fill:var(--raised)"/>` : '';
    return `${pill}<text x="${xs[i]}" y="${H - 8}" text-anchor="middle" class="${sel ? 'sel-text' : ''}">${esc(lab)}</text>`;
  }).join('');
}

// Bars with optional goal line, y-axis on the trailing edge.
function barChart(w, { key, vals, labels, color, goal, tips, hrefs, selPos, H = 220, yAxis = true, domain }) {
  const top = 10, bottom = 28, padL = 2, padR = yAxis ? 42 : 2;
  const plotB = H - bottom;
  const present = vals.filter(isNum);
  const t = domain ? { lo: domain[0], hi: domain[1], ticks: niceTicks(domain[0], domain[1], 3).ticks.filter(v => v <= domain[1]) }
    : niceTicks(0, Math.max(...present, goal || 0, 1), 3);
  const y = scale(t.lo, t.hi, plotB, top);
  const step = (w - padL - padR) / vals.length;
  const bw = Math.max(2, Math.min(28, step * (vals.length > 40 ? 0.7 : 0.6)));
  const xs = vals.map((_, i) => padL + step * (i + 0.5));
  const grid = yAxis ? t.ticks.map(v => `<line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}"/>
    <text x="${w - padR + 8}" y="${y(v) + 4}">${tickLabel(key, v)}</text>`).join('') : '';
  const bars = vals.map((v, i) => {
    if (!isNum(v)) return '';
    const h = Math.max(v > 0 ? 3 : 2, plotB - y(v));
    const c = typeof color === 'function' ? color(v, i) : color;
    const op = selPos != null && selPos >= 0 && i !== selPos ? 0.55 : 1;
    return `<rect class="bar-mark" x="${xs[i] - bw / 2}" y="${plotB - h}" width="${bw}" height="${h}" rx="${Math.min(bw / 2, 6, h / 2)}" style="fill:${c};opacity:${v > 0 ? op : 0.3};animation-delay:${Math.min(i * 14, 420)}ms"/>`;
  }).join('');
  const goalLine = goal ? `<line class="goal" x1="${padL}" x2="${w - padR}" y1="${y(goal)}" y2="${y(goal)}"/>` : '';
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">
    ${grid}${goalLine}${bars}${xLabels(xs, labels, H, vals.length <= 8 ? selPos : -1)}${hitStrips(xs, 0, plotB, tips, hrefs)}
  </svg>`;
}

// Line with optional dots and a shaded normal range.
// `hollow(i)` marks points drawn as rings (e.g. estimated rather than measured values).
function lineChart(w, { key, vals, labels, color, tips, hrefs, selPos, band, H = 220, dots, area = false, domain, baseline, dotColor, hollow }) {
  const top = 12, bottom = 28, padL = 6, padR = 42;
  const plotB = H - bottom;
  const present = vals.filter(isNum);
  let lo = Math.min(...present, band ? band.lo : Infinity, isNum(baseline) ? baseline : Infinity);
  let hi = Math.max(...present, band ? band.hi : -Infinity, isNum(baseline) ? baseline : -Infinity);
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const t = domain ? { lo: domain[0], hi: domain[1], ticks: niceTicks(domain[0], domain[1], 2).ticks } : niceTicks(lo, hi, 3);
  const y = scale(t.lo, t.hi, plotB, top);
  const n = vals.length;
  const step = (w - padL - padR) / Math.max(1, n - 1);
  const xs = vals.map((_, i) => (n === 1 ? (w - padR) / 2 : padL + i * step));

  const grid = t.ticks.map(v => `<line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}"/>
    <text x="${w - padR + 8}" y="${y(v) + 4}">${tickLabel(key, v)}</text>`).join('');
  const bandRect = band ? `<rect class="band" x="${padL}" y="${y(band.hi)}" width="${w - padL - padR}" height="${Math.max(3, y(band.lo) - y(band.hi))}" rx="6"/>` : '';

  const segs = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (isNum(v)) cur.push([xs[i], y(v)]);
    else if (cur.length) { segs.push(cur); cur = []; }
  });
  if (cur.length) segs.push(cur);
  const pts = s => s.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
  const d = segs.map(s => 'M' + pts(s)).join('');
  const areaD = area ? segs.filter(s => s.length > 1).map(s => `M${s[0][0]},${plotB}L${pts(s)}L${s[s.length - 1][0]},${plotB}Z`).join('') : '';
  const base = isNum(baseline) ? `<line class="goal" x1="${padL}" x2="${w - padR}" y1="${y(baseline)}" y2="${y(baseline)}"/>` : '';
  const showDots = dots ?? n <= 35;
  const dotStyle = (v, i) => {
    const c = i === selPos ? 'var(--text)' : (dotColor ? dotColor(v) : color);
    return hollow && hollow(i) ? `fill:var(--surface);stroke:${c};stroke-width:2` : `fill:${c};stroke:var(--surface);stroke-width:2`;
  };
  const dotEls = showDots ? vals.map((v, i) => (isNum(v)
    ? `<circle class="dot" cx="${xs[i]}" cy="${y(v)}" r="${i === selPos ? 5.5 : 3.5}" style="${dotStyle(v, i)};animation-delay:${Math.min(i * 12, 400)}ms"/>`
    : '')).join('') : (selPos != null && isNum(vals[selPos]) ? `<circle class="dot" cx="${xs[selPos]}" cy="${y(vals[selPos])}" r="5" style="fill:var(--text);stroke:${color};stroke-width:2"/>` : '');
  const hovers = xs.map((x, i) => `<g class="hover-mark">${isNum(vals[i]) ? `<line x1="${x}" x2="${x}" y1="${top}" y2="${plotB}" style="stroke:var(--line-strong)"/><circle cx="${x}" cy="${y(vals[i])}" r="5" style="fill:${color};stroke:var(--surface);stroke-width:2"/>` : ''}</g>`);

  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">
    ${grid}${bandRect}${base}
    ${areaD ? `<path class="area" d="${areaD}" style="fill:${color};fill-opacity:0.1"/>` : ''}
    <path class="draw" d="${d}" pathLength="1" style="fill:none;stroke:${color};stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round"/>
    ${dotEls}${xLabels(xs, labels, H, n <= 8 ? selPos : -1)}${hitStrips(xs, top, plotB - top, tips, hrefs, hovers)}
  </svg>`;
}

// Tiny 7-day chart for home cards.
function sparkChart(w, key, vals, selPos) {
  const H = 46;
  const m = M[key];
  const color = accent(key);
  const present = vals.filter(isNum);
  if (!present.length) return `<svg class="chart" width="${w}" height="${H}"></svg>`;
  if (m.kind === 'bar') {
    const max = Math.max(...present, m.goal || 0, 1);
    const step = w / vals.length;
    const bw = Math.min(16, step * 0.56);
    return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" aria-hidden="true">${vals.map((v, i) => {
      if (!isNum(v)) return '';
      const h = Math.max(3, (H - 2) * v / max);
      return `<rect class="bar-mark" x="${step * (i + 0.5) - bw / 2}" y="${H - h}" width="${bw}" height="${h}" rx="${Math.min(bw / 2, 4)}" style="fill:${color};opacity:${i === selPos ? 1 : 0.4};animation-delay:${i * 30}ms"/>`;
    }).join('')}</svg>`;
  }
  const lo = Math.min(...present), hi = Math.max(...present);
  const pad = (hi - lo) * 0.25 || 1;
  const y = scale(lo - pad, hi + pad, H - 6, 6);
  const step = (w - 12) / Math.max(1, vals.length - 1);
  const xs = vals.map((_, i) => 6 + i * step);
  const segs = [];
  let cur = [];
  vals.forEach((v, i) => { if (isNum(v)) cur.push(`${xs[i].toFixed(1)},${y(v).toFixed(1)}`); else if (cur.length) { segs.push(cur); cur = []; } });
  if (cur.length) segs.push(cur);
  const last = selPos != null && isNum(vals[selPos]) ? `<circle class="dot" cx="${xs[selPos]}" cy="${y(vals[selPos])}" r="4" style="fill:${color};stroke:var(--surface);stroke-width:2"/>` : '';
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" aria-hidden="true">
    <path class="draw" d="${segs.map(s => 'M' + s.join('L')).join('')}" pathLength="1" style="fill:none;stroke:${color};stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.9"/>${last}</svg>`;
}

const STAGES = [
  { key: 'wake', label: 'Awake', color: 'var(--st-wake)' },
  { key: 'rem', label: 'REM', color: 'var(--st-rem)' },
  { key: 'light', label: 'Light', color: 'var(--st-light)' },
  { key: 'deep', label: 'Deep', color: 'var(--st-deep)' },
];
const STAGE_ALIAS = { awake: 'wake', restless: 'wake', asleep: 'light' };

function parseLocal(s) {
  const [d, t] = s.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(parseFloat);
  return new Date(y, mo - 1, da, h, mi, se || 0);
}
const hhmm = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

function hypnogram(w, stages) {
  const rowH = 32, labelW = 54, top = 4, bottom = 28;
  const H = top + rowH * STAGES.length + bottom;
  const segs = stages.map(s => {
    const start = parseLocal(s.time);
    return { key: STAGE_ALIAS[s.stage] || s.stage, start, end: new Date(start.getTime() + s.seconds * 1000) };
  });
  const t0 = segs[0].start.getTime();
  const t1 = segs[segs.length - 1].end.getTime();
  const x = scale(t0, t1, labelW, w - 6);
  const row = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
  const rows = STAGES.map((s, i) => `<text x="0" y="${top + i * rowH + rowH / 2 + 4}">${s.label}</text>
    <line class="grid-line" x1="${labelW}" x2="${w - 6}" y1="${top + i * rowH + rowH / 2}" y2="${top + i * rowH + rowH / 2}" style="stroke-dasharray:2 6"/>`).join('');
  let links = '', hits = '';
  const blocks = segs.map((s, i) => {
    const r = row[s.key] ?? 2;
    const st = STAGES[r];
    const x1 = x(s.start.getTime());
    const x2 = Math.max(x(s.end.getTime()), x1 + 2);
    if (i > 0) {
      const pr = row[segs[i - 1].key] ?? 2;
      if (pr !== r) links += `<line x1="${x1}" x2="${x1}" y1="${top + Math.min(pr, r) * rowH + rowH / 2}" y2="${top + Math.max(pr, r) * rowH + rowH / 2}" style="stroke:var(--line-strong)"/>`;
    }
    const tip = `<b>${st.label}</b><span>${hhmm(s.start)}–${hhmm(s.end)} · ${fmtDur((s.end - s.start) / 60000)}</span>`;
    const by = top + r * rowH + 6, bw = x2 - x1, bh = rowH - 12;
    // A full-height column per stage, so a finger can slide through the night.
    hits += `<rect class="hit" x="${x1}" y="0" width="${bw}" height="${top + rowH * STAGES.length}" data-tip="${esc(tip)}"/>`
      + `<g class="hover-mark"><line x1="${(x1 + x2) / 2}" x2="${(x1 + x2) / 2}" y1="${top}" y2="${top + rowH * STAGES.length}" style="stroke:var(--line-strong)"/>`
      + `<rect x="${x1 - 1.5}" y="${by - 1.5}" width="${bw + 3}" height="${bh + 3}" rx="5" style="fill:none;stroke:var(--text);stroke-width:1.5"/></g>`;
    return `<rect class="stage-mark" x="${x1}" y="${by}" width="${bw}" height="${bh}" rx="4" style="fill:${st.color};animation-delay:${Math.min(i * 10, 360)}ms"/>`;
  }).join('');
  const ticks = [[t0, hhmm(segs[0].start)], [t1, hhmm(segs[segs.length - 1].end)]];
  const h0 = new Date(t0);
  h0.setMinutes(0, 0, 0);
  h0.setHours(h0.getHours() + 1);
  for (let t = h0.getTime(); t < t1; t += 3600000) {
    if (new Date(t).getHours() % 2 === 0 && t - t0 > 2700000 && t1 - t > 2700000) ticks.push([t, hhmm(new Date(t))]);
  }
  const xl = ticks.map(([t, lab]) => `<text x="${Math.min(Math.max(x(t), labelW + 16), w - 22)}" y="${H - 8}" text-anchor="middle">${lab}</text>`).join('');
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Sleep stages ${hhmm(segs[0].start)} to ${hhmm(segs[segs.length - 1].end)}">${rows}${links}${blocks}${xl}${hits}</svg>`;
}

// Where today's value sits in your last 30 days.
function rangeGauge(w, key, v, r) {
  const H = 62;
  const color = accent(key);
  const lo = Math.min(r.min, v), hi = Math.max(r.max, v);
  const pad = (hi - lo) * 0.08 || 1;
  const x = scale(lo - pad, hi + pad, 8, w - 8);
  const yT = 22;
  // One label under the band; units once, kept inside the chart on narrow screens.
  const m = M[key];
  const rangeText = m.unit === 'dur' ? `Usual ${fmtDur(r.lo)} – ${fmtDur(r.hi)}` : `Usual ${fmt(r.lo, m.dp)} – ${fmt(r.hi, m.dp)}${unitText(m.unit)}`;
  const half = rangeText.length * 3.3;
  const labelX = Math.min(w - 8 - half, Math.max(8 + half, (x(r.lo) + x(r.hi)) / 2));
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${esc(valueText(key, v))}, usual range ${esc(valueText(key, r.lo))} to ${esc(valueText(key, r.hi))}">
    <rect x="8" y="${yT - 5}" width="${w - 16}" height="10" rx="5" style="fill:var(--raised)"/>
    <rect x="${x(r.lo)}" y="${yT - 5}" width="${Math.max(6, x(r.hi) - x(r.lo))}" height="10" rx="5" style="fill:${color};opacity:.35"/>
    <circle class="dot" cx="${x(v)}" cy="${yT}" r="9" style="fill:${color};stroke:var(--surface);stroke-width:3"/>
    <text x="${labelX}" y="${yT + 30}" text-anchor="middle">${esc(rangeText)}</text>
  </svg>`;
}

// ---------- Chart slots (built once we know their width) ----------
let charts = {};
function slot(id, build) {
  charts[id] = build;
  return `<div class="chart-slot" data-chart="${id}"></div>`;
}
function mountCharts(root, animate) {
  root.querySelectorAll('.chart-slot').forEach(el => {
    const build = charts[el.dataset.chart];
    const w = Math.floor(el.clientWidth);
    if (!build || w < 40) return;
    el.innerHTML = build(w);
    el.classList.toggle('animate', animate && !reducedMotion);
  });
}

// ---------- Number roll-up ----------
// Every page change counts each headline number up from 0.
function animateNumbers(root) {
  root.querySelectorAll('[data-num]').forEach(el => {
    const to = parseFloat(el.dataset.num);
    const dp = parseInt(el.dataset.dp, 10) || 0;
    if (reducedMotion || !to) { el.textContent = fmt(to, dp); return; }
    el.textContent = fmt(0, dp);
    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / 900);
      el.textContent = fmt(to * (1 - (1 - p) ** 3), dp);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ---------- Routing ----------
function hrefHome(iso) {
  return `#/?d=${iso}`;
}
function hrefMetric(key, range, iso) {
  return `#/m/${key}/${range}?d=${iso}`;
}
function hrefWorkout(iso, i) {
  return `#/w/${iso}/${i}?d=${iso}`;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const d = new URLSearchParams(q || '').get('d');
  if (d) {
    const i = dateIndex(d);
    state.idx = i >= 0 ? i : clampIdx(d < days()[0].date ? 0 : days().length - 1);
  }
  if (parts[0] === 'w' && dateIndex(parts[1]) >= 0) {
    state.idx = dateIndex(parts[1]);
    const w = (days()[state.idx].strain.workouts || [])[Number(parts[2])];
    if (w) return { page: 'workout', key: 'strain', index: Number(parts[2]) };
  }
  if (parts[0] === 'm' && M[parts[1]]) {
    const range = RANGES.some(r => r.key === parts[2]) ? parts[2] : M[parts[1]].defaultRange;
    return { page: 'metric', key: parts[1], range };
  }
  return { page: 'home' };
}

function go(hash, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  route();
}

let lastPage = null;
let lastHash = null;
let transition = null;
let firstRender = true;
// Page changes animate with the View Transitions API where available: the
// browser cross-slides GPU snapshots of the old and new page, so nothing has
// to re-layout mid-animation. Home → metric slides forward, back slides back,
// changing day or range just cross-fades.
function route() {
  // hashchange and popstate can both fire for one navigation.
  if (location.hash === lastHash) return;
  lastHash = location.hash;
  const prevKey = lastPage;
  state.route = parseRoute();
  const pageKey = state.route.page === 'home' ? 'home' : state.route.page === 'workout' ? `w:${location.hash}` : `m:${state.route.key}`;
  const changedPage = pageKey !== prevKey;
  lastPage = pageKey;
  const update = () => {
    // Scroll first: render() checks what's on screen.
    if (changedPage) window.scrollTo({ top: 0, behavior: 'instant' });
    render({ pageEnter: changedPage && !document.startViewTransition });
  };
  if (firstRender || reducedMotion || !document.startViewTransition || document.visibilityState !== 'visible') {
    firstRender = false;
    update();
    return;
  }
  const depth = k => (k === 'home' ? 0 : k && k.startsWith('w:') ? 2 : 1);
  const dir = depth(pageKey) - depth(prevKey);
  document.documentElement.dataset.nav = !changedPage ? 'swap' : dir > 0 ? 'forward' : dir < 0 ? 'back' : 'swap';
  if (transition) transition.skipTransition();
  transition = document.startViewTransition(update);
  transition.finished.finally(() => { transition = null; });
}

// ---------- Story ----------
function describeDelta(key, idx) {
  const m = M[key];
  const v = m.pick(days()[idx]);
  const b = baselineOf(key, idx);
  if (!isNum(v) || !isNum(b)) return null;
  const diff = v - b;
  const abs = fmt(Math.abs(diff), m.dp);
  if (Number(abs) === 0) return `${m.label} was right at your usual ${valueText(key, b)}.`;
  return `${m.label} was ${valueText(key, v)}, ${abs}${unitText(m.unit)} ${diff > 0 ? 'above' : 'below'} your usual.`;
}

function buildStory(d, idx) {
  if (d.cardiovascular.hrv_rmssd == null) {
    return {
      head: 'Waiting on last night’s data',
      body: `Recovery needs your overnight HRV, which hasn’t synced for this day yet. ${describeDelta('rhr', idx) || ''}`.trim(),
    };
  }
  if (d.recovery.score == null) {
    return {
      head: 'Building your baseline',
      body: `Recovery compares each night with your own last two weeks, so it starts once at least two of HRV, resting heart rate, breathing rate and skin temperature have 14 nights of data in the last 28 days. ${describeDelta('rhr', idx) || ''}`.trim(),
    };
  }
  const drivers = d.recovery.drivers.filter(x => DRIVER_KEY[x.metric]).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const top = drivers[0];
  const label = M[DRIVER_KEY[top.metric]].short || M[DRIVER_KEY[top.metric]].label;
  const head = top.impact < 0 ? `${label} is holding you back` : `${label} is carrying your recovery`;
  const lines = drivers.slice(0, 2).map(x => describeDelta(DRIVER_KEY[x.metric], idx)).filter(Boolean);
  const t = tierOf(d.recovery.score);
  const advice = {
    good: `You’re primed for a hard session. Aim for ${t.strain} strain.`,
    fair: `Keep it steady today, around ${t.strain} strain.`,
    poor: `Keep strain ${t.strain} and protect tonight’s sleep.`,
  }[t.cls];
  return { head, body: `${lines.join(' ')} ${advice}` };
}

// ---------- Home ----------
function weekWindow(idx) {
  const out = [];
  for (let i = Math.max(0, idx - 6); i <= idx; i++) out.push(i);
  return out;
}

let lastStripIdx = null;
function weekStrip() {
  const C = 2 * Math.PI * 10;
  const moved = lastStripIdx !== null && lastStripIdx !== state.idx;
  lastStripIdx = state.idx;
  // Every day, in a strip you can swipe all the way back through.
  const all = days().map((_, i) => i);
  return `<div class="week-wrap"><nav class="week" aria-label="Days">${all.map(i => {
    const d = days()[i];
    const rec = M.recovery.pick(d);
    const t = tierOf(rec);
    const arc = isNum(rec)
      ? `<circle class="arc" cx="13" cy="13" r="10" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - rec / 100)}" style="stroke:${t.color}"/>`
      : '';
    return `<a class="wday ${i === state.idx && moved ? 'bounce' : ''}" href="${hrefHome(d.date)}" data-replace ${i === state.idx ? 'aria-current="date"' : ''}
        aria-label="${esc(longDate(d.date))}${isNum(rec) ? `, recovery ${rec}%` : ''}">
      <span class="label">${parseDate(d.date).getDate() === 1 ? fmtDate(d.date, { month: 'short' }) : fmtDate(d.date, { weekday: 'short' })}</span>
      <span class="wday-num">${parseDate(d.date).getDate()}</span>
      <svg class="wday-ring" viewBox="0 0 26 26" aria-hidden="true"><circle class="track" cx="13" cy="13" r="10"/>${arc}</svg>
    </a>`;
  }).join('')}</nav></div>`;
}

function strainWord(s) {
  return s >= 14 ? 'Hard' : s >= 10 ? 'Moderate' : s >= 5 ? 'Light' : 'Rest';
}

// Recovery, sleep and strain as three concentric rings (outer to inner), with
// the numbers beside them. Each legend row opens its metric.
function dials(d) {
  const rec = M.recovery.pick(d);
  const t = tierOf(rec);
  const sl = d.sleep;
  const score = sl.score;
  const st = d.strain.score;
  const isLatest = relativeDay(d.date) === 'Today';
  const num = (v, dp, k) => `<span data-num="${v}" data-dp="${dp}" data-key="${k}">${fmt(v, dp)}</span>`;
  const rings = [
    {
      key: 'recovery', name: 'Recovery', color: t ? t.color : 'var(--text-3)', frac: isNum(rec) ? rec / 100 : null,
      value: isNum(rec) ? `${num(rec, 0, 'dial-rec')}<small>%</small>` : '',
      sub: t ? t.word : d.cardiovascular.hrv_rmssd != null ? 'Calibrating' : 'Waiting',
      label: `Recovery ${isNum(rec) ? rec + '%' : 'not available yet'}`,
    },
    {
      key: 'sleepScore', name: 'Sleep', color: 'var(--sleep)', frac: isNum(score) ? score / 100 : null,
      value: isNum(score) ? `${num(score, 0, 'dial-sleep')}<small>%</small>` : '',
      sub: isNum(sl.duration_minutes) ? fmtDur(sl.duration_minutes) : 'No sleep',
      tag: isNum(score) && sl.score_source === 'estimate' ? 'Est.' : '',
      label: `Sleep score ${isNum(score) ? score + '%' : 'not available'}`,
    },
    {
      key: 'strain', name: 'Strain', color: 'var(--strain)', frac: isNum(st) ? st / 21 : null,
      value: isNum(st) ? `${num(st, 1, 'dial-strain')}<small>/21</small>` : '',
      sub: isNum(st) ? `${strainWord(st)}${isLatest ? ' so far' : ''}` : 'No heart rate',
      label: `Strain ${isNum(st) ? fmt(st, 1) + ' of 21' : 'not available'}`,
    },
  ];
  const SW = 15, GAP = 5;
  const arcs = rings.map((r, i) => {
    const R = 102 - SW / 2 - i * (SW + GAP);
    const C = 2 * Math.PI * R;
    const arc = isNum(r.frac)
      ? `<circle class="dial-arc" cx="110" cy="110" r="${R}" stroke-width="${SW}" style="stroke:${r.color};--c:${r.color}" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${C * (1 - Math.min(1, Math.max(0, r.frac)))}"/>`
      : '';
    return `<circle class="dial-track" cx="110" cy="110" r="${R}" stroke-width="${SW}" style="stroke:color-mix(in srgb, ${r.color} 14%, transparent)"/>${arc}`;
  }).join('');
  const rows = rings.map(r => `<a class="ring-row" style="--c:${r.color}" href="${hrefMetric(r.key, M[r.key].defaultRange, d.date)}" aria-label="${esc(r.label)}. Open details">
      <span class="ring-dot" aria-hidden="true"></span>
      <span class="ring-text">
        <span class="label ring-name">${r.name}${r.tag ? ` <span class="tag">${r.tag}</span>` : ''}</span>
        <span class="ring-value ${r.value ? '' : 'none'}">${r.value || '—'}</span>
        <span class="ring-sub">${esc(r.sub)}</span>
      </span>
    </a>`).join('');
  return `<section class="rings reveal" aria-label="Today at a glance">
    <div class="rings-art"><svg viewBox="0 0 220 220" aria-hidden="true">${arcs}</svg></div>
    <div class="rings-legend">${rows}</div>
  </section>`;
}

function insightCard(d) {
  const story = buildStory(d, state.idx);
  const rec = M.recovery.pick(d);
  const t = tierOf(rec);
  const rel = relativeDay(d.date);
  const chips = [
    t ? `<span class="chip">${ph('zap', '', 'duotone')}Aim for <b>${t.strain}</b> strain</span>` : '',
    isNum(d.sleep.duration_minutes) ? `<a class="chip" href="${hrefMetric('sleep', 'day', d.date)}">${ph('moon', '', 'duotone')}Slept <b>${fmtDur(d.sleep.duration_minutes)}</b></a>` : '',
    isNum(d.strain.steps) ? `<a class="chip" href="${hrefMetric('steps', 'day', d.date)}">${ph('footprints', '', 'duotone')}<b>${fmt(d.strain.steps)}</b> steps</a>` : '',
  ].join('');
  return `<section class="insight reveal" aria-label="Insight">
    <span class="insight-icon live" data-anim="sparkles">${ph('sparkles', '', 'duotone')}</span>
    <div class="insight-body">
      <span class="label insight-date">${esc(rel ? `${rel} · ${fullDate(d.date)}` : fullDate(d.date))}</span>
      <h1>${esc(story.head)}</h1>
      <p>${esc(story.body)}</p>
      <div class="chips">${chips}</div>
    </div>
  </section>`;
}

// 24-hour timeline: heart rate, with sleep and workouts marked.
function dayBlocks(d) {
  const blocks = [];
  const dayStart = parseDate(d.date).getTime();
  const toMin = t => Math.max(0, Math.min(1440, (t - dayStart) / 60000));
  const st = (d.sleep.hypnogram || []).filter(s => s.time && s.seconds);
  if (st.length) {
    const a = parseLocal(st[0].time).getTime();
    const last = st[st.length - 1];
    const b = parseLocal(last.time).getTime() + last.seconds * 1000;
    if (b > dayStart) blocks.push({ kind: 'sleep', from: toMin(a), to: toMin(b), label: 'Sleep', tip: `Sleep ${hhmm(new Date(a))}–${hhmm(new Date(b))}` });
  }
  const next = days()[state.idx + 1];
  const nst = next ? (next.sleep.hypnogram || []).filter(s => s.time && s.seconds) : [];
  if (nst.length && nst[0].time.slice(0, 10) === d.date) {
    const a = parseLocal(nst[0].time).getTime();
    blocks.push({ kind: 'sleep', from: toMin(a), to: 1440, label: 'Sleep', tip: `Sleep from ${hhmm(new Date(a))}` });
  }
  for (const w of d.strain.workouts || []) {
    const [h, m] = (w.time || '0:0').split(':').map(Number);
    const from = h * 60 + m;
    blocks.push({ kind: 'workout', from, to: Math.min(1440, from + (w.duration_minutes || 0)), label: w.name,
      tip: `${w.name} · ${w.time} · ${w.duration_minutes} min${w.avg_hr ? ` · ${w.avg_hr} bpm` : ''}` });
  }
  return blocks;
}

function myDayChart(w, d) {
  const H = 240, top = 26, bottom = 28, padL = 4, padR = 40;
  const plotB = H - bottom;
  const hr = d.strain.intraday_hr || [];
  const x = scale(0, 1440, padL, w - padR);
  const mins = hr.map(p => { const [h, m] = p.time.split(':').map(Number); return h * 60 + m; });
  const bpm = hr.map(p => p.bpm);
  const t = niceTicks(Math.min(...bpm, 50) - 5, Math.max(...bpm, 100) + 5, 3);
  const y = scale(t.lo, t.hi, plotB, top);
  const blocks = dayBlocks(d).map((b, i) => {
    const c = b.kind === 'sleep' ? 'var(--sleep)' : 'var(--strain)';
    const x1 = x(b.from), x2 = Math.max(x(b.to), x1 + 3);
    const lw = x2 - x1;
    return `<g class="band-in" style="animation-delay:${200 + i * 80}ms">
      <rect x="${x1}" y="${top - 18}" width="${lw}" height="${plotB - top + 18}" rx="6" style="fill:${c};fill-opacity:.12"/>
      <rect x="${x1}" y="${top - 18}" width="${lw}" height="3" rx="1.5" style="fill:${c}"/>
      ${lw > 44 ? `<text x="${x1 + 6}" y="${top - 4}" style="fill:${c};font-weight:600">${esc(b.label.length * 6.5 > lw - 8 ? b.label.slice(0, Math.max(1, Math.floor((lw - 14) / 6.5))) + '…' : b.label)}</text>` : ''}
      <rect class="hit" x="${x1}" y="${top - 18}" width="${lw}" height="16" data-tip="<b>${esc(b.tip)}</b>"/>
    </g>`;
  }).join('');
  const grid = t.ticks.map(v => `<line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${w - padR + 8}" y="${y(v) + 4}">${v}</text>`).join('');
  const pts = hr.map((p, i) => `${x(mins[i]).toFixed(1)},${y(p.bpm).toFixed(1)}`).join('L');
  const area = hr.length > 1 ? `<path class="area" d="M${x(mins[0])},${plotB}L${pts}L${x(mins[mins.length - 1])},${plotB}Z" fill="url(#hrFade)"/>` : '';
  const line = hr.length > 1 ? `<path class="draw" d="M${pts}" pathLength="1" style="fill:none;stroke:var(--heart);stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>` : '';
  const rhr = d.cardiovascular.rhr;
  const rhrLine = isNum(rhr) ? `<line class="goal" x1="${padL}" x2="${w - padR}" y1="${y(rhr)}" y2="${y(rhr)}"/>` : '';
  const xt = [[0, '12 AM'], [360, '6 AM'], [720, '12 PM'], [1080, '6 PM'], [1440, '12 AM']]
    .map(([m, lab], i) => `<text x="${x(m)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${lab}</text>`).join('');
  let now = '';
  if (relativeDay(d.date) === 'Today') {
    const n = new Date();
    const nx = x(n.getHours() * 60 + n.getMinutes());
    now = `<line x1="${nx}" x2="${nx}" y1="${top - 18}" y2="${plotB}" style="stroke:var(--text-2);stroke-width:1;stroke-dasharray:2 3"/><text x="${nx}" y="${top - 22}" text-anchor="middle" style="fill:var(--text-2);font-weight:600">NOW</text>`;
  }
  const xs = mins.map(m => x(m));
  const tips = hr.map(p => `<b>${p.bpm} bpm</b><span>${p.time}</span>`);
  const hovers = xs.map((xx, i) => `<g class="hover-mark"><line x1="${xx}" x2="${xx}" y1="${top}" y2="${plotB}" style="stroke:var(--line-strong)"/><circle cx="${xx}" cy="${y(bpm[i])}" r="4.5" style="fill:var(--heart);stroke:var(--card);stroke-width:2"/></g>`);
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Heart rate through the day">
    <defs><linearGradient id="hrFade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FF6F8E" stop-opacity=".32"/><stop offset="1" stop-color="#FF6F8E" stop-opacity="0"/></linearGradient></defs>
    ${grid}${blocks}${area}${rhrLine}${line}${now}${xt}
    ${hr.length ? hitStrips(xs, top, plotB - top, tips, null, hovers) : ''}
  </svg>`;
}

function myDayPanel(d) {
  const hr = (d.strain.intraday_hr || []).map(p => p.bpm);
  if (!hr.length) {
    return `<section class="panel reveal"><div class="panel-title"><span class="label">My Day</span></div><p class="empty">No heart rate recorded for this day.</p></section>`;
  }
  const avg = Math.round(mean(hr));
  const max = Math.max(...hr);
  return `<section class="panel reveal" aria-label="My day">
    <div class="panel-head">
      <div class="panel-title"><span class="label">My Day</span><b>${avg}<small>bpm avg</small></b></div>
      <div class="legend">
        <span><i style="background:var(--heart)"></i>Heart rate<b>${Math.min(...hr)}–${max}</b></span>
        <span><i style="background:var(--sleep)"></i>Sleep</span>
        <span><i style="background:var(--strain)"></i>Workouts<b>${(d.strain.workouts || []).length}</b></span>
      </div>
    </div>
    ${slot('myday', w => myDayChart(w, d))}
  </section>`;
}

// Recovery bars with the day's strain drawn over them: are you balancing load and rest?
function comboChart(w, idxs) {
  const H = 230, top = 14, bottom = 30, padL = 34, padR = 34;
  const plotB = H - bottom;
  const n = idxs.length;
  const step = (w - padL - padR) / n;
  const bw = Math.min(26, step * 0.56);
  const xs = idxs.map((_, k) => padL + step * (k + 0.5));
  const yR = scale(0, 100, plotB, top);
  const yS = scale(0, 21, plotB, top);
  const sel = idxs.indexOf(state.idx);
  const grid = [0, 50, 100].map(v => `<line class="grid-line" x1="${padL}" x2="${w - padR}" y1="${yR(v)}" y2="${yR(v)}"/><text x="${w - padR + 8}" y="${yR(v) + 4}">${v}%</text>`).join('')
    + [0, 7, 14, 21].map(v => `<text x="${padL - 8}" y="${yS(v) + 4}" text-anchor="end" style="fill:var(--strain)">${v}</text>`).join('');
  const bars = idxs.map((i, k) => {
    const v = M.recovery.pick(days()[i]);
    if (!isNum(v)) return '';
    const h = Math.max(3, plotB - yR(v));
    return `<rect class="bar-mark" x="${xs[k] - bw / 2}" y="${plotB - h}" width="${bw}" height="${h}" rx="${Math.min(6, bw / 2)}" style="fill:${tierOf(v).color};opacity:${k === sel ? 1 : 0.62};animation-delay:${k * 35}ms"/>`;
  }).join('');
  const sv = idxs.map(i => days()[i].strain.score);
  const pts = sv.map((v, k) => (isNum(v) ? `${xs[k].toFixed(1)},${yS(v).toFixed(1)}` : null)).filter(Boolean).join('L');
  const line = `<path class="draw" d="M${pts}" pathLength="1" style="fill:none;stroke:var(--strain);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round"/>`;
  const dots = sv.map((v, k) => (isNum(v) ? `<circle class="dot" cx="${xs[k]}" cy="${yS(v)}" r="${k === sel ? 5.5 : 3.5}" style="fill:${k === sel ? 'var(--text)' : 'var(--strain)'};stroke:var(--card);stroke-width:2;animation-delay:${300 + k * 35}ms"/>` : '')).join('');
  const labels = idxs.map(i => String(parseDate(days()[i].date).getDate()));
  const tips = idxs.map((i, k) => {
    const d = days()[i];
    const r = M.recovery.pick(d);
    return `<b>${isNum(r) ? `Recovery ${r}%` : 'No recovery'}</b><span>Strain ${isNum(sv[k]) ? fmt(sv[k], 1) : '--'} · ${longDate(d.date)}</span>`;
  });
  const hrefs = idxs.map(i => hrefHome(days()[i].date));
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Recovery and strain over the last ${n} days">
    ${grid}${bars}${line}${dots}${xLabels(xs, labels, H, sel)}${hitStrips(xs, top, plotB - top, tips, hrefs)}
  </svg>`;
}

function trendsPanel() {
  const idxs = [];
  for (let i = Math.max(0, state.idx - 13); i <= state.idx; i++) idxs.push(i);
  const recs = idxs.map(i => M.recovery.pick(days()[i]));
  const strains = idxs.map(i => days()[i].strain.score);
  return `<section class="panel reveal" aria-label="Strain and recovery">
    <div class="panel-head">
      <div class="panel-title"><span class="label">Strain &amp; Recovery · ${idxs.length} days</span><b>${isNum(mean(recs)) ? Math.round(mean(recs)) : '--'}<small>% avg recovery</small></b></div>
      <div class="legend">
        <span><i style="background:var(--good)"></i>Recovery</span>
        <span><i style="background:var(--strain);border-radius:50%"></i>Strain<b>${fmt(mean(strains), 1)} avg</b></span>
      </div>
    </div>
    ${slot('combo', w => comboChart(w, idxs))}
    <p class="note">Select a day to open it.</p>
  </section>`;
}

// "3.0 younger than your age" for the body age card.
function bioAgeDelta(b) {
  if (!b || b.status !== 'ok') return `<div class="delta">${b && b.status === 'calibrating' ? 'Calibrating' : ''}</div>`;
  const dir = b.delta < 0 ? 'younger' : b.delta > 0 ? 'older' : '';
  const cls = b.delta < 0 ? 'good' : b.delta > 0 ? 'poor' : '';
  return `<div class="delta ${cls}">${dir ? `${fmt(Math.abs(b.delta), 1)} ${dir} than your age` : 'Same as your age'}</div>`;
}

function metricCard(key, { wide = false } = {}) {
  const m = M[key];
  const d = day();
  const v = m.pick(d);
  const iso = d.date;
  const win = weekWindow(state.idx);
  const vals = win.map(i => m.pick(days()[i]));
  // A recorded night with no score was logged without sleep stages (Fitbit usually doesn't score those either).
  const missing = key === 'sleepScore' && isNum(d.sleep.duration_minutes) ? 'No score for this night' : 'No data';
  const value = isNum(v) ? `<div class="card-value">${valueHtml(key, v, 'home-' + key)}</div>` : `<div class="card-value none">${missing}</div>`;
  const estimated = isNum(v) && m.isEstimate && m.isEstimate(d);
  let extra = '';
  if (key === 'sleep' && isNum(v)) {
    const sl = d.sleep;
    const mins = { wake: sl.wake_min, rem: sl.rem_min, light: sl.light_min, deep: sl.deep_min };
    extra = `<div class="stage-strip" aria-hidden="true">${STAGES.map(s => `<span style="flex-grow:${mins[s.key] || 0};background:${s.color}"></span>`).join('')}</div>
      <div class="legend">${STAGES.map(s => `<span><i style="background:${s.color}"></i>${s.label}<b>${fmtDur(mins[s.key])}</b></span>`).join('')}</div>`;
  }
  return `<a class="card reveal ${wide ? 'wide' : ''}" href="${hrefMetric(key, m.defaultRange, iso)}" style="--accent:${accent(key)}" aria-label="${esc(m.label)}: ${esc(valueText(key, v))}${estimated ? ', estimated' : ''}. Open details">
    <div class="card-top">${glyph(key, d)}<span class="card-label">${esc(m.cardLabel || m.label)}</span>${estimated ? '<span class="tag" title="Estimated: Google’s API doesn’t provide Fitbit’s sleep score">Est.</span>' : ''}${icon('chev', 'chev')}</div>
    ${value}
    ${key === 'bioAge' ? bioAgeDelta(d.bio_age) : deltaHtml(key, state.idx, window.matchMedia('(max-width: 720px)').matches)}
    ${extra || `<div class="spark">${slot('spark-' + key, w => sparkChart(w, key, vals, vals.length - 1))}</div>`}
  </a>`;
}

function workoutIcon(name) {
  const a = activityNamed(name);
  if (a) return a.icon;
  if (/(cycl|bike|spin)/i.test(name)) return 'bike';
  if (/(run|treadmill|jog)/i.test(name)) return 'run';
  if (/(walk|hike)/i.test(name)) return 'footprints';
  if (/(swim)/i.test(name)) return 'swim';
  if (/(table tennis|ping|badminton|tennis|squash)/i.test(name)) return 'ping-pong';
  if (/(football|soccer|sport|basket|cricket|volley|rugby)/i.test(name)) return 'volleyball';
  if (/(danc|aerobic|yoga|pilates)/i.test(name)) return 'person-standing';
  return 'dumbbell';
}

const endTime = w => {
  const [h, m] = (w.time || '0:0').split(':').map(Number);
  const t = h * 60 + m + (w.duration_minutes || 0);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// One tappable row per workout: icon, name, when, and its own strain.
function workoutRow(iso, i, w, { showDate = false } = {}) {
  const meta = [showDate ? shortDate(iso) : null, showDate ? w.time : `${w.time}–${endTime(w)}`, `${w.duration_minutes} min`].filter(Boolean).join(' · ');
  return `<a class="workout" href="${hrefWorkout(iso, i)}">
      <span class="glyph" style="--accent:var(--strain)">${ph(workoutIcon(w.name), '', 'duotone')}</span>
      <div class="workout-main"><div class="workout-name">${esc(w.name)}</div><div class="workout-meta">${esc(meta)}</div></div>
      <div class="workout-strain">${isNum(w.strain) ? `<b>${fmt(w.strain, 1)}</b><span class="label">strain</span>` : `<b>${w.duration_minutes}</b><span class="label">min</span>`}</div>
      ${icon('chev', 'workout-chev')}
    </a>`;
}

function workoutsCard() {
  const ws = day().strain.workouts || [];
  const body = ws.length ? `<div class="workouts">${ws.map((w, i) => workoutRow(day().date, i, w)).join('')}</div>` : '<p class="empty">No workouts logged.</p>';
  return `<div class="card full reveal" style="--accent:var(--strain)">
    <div class="card-top"><span class="glyph">${ph('dumbbell', '', 'duotone')}</span><span class="card-label">Workouts</span></div>
    ${body}
  </div>`;
}

// Workouts on the Strain pages: the selected day's, then the recent ones.
function workoutsPanel(iso, range) {
  const idx = dateIndex(iso);
  const today = (days()[idx].strain.workouts || []).map((w, i) => workoutRow(iso, i, w));
  const recent = [];
  for (let i = idx - 1; i >= 0 && recent.length < 8 && i >= idx - 30; i--) {
    const d = days()[i];
    (d.strain.workouts || []).forEach((w, k) => { if (recent.length < 8) recent.push(workoutRow(d.date, k, w, { showDate: true })); });
  }
  const label = relativeDay(iso) || longDate(iso);
  return `<section class="panel" style="--accent:var(--strain)">
    <div class="panel-title"><span class="label">Workouts · ${esc(label)}</span></div>
    ${today.length ? `<div class="workouts">${today.join('')}</div>` : '<p class="empty">No workouts on this day.</p>'}
    ${recent.length ? `<div class="panel-title"><span class="label">Recent workouts</span></div><div class="workouts">${recent.join('')}</div>` : ''}
  </section>`;
}

// Zone time: "8 min 42 s" from minutes with one decimal.
const fmtZone = min => {
  const sec = Math.round(min * 60);
  if (sec < 60) return `${sec} s`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return sec % 60 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${sec / 60} min`;
};

// Fitbit's zones (Active Zone Minutes): share of heart-rate reserve.
const ZONE_ROWS = [
  ['light', 'Light', 'var(--z-light)', 0, 0.4],
  ['moderate', 'Moderate', 'var(--z-moderate)', 0.4, 0.6],
  ['vigorous', 'Vigorous', 'var(--z-vigorous)', 0.6, 0.85],
  ['peak', 'Peak', 'var(--z-peak)', 0.85, 1],
];
const zoneOf = (bpm, rhr, maxHr) => {
  const hrr = (bpm - rhr) / (maxHr - rhr);
  return [...ZONE_ROWS].reverse().find(([, , , lo]) => hrr >= lo) || ZONE_ROWS[0];
};

// "Light · 42% · 28 m" with a full-width bar, as in the Fitbit app.
function zoneBars(z, rhr, maxHr) {
  const total = ZONE_ROWS.reduce((a, [k]) => a + (z[k] || 0), 0) || 1;
  return `<div class="zones">${ZONE_ROWS.map(([k, lab, c, f0, f1]) => {
    const v = z[k] || 0;
    const pct = Math.round(v / total * 100);
    const range = isNum(rhr) ? (k === 'peak' ? `${Math.round(rhr + f0 * (maxHr - rhr))}+ bpm` : `${k === 'light' ? 'under ' : `${Math.round(rhr + f0 * (maxHr - rhr))}–`}${Math.round(rhr + f1 * (maxHr - rhr))} bpm`) : '';
    return `<div class="zone">
      <div class="zone-head"><b>${lab}</b><span>· ${pct}% · ${fmtZone(v)}</span><em>${range}</em></div>
      <div class="zone-track"><i style="width:${v / total * 100}%;background:${c}"></i></div>
    </div>`;
  }).join('')}</div>`;
}

// Heart rate through a workout, the line coloured by the zone it is in, with
// dotted lines where each zone starts (after the Fitbit app's workout chart).
function workoutChart(w, rhr, maxHr) {
  return width => {
    const H = 240, top = 14, bottom = 30, padL = 4, padR = 40;
    const plotB = H - bottom;
    const pts = w.hr_t.map((t, i) => ({ s: t, bpm: w.hr_bpm[i] }));
    const dur = Math.max(1, w.duration_minutes);
    const x = scale(0, dur * 60, padL, width - padR);
    const bpm = pts.map(p => p.bpm);
    const haveZones = isNum(rhr) && maxHr > rhr;
    const zoneBpm = f => rhr + f * (maxHr - rhr);
    const lo = Math.min(...bpm) - 12;
    const hi = Math.max(Math.max(...bpm), haveZones ? zoneBpm(0.85) : 0) + 8;
    const t = niceTicks(lo, hi, 4);
    const y = scale(t.lo, t.hi, plotB, top);
    const grid = t.ticks.map(v => `<text x="${width - padR + 8}" y="${y(v) + 4}">${v}</text>`).join('');
    const thresholds = haveZones ? ZONE_ROWS.slice(1).map(([, , c, f0]) => {
      const yy = y(zoneBpm(f0));
      return yy >= top && yy <= plotB ? `<line x1="${padL}" x2="${width - padR}" y1="${yy}" y2="${yy}" style="stroke:${c};stroke-width:2;stroke-dasharray:0.1 7;stroke-linecap:round;opacity:.85"/>` : '';
    }).join('') : '';
    // One path per run of readings in the same zone; each run starts at the
    // previous reading so the line stays continuous.
    const segs = [];
    let cur = null;
    pts.forEach((p, i) => {
      const color = haveZones ? zoneOf(p.bpm, rhr, maxHr)[2] : 'var(--heart)';
      if (!cur || cur.color !== color) {
        cur = { color, d: i ? [`${x(pts[i - 1].s).toFixed(1)},${y(pts[i - 1].bpm).toFixed(1)}`] : [] };
        segs.push(cur);
      }
      cur.d.push(`${x(p.s).toFixed(1)},${y(p.bpm).toFixed(1)}`);
    });
    const sw = pts.length > 400 ? 1.6 : 2.2;
    const lines = segs.filter(g => g.d.length > 1).map(g => `<path d="M${g.d.join('L')}" style="fill:none;stroke:${g.color};stroke-width:${sw};stroke-linejoin:round;stroke-linecap:round"/>`).join('');
    const peakPt = pts[bpm.indexOf(Math.max(...bpm))];
    const peak = `<circle class="dot" cx="${x(peakPt.s)}" cy="${y(peakPt.bpm)}" r="5" style="fill:var(--text);stroke:var(--card);stroke-width:2"/>`;
    const clock = sec => {
      const [h, m] = w.time.split(':').map(Number);
      const tot = h * 60 + m + Math.round(sec / 60);
      return `${String(Math.floor(tot / 60) % 24).padStart(2, '0')}:${String(tot % 60).padStart(2, '0')}`;
    };
    const xt = [[0, 'start'], [dur * 30, 'middle'], [dur * 60, 'end']]
      .map(([sec, anchor]) => `<line x1="${x(sec)}" x2="${x(sec)}" y1="${plotB + 2}" y2="${plotB + 7}" style="stroke:var(--text-3)"/><text x="${x(sec)}" y="${H - 6}" text-anchor="${anchor}">${clock(sec)}</text>`).join('');
    const stepN = Math.max(1, Math.ceil(pts.length / 240));
    const hitPts = pts.filter((_, i) => i % stepN === 0);
    const xs = hitPts.map(p => x(p.s));
    const tips = hitPts.map(p => `<b>${p.bpm} bpm</b><span>${clock(p.s)}${haveZones ? ` · ${zoneOf(p.bpm, rhr, maxHr)[1]}` : ''}</span>`);
    const hovers = hitPts.map((p, i) => `<g class="hover-mark"><line x1="${xs[i]}" x2="${xs[i]}" y1="${top}" y2="${plotB}" style="stroke:var(--line-strong)"/><circle cx="${xs[i]}" cy="${y(p.bpm)}" r="4.5" style="fill:${haveZones ? zoneOf(p.bpm, rhr, maxHr)[2] : 'var(--heart)'};stroke:var(--card);stroke-width:2"/></g>`);
    return `<svg class="chart wchart" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Heart rate during ${esc(w.name)}, coloured by zone">
      ${thresholds}${grid}<g class="wline">${lines}</g>${peak}${xt}${hitStrips(xs, top, plotB - top, tips, null, hovers)}
    </svg>`;
  };
}

// One sentence about the session, like the Fitbit app's summary.
function workoutSummary(w) {
  const z = w.fitbit_zones || w.zone_minutes;
  if (!z) return '';
  const total = ZONE_ROWS.reduce((a, [k]) => a + (z[k] || 0), 0);
  if (!total) return '';
  const [k, lab] = ZONE_ROWS.reduce((best, row) => ((z[row[0]] || 0) > (z[best[0]] || 0) ? row : best));
  const share = z[k] / total;
  const portion = share > 0.9 ? 'Nearly all of' : share > 0.6 ? 'Most of' : share > 0.5 ? 'Over half of' : 'The largest share of';
  const hard = (z.vigorous || 0) + (z.peak || 0);
  const tail = hard >= 1 ? `, with ${fmtZone(hard)} vigorous or harder` : ', with no time in the vigorous or peak zones';
  return `${portion} your ${w.duration_minutes}-minute session was in the ${lab.toLowerCase()} zone${tail}${isNum(w.strain) ? `, for ${fmt(w.strain, 1)} strain` : ''}.`;
}

function renderWorkout() {
  const d = day();
  const iso = d.date;
  const w = d.strain.workouts[state.route.index];
  const rhr = d.cardiovascular.rhr;
  const maxHr = state.data.profile.zone_max_hr || state.data.profile.max_hr;
  document.documentElement.style.setProperty('--mood', 'var(--strain)');

  const big = [
    { label: 'Strain', value: isNum(w.strain) ? fmt(w.strain, 1) : '--', sub: 'this workout', accent: true },
    { label: 'Duration', value: `${w.duration_minutes} min`, sub: `${w.time}–${endTime(w)}` },
    { label: 'Calories', value: w.calories ? `${fmt(w.calories)} cal` : '--' },
    { label: 'Average HR', value: isNum(w.avg_hr_measured) ? `${w.avg_hr_measured} bpm` : w.avg_hr ? `${w.avg_hr} bpm` : '--' },
    { label: 'Peak HR', value: isNum(w.peak_hr) ? `${w.peak_hr} bpm` : '--', sub: isNum(w.peak_hr) ? `${Math.round(w.peak_hr / maxHr * 100)}% of max` : '' },
  ];
  const head = `<div class="w-stats">${big.map(b => `<div class="w-stat ${b.accent ? 'accent' : ''}"><div class="stat-label">${esc(b.label)}</div><div class="w-stat-value">${statValue(b.value)}</div>${b.sub ? `<div class="stat-sub">${esc(b.sub)}</div>` : ''}</div>`).join('')}</div>`;

  const perSecond = w.hr_resolution === 'second';
  const chart = w.hr_t && w.hr_t.length > 1
    ? slot('workout', workoutChart(w, rhr, maxHr)) + `<div class="legend zone-legend">${ZONE_ROWS.map(([, lab, c]) => `<span><i style="background:${c};border-radius:50%"></i>${lab}</span>`).join('')}</div><p class="note">${perSecond ? `Every heart-rate reading (${fmt(w.hr_t.length)}, about one every ${Math.max(1, Math.round(w.duration_minutes * 60 / w.hr_t.length))} s)` : 'Heart rate each minute (no raw readings for this day)'}. The line's colour shows your zone; dotted lines mark where moderate (40%), vigorous (60%) and peak (85%) start, as shares of the range between your resting ${isNum(rhr) ? rhr : '--'} and maximum ${maxHr} bpm. The white dot is your peak.</p>`
    : '<p class="empty">No heart rate was recorded during this workout.</p>';

  // Fitbit's own zone times when the API has them (they match the Fitbit app exactly).
  const z = w.fitbit_zones || w.zone_minutes;
  const zones = z ? `<section class="panel"><div class="panel-title"><span class="label">Time in each zone</span></div>${zoneBars(z, rhr, maxHr)}<p class="note">${w.fitbit_zones ? 'Zone times from Fitbit, as in the Fitbit app.' : 'Zone times worked out from your heart-rate readings.'}</p></section>` : '';

  const extras = [];
  const drop = v => `${v > 0 ? '−' : v < 0 ? '+' : ''}${Math.abs(v)} bpm`;
  if (isNum(w.hr_recovery_60)) extras.push({ label: 'Recovery · 1 min', value: drop(w.hr_recovery_60), sub: 'drop after you stopped' });
  if (isNum(w.hr_recovery)) extras.push({ label: 'Recovery · 2 min', value: drop(w.hr_recovery), sub: 'drop after you stopped' });
  if (w.distance_km) extras.push({ label: 'Distance', value: `${fmt(w.distance_km, 2)} km` });
  if (w.distance_km && w.duration_minutes) {
    const pace = w.duration_minutes / w.distance_km;
    extras.push({ label: 'Pace', value: `${Math.floor(pace)}:${String(Math.round((pace % 1) * 60)).padStart(2, '0')} /km` });
  }
  if (w.steps) extras.push({ label: 'Steps', value: fmt(w.steps) });
  if (w.elevation_m) extras.push({ label: 'Elevation gain', value: `${fmt(w.elevation_m)} m` });
  if (isNum(w.active_zone_minutes)) extras.push({ label: 'Active Zone Minutes', value: String(w.active_zone_minutes), sub: 'from Fitbit' });

  // Same kind of workout before this one.
  const past = [];
  for (let i = state.idx; i >= 0 && past.length < 6; i--) {
    const dd = days()[i];
    (dd.strain.workouts || []).forEach((x, k) => {
      if (x.name === w.name && !(i === state.idx && k === state.route.index) && (i < state.idx || k < state.route.index) && past.length < 6) past.push([dd.date, k, x]);
    });
  }
  let compare = '';
  if (past.length) {
    const avg = f => { const v = past.map(([, , x]) => f(x)).filter(isNum); return v.length ? mean(v) : null; };
    const cmp = (label, mine, theirs, unit, dp = 0) => (isNum(mine) && isNum(theirs)
      ? `<div class="cmp"><span>${label}</span><b>${fmt(mine, dp)}${unit}</b><em class="${mine >= theirs ? 'up' : 'down'}">${mine >= theirs ? '+' : '−'}${fmt(Math.abs(mine - theirs), dp)} vs usual</em></div>` : '');
    compare = `<section class="panel"><div class="panel-title"><span class="label">Compared with your last ${past.length} ${esc(w.name.toLowerCase())} session${past.length > 1 ? 's' : ''}</span></div>
      <div class="cmps">
        ${cmp('Strain', w.strain, avg(x => x.strain), '', 1)}
        ${cmp('Duration', w.duration_minutes, avg(x => x.duration_minutes), ' min')}
        ${cmp('Average HR', w.avg_hr_measured, avg(x => x.avg_hr_measured), ' bpm')}
        ${cmp('Peak HR', w.peak_hr, avg(x => x.peak_hr), ' bpm')}
      </div>
      <div class="workouts">${past.map(([dt, k, x]) => workoutRow(dt, k, x, { showDate: true })).join('')}</div>
    </section>`;
  }

  return `
    <div class="detail-head">
      <a class="back" href="${hrefMetric('strain', 'day', iso)}" aria-label="Back to strain">${icon('back')}<span>Strain</span></a>
      <h1 class="detail-title"><span class="glyph" style="--accent:var(--strain)">${ph(workoutIcon(w.name), '', 'duotone')}</span><span>${esc(w.name)}</span></h1>
    </div>
    <p class="w-when">${esc(fullDate(iso))} · ${esc(w.time)}–${esc(endTime(w))}</p>
    ${workoutSummary(w) ? `<p class="w-summary">${esc(workoutSummary(w))}</p>` : ''}
    ${head}
    <section class="panel" style="--accent:var(--heart)"><div class="panel-title"><span class="label">Heart rate</span></div>${chart}</section>
    ${zones}
    ${extras.length ? statCards(extras) : ''}
    ${compare}
    ${w.logged_in_app && w.id && window.DataStrapHost && window.DataStrapHost.deleteWorkout
      ? `<button type="button" class="w-delete" data-delete-workout="${esc(w.id)}">${ph('trash')}Delete this workout</button>
         <p class="note w-delete-note">Logged from DataStrap. Deleting removes it from Google Health and the Fitbit app too.</p>` : ''}
  `;
}

const HOME_SECTIONS = [
  { title: 'Key metrics', keys: ['bioAge', 'vo2', 'hrv', 'rhr', 'resp', 'spo2', 'temp', 'stress', 'hr'] },
  { title: 'Sleep', keys: ['sleep', 'sleepScore', 'efficiency'] },
  { title: 'Activity', keys: ['steps', 'energy', 'strain', 'zones'], workouts: true },
];

function renderHome() {
  const d = day();
  const rec = M.recovery.pick(d);
  const t = tierOf(rec);
  document.documentElement.style.setProperty('--mood', t ? t.color : 'var(--text-3)');

  const sections = HOME_SECTIONS.map(sec => `<section class="section">
      <div class="section-head"><h2>${sec.title}</h2></div>
      <div class="grid">${sec.keys.map(k => metricCard(k, { wide: k === 'sleep' })).join('')}${sec.workouts ? workoutsCard() : ''}</div>
    </section>`).join('');

  return `
    ${weekStrip()}
    ${dials(d)}
    ${insightCard(d)}
    ${myDayPanel(d)}
    ${sections}
    <section class="section"><div class="section-head"><h2>Trends</h2></div>${trendsPanel()}</section>
    ${canLog() ? `<button type="button" class="log-fab" data-log-open aria-label="Log an activity">Log ${ph('plus', '', 'bold')}</button>` : ''}
  `;
}

// ---------- Log + (log a workout to Google Health) ----------
// Every exercise type the Google Health API accepts, named as in the Fitbit
// app where it has a name, grouped into families for the icon and the
// "similar activities" chips. `TYPE` alone gets a sentence-case label.
const ACTIVITY_FAMILIES = [
  ['walk', 'walk', true, 'WALKING:Walk|INCLINE_WALK|NORDIC_WALKING|POWER_WALKING:Power walk|RUCKING|TREADMILL_WALK|WALK_WITH_WEIGHTS|STROLLER_WALK|HIKING:Hike|BACKPACKING|ORIENTEERING'],
  ['run', 'run', true, 'RUNNING:Run|TREADMILL:Treadmill run|TRAIL_RUN|INCLINE_RUN|TRACK_AND_FIELD'],
  ['bike', 'bike', true, 'BIKING:Bike|OUTDOOR_BIKE|MOUNTAIN_BIKE|STATIONARY_BIKE|SPINNING|ELECTRIC_BIKE:E-bike|ASSAULT_BIKE|HAND_CYCLING|UNICYCLING'],
  ['swim', 'swim', true, 'SWIMMING:Swim|SWIMMING_POOL:Pool swim|SWIMMING_OPEN_WATER:Open water swim|WATER_AEROBICS|WATER_JOGGING|WATER_POLO|WATER_VOLLEYBALL|SYNCHRONIZED_SWIMMING|DIVING|SCUBA_DIVING|SNORKELING'],
  ['strength', 'dumbbell', false, 'WEIGHTS|WEIGHT_MACHINES|FREE_WEIGHTS|WEIGHTLIFTING|STRENGTH_TRAINING|FUNCTIONAL_STRENGTH_TRAINING:Functional strength|POWERLIFTING|BODY_WEIGHT:Bodyweight|CALISTHENICS|CORE_TRAINING|RESISTANCE_BANDS|TRX:TRX|CROSSFIT:CrossFit|CIRCUIT_TRAINING|BOOTCAMP'],
  ['cardio', 'flame', false, 'WORKOUT|HIIT:HIIT|INTERVAL_WORKOUT|TABATA_WORKOUT:Tabata|AEROBIC_WORKOUT|CARDIO_WORKOUT|CARDIO_SCULPT|CROSS_TRAINING|ELLIPTICAL|ROWING_MACHINE|STAIRCLIMBER:Stair climber|STEP_TRAINING|JUMPING_ROPE:Jump rope|EXERCISE_CLASS|OUTDOOR_WORKOUT|FITNESS_GAMING|TRAMPOLINE|MULTISPORT'],
  ['mind', 'yoga', false, 'YOGA|YOGA_VINYASA:Vinyasa yoga|YOGA_HATHA:Hatha yoga|YOGA_POWER:Power yoga|YOGA_BIKRAM:Bikram yoga|PILATES|BARRE_CLASS:Barre|STRETCHING|TAI_CHI|MEDITATE:Meditation'],
  ['dance', 'dance', false, 'DANCING|ZUMBA|HIP_HOP:Hip hop|BALLET|BALLROOM_DANCE|JAZZ_DANCE|MODERN_DANCE|TANGO|BREAKDANCING|CHEERLEADING|GYMNASTICS'],
  ['combat', 'boxing', false, 'BOXING|KICKBOXING|MARTIAL_ARTS|KARATE|TAEKWONDO|JIU_JITSU:Jiu-jitsu|MUAY_THAI:Muay Thai|WRESTLING|FENCING'],
  ['racket', 'tennis', false, 'TENNIS|TABLE_TENNIS|BADMINTON|SQUASH|PADEL|PICKELBALL:Pickleball|RACQUETBALL|RACKET_SPORTS'],
  ['team', 'volleyball', false, 'SOCCER:Football|BASKETBALL|CRICKET|VOLLEYBALL|VOLLEYBALL_BEACH:Beach volleyball|HOCKEY|FIELD_HOCKEY|RUGBY|HANDBALL|BASEBALL|SOFTBALL|LACROSSE|FOOTBALL_AMERICAN:American football|FOOTBALL_AUSTRALIAN:Australian football|ULTIMATE_FRISBEE|FRISBEE_PLAYING_GENERAL:Frisbee|POLO|GOLF|BOWLING|BILLIARDS|CROQUET|CURLING|ARCHERY|SHOOTING|SPORT'],
  ['water', 'boat', true, 'ROWING|KAYAKING|CANOEING|PADDLEBOARDING|SURFING|SAILING|WINDSURFING|KITESURFING|WAKEBOARDING|WATER_SKIING|FOILING|WATER_SPORT'],
  ['snow', 'snow', true, 'SKIING|CROSS_COUNTRY_SKI:Cross-country skiing|SNOWBOARDING|SNOWSHOEING|SNOWMOBILING|SNOW_SPORT|ICE_SKATING|SPEED_SKATING|SKATING|ROLLER_SKATING|ROLLERBLADING|SKATEBOARDING|SCOOTERING:Scooter|ELECTRIC_SCOOTER:E-scooter'],
  ['outdoor', 'mountain', false, 'CLIMBING|ROCK_CLIMBING|INDOOR_CLIMBING|PARKOUR|EQUESTRIAN_SPORTS:Horse riding|PARAGLIDING|SKYDIVING|HUNTING|FISHING|MOTOCROSS|MOTORCYCLE:Motorcycling'],
  ['everyday', 'chores', false, 'HOUSEHOLD_CHORES|CLEANING|GARDENING|MOWING_LAWN:Mowing|WEEDING|HOEING|SHOVELING|CARPENTRY|PAINTING|MUSICAL_PERFORMANCE|WHEELCHAIR|OTHER'],
];
// Extra words people search with, per family.
const ACTIVITY_WORDS = {
  walk: 'walking steps', run: 'running jog jogging', bike: 'cycling cycle bicycle', swim: 'swimming pool',
  strength: 'gym lifting lift resistance', cardio: 'gym cardio interval', mind: 'stretch mobility breathing',
  combat: 'fight fighting', racket: 'racquet', team: 'sport ball', water: 'boat paddle', snow: 'winter skate', outdoor: 'climb',
};
const ACTIVITIES = ACTIVITY_FAMILIES.flatMap(([family, icon, distance, list]) => list.split('|').map(entry => {
  const [type, name] = entry.split(':');
  const label = name || type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
  return { type, label, family, icon, distance, words: `${label} ${type.replace(/_/g, ' ')} ${ACTIVITY_WORDS[family] || ''}`.toLowerCase() };
}));
const ACTIVITY_BY_LABEL = new Map(ACTIVITIES.map(a => [a.label.toLowerCase(), a]));
const activityNamed = name => ACTIVITY_BY_LABEL.get(String(name || '').toLowerCase()) || null;
const POPULAR = ['WALKING', 'RUNNING', 'WEIGHTS', 'BIKING', 'YOGA', 'HIIT', 'SWIMMING', 'SOCCER', 'BADMINTON'];

const canLog = () => Boolean(window.DataStrapHost && window.DataStrapHost.logWorkout && !state.demo);

// Activities this person has done, most frequent first (for the first chips).
function recentActivities() {
  const counts = new Map();
  for (const d of days().slice(-120)) {
    for (const w of d.strain.workouts || []) {
      const a = activityNamed(w.name);
      if (a) counts.set(a, (counts.get(a) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([a]) => a);
}

function activityChips(query, selected) {
  const q = query.trim().toLowerCase();
  let list;
  if (q && !(selected && q === selected.label.toLowerCase())) {
    const terms = q.split(/\s+/);
    list = ACTIVITIES.filter(a => terms.every(t => a.words.includes(t)))
      .sort((x, y) => (y.label.toLowerCase().startsWith(q) ? 1 : 0) - (x.label.toLowerCase().startsWith(q) ? 1 : 0));
  } else if (selected) {
    list = [selected, ...ACTIVITIES.filter(a => a.family === selected.family && a !== selected)];
  } else {
    const seen = new Set();
    list = [...recentActivities(), ...POPULAR.map(t => ACTIVITIES.find(a => a.type === t))].filter(a => !seen.has(a) && seen.add(a));
  }
  if (!list.length) return '<p class="log-empty">No activity matches. Try another word, or pick Other.</p>';
  const max = q && !(selected && q === selected.label.toLowerCase()) ? 24 : 9;
  return list.slice(0, max).map(a => `<button type="button" class="log-chip ${a === selected ? 'on' : ''}" data-type="${a.type}" aria-pressed="${a === selected}">
      ${ph(a === selected ? 'check' : a.icon, '', a === selected ? 'bold' : 'regular')}${esc(a.label)}</button>`).join('');
}

const pad2 = n => String(n).padStart(2, '0');
const localDateIso = t => `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;

function openLogSheet() {
  if (document.querySelector('.log-sheet')) return;
  const now = new Date();
  // Default: a 30-minute session that has just finished, on a 5-minute mark.
  const start = new Date(now.getTime() - 30 * 60000);
  start.setMinutes(Math.floor(start.getMinutes() / 5) * 5, 0, 0);
  let selected = recentActivities()[0] || ACTIVITIES.find(a => a.type === 'WALKING');
  const sheet = document.createElement('div');
  sheet.className = 'log-sheet';
  sheet.innerHTML = `<div class="log-scrim" data-log-close></div>
    <form class="log-panel" role="dialog" aria-modal="true" aria-labelledby="logTitle" novalidate>
      <div class="log-grab" aria-hidden="true"></div>
      <header class="log-head">
        <button type="button" class="icon-btn log-x" data-log-close aria-label="Close">${ph('x', '', 'bold')}</button>
        <h2 id="logTitle">Log activity</h2>
      </header>
      <label class="log-field">
        <span class="log-label">Activity</span>
        <span class="log-box"><span class="log-act-icon" aria-hidden="true"></span>
          <input name="q" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="Search ${ACTIVITIES.length} activities" aria-describedby="logChipsLabel">
          <span class="log-search-icon" aria-hidden="true">${ph('search')}</span></span>
      </label>
      <div class="log-sub" id="logChipsLabel">Suggested</div>
      <div class="log-chips"></div>
      <div class="log-when">
        <label class="log-field"><span class="log-label">Date</span>
          <span class="log-box">${ph('calendar')}<input name="date" type="date" required max="${localDateIso(now)}" value="${localDateIso(start)}"></span></label>
        <label class="log-field"><span class="log-label">Start time</span>
          <span class="log-box">${ph('clock')}<input name="time" type="time" required value="${pad2(start.getHours())}:${pad2(start.getMinutes())}"></span></label>
      </div>
      <label class="log-field"><span class="log-label">Duration</span>
        <span class="log-box">${ph('timer')}<input name="minutes" type="number" inputmode="numeric" min="1" max="1440" required value="30"><span class="log-unit">min</span></span></label>
      <div class="log-quick" role="group" aria-label="Quick durations">${[15, 30, 45, 60, 90].map(m => `<button type="button" class="log-chip small ${m === 30 ? 'on' : ''}" data-min="${m}">${m < 60 ? `${m} min` : `${m / 60 % 1 ? m / 60 : m / 60} h`.replace('1.5 h', '1½ h')}</button>`).join('')}</div>
      <details class="log-more">
        <summary>Optional information</summary>
        <div class="log-pair">
          <label class="log-field"><span class="log-label">Calories</span>
            <span class="log-box">${ph('flame')}<input name="calories" type="number" inputmode="numeric" min="0" max="10000" placeholder="—"><span class="log-unit">kcal</span></span></label>
          <label class="log-field log-distance"><span class="log-label">Distance</span>
            <span class="log-box">${ph('footprints')}<input name="distance" type="number" inputmode="decimal" min="0" max="1000" step="0.01" placeholder="—"><span class="log-unit">km</span></span></label>
        </div>
      </details>
      <p class="log-error" role="alert" hidden></p>
      <p class="log-note">Saved to Google Health, so it shows in the Fitbit app too.</p>
      <button type="submit" class="log-save">Save</button>
    </form>`;
  document.body.appendChild(sheet);
  document.body.classList.add('log-open');
  const form = sheet.querySelector('form');
  const q = form.elements.q;
  const chips = sheet.querySelector('.log-chips');
  const err = sheet.querySelector('.log-error');
  const save = sheet.querySelector('.log-save');
  const showErr = msg => { err.textContent = msg; err.hidden = !msg; };
  const sync = () => {
    sheet.querySelector('.log-act-icon').innerHTML = ph(selected ? selected.icon : 'search', '', 'duotone');
    sheet.querySelector('.log-sub').textContent = q.value.trim() && !(selected && q.value === selected.label) ? 'Matching activities' : selected ? 'Similar activities' : 'Suggested';
    chips.innerHTML = activityChips(q.value, selected);
    sheet.querySelector('.log-distance').hidden = !(selected && selected.distance);
    save.disabled = !selected;
  };
  q.value = selected ? selected.label : '';
  sync();

  const close = () => {
    sheet.classList.remove('open');
    document.body.classList.remove('log-open');
    setTimeout(() => sheet.remove(), 260);
  };
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
  q.addEventListener('focus', () => q.select());
  q.addEventListener('input', () => {
    if (selected && q.value !== selected.label) selected = null;
    showErr('');
    sync();
  });
  sheet.addEventListener('click', e => {
    if (e.target.closest('[data-log-close]')) { close(); return; }
    const chip = e.target.closest('[data-type]');
    if (chip) {
      selected = ACTIVITIES.find(a => a.type === chip.dataset.type);
      q.value = selected.label;
      showErr('');
      sync();
      return;
    }
    const quick = e.target.closest('[data-min]');
    if (quick) {
      form.elements.minutes.value = quick.dataset.min;
      sheet.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('on', b === quick));
    }
  });
  form.elements.minutes.addEventListener('input', () => {
    sheet.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('on', b.dataset.min === form.elements.minutes.value));
  });
  document.addEventListener('keydown', function esc(e) {
    if (!sheet.isConnected) { document.removeEventListener('keydown', esc); return; }
    if (e.key === 'Escape') close();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!selected) { showErr('Pick an activity from the list.'); return; }
    const f = form.elements;
    const minutes = Math.round(Number(f.minutes.value));
    const startAt = new Date(`${f.date.value}T${f.time.value}`);
    if (!f.date.value || !f.time.value || isNaN(startAt)) { showErr('Choose a date and start time.'); return; }
    if (!(minutes >= 1 && minutes <= 1440)) { showErr('Duration must be between 1 minute and 24 hours.'); return; }
    if (startAt.getTime() + minutes * 60000 > Date.now() + 60000) { showErr('That would end in the future. Check the start time and duration.'); return; }
    showErr('');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await window.DataStrapHost.logWorkout({
        type: selected.type, label: selected.label, start: startAt.toISOString(), minutes,
        utcOffsetS: -startAt.getTimezoneOffset() * 60,
        calories: Number(f.calories.value) || 0,
        distanceKm: selected.distance ? Number(f.distance.value) || 0 : 0,
      });
      close();
      toast(`${selected.label} logged. It’ll show in the Fitbit app too.`);
    } catch (error) {
      save.disabled = false;
      save.textContent = 'Save';
      showErr(error && error.message ? error.message : 'Couldn’t save. Check your connection and try again.');
    }
  });
}

// Two taps: the first arms the button, the second deletes.
async function deleteWorkout(btn) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.lastChild.textContent = 'Tap again to delete';
    setTimeout(() => { if (btn.isConnected && !btn.disabled) { btn.classList.remove('armed'); btn.lastChild.textContent = 'Delete this workout'; } }, 4000);
    return;
  }
  btn.disabled = true;
  btn.lastChild.textContent = 'Deleting…';
  const id = btn.dataset.deleteWorkout;
  // Leave the page first: the refresh after deleting re-renders the current
  // page, and this workout won't be in it any more.
  go(hrefMetric('strain', 'day', day().date), { replace: true });
  try {
    await window.DataStrapHost.deleteWorkout(id);
    toast('Workout deleted.');
  } catch (error) {
    toast(error && error.message ? error.message : 'Couldn’t delete. Try again.');
  }
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

// ---------- Detail ----------
function periodOf(range, iso) {
  const d = parseDate(iso);
  let start, end;
  if (range === 'day') { start = end = d; }
  else if (range === 'week') { start = addDays(d, -((d.getDay() + 6) % 7)); end = addDays(start, 6); }
  else if (range === 'month') { start = new Date(d.getFullYear(), d.getMonth(), 1); end = new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  else { start = new Date(d.getFullYear(), d.getMonth() - 2, 1); end = new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  const dates = [];
  for (let x = new Date(start); x <= end; x = addDays(x, 1)) dates.push(isoOf(x));
  return { start: isoOf(start), end: isoOf(end), dates };
}

// Move the anchor date by one period, landing on a day that has data.
function shiftAnchor(range, iso, dir) {
  const d = parseDate(iso);
  let t;
  if (range === 'day') t = addDays(d, dir);
  else if (range === 'week') t = addDays(d, 7 * dir);
  else {
    const months = range === 'month' ? 1 : 3;
    t = new Date(d.getFullYear(), d.getMonth() + months * dir, 1);
    if (dir > 0) {
      // Show the end of the new period if it's the latest one.
      t = new Date(t.getFullYear(), t.getMonth() + (range === '3m' ? 2 : 0) + 1, 0);
    }
  }
  const s = isoOf(t);
  if (s > days()[days().length - 1].date) return days()[days().length - 1].date;
  if (s < days()[0].date) return days()[0].date;
  return s;
}

function periodLabel(range, p) {
  if (range === 'day') return relativeDay(p.start) || longDate(p.start);
  if (range === 'week') {
    const sameMonth = p.start.slice(0, 7) === p.end.slice(0, 7);
    return `${shortDate(p.start)} – ${sameMonth ? fmtDate(p.end, { day: 'numeric' }) : shortDate(p.end)}`;
  }
  if (range === 'month') return fmtDate(p.start, { month: 'long', year: 'numeric' });
  return `${fmtDate(p.start, { month: 'short' })} – ${fmtDate(p.end, { month: 'short', year: 'numeric' })}`;
}

function axisLabelsFor(range, dates) {
  if (range === 'week') return dates.map(iso => fmtDate(iso, { weekday: 'narrow' }));
  if (range === 'month') return dates.map(iso => { const n = parseDate(iso).getDate(); return [1, 8, 15, 22, 29].includes(n) ? String(n) : ''; });
  return dates.map(iso => (parseDate(iso).getDate() === 1 ? fmtDate(iso, { month: 'short' }) : ''));
}

function periodSummary(key, vals) {
  const m = M[key];
  const present = vals.filter(isNum);
  if (!present.length) return null;
  return {
    avg: mean(present), total: sum(present), min: Math.min(...present), max: Math.max(...present), n: present.length,
  };
}

function renderDetail() {
  const { key, range } = state.route;
  const m = M[key];
  const iso = day().date;
  const color = accent(key);
  const rec = M.recovery.pick(day());
  const t = tierOf(rec);
  document.documentElement.style.setProperty('--mood', t ? t.color : 'var(--text-3)');

  const p = periodOf(range, iso);
  const firstDate = days()[0].date;
  const lastDate = days()[days().length - 1].date;
  const prevHref = p.start > firstDate ? hrefMetric(key, range, shiftAnchor(range, iso, -1)) : null;
  const nextHref = p.end < lastDate ? hrefMetric(key, range, shiftAnchor(range, iso, 1)) : null;

  const seg = `<nav class="segmented" aria-label="Time range" style="--n:${RANGES.length}">
    <span class="thumb" style="width:calc((100% - 6px) / ${RANGES.length});transform:translateX(${RANGES.findIndex(r => r.key === range) * 100}%)"></span>
    ${RANGES.map(r => `<a href="${hrefMetric(key, r.key, iso)}" data-replace aria-current="${r.key === range}" aria-label="${r.label}">${r.short ? `<span class="long">${r.label}</span><span class="short">${r.short}</span>` : r.label}</a>`).join('')}
  </nav>`;
  const periodNav = `<div class="period">
    <a class="icon-btn" ${prevHref ? `href="${prevHref}"` : 'aria-disabled="true"'} data-replace aria-label="Previous ${range === '3m' ? 'three months' : range}">${icon('back')}</a>
    <span class="period-label">${esc(periodLabel(range, p))}</span>
    <a class="icon-btn" ${nextHref ? `href="${nextHref}"` : 'aria-disabled="true"'} data-replace aria-label="Next ${range === '3m' ? 'three months' : range}">${icon('chev')}</a>
  </div>`;

  const body = range === 'day' ? detailDay(key, color) : detailPeriod(key, range, p, color);

  const workoutsHtml = key === 'strain' ? workoutsPanel(iso, range) : '';
  return `
    <div class="detail-head">
      <a class="back" href="${hrefHome(iso)}" aria-label="Back to ${esc(relativeDay(iso) || longDate(iso))}">${icon('back')}<span>${esc(relativeDay(iso) || 'Home')}</span></a>
      <h1 class="detail-title">${glyph(key)}<span>${esc(m.label)}</span></h1>
    </div>

    <section class="panel" style="--accent:${color}">
      <div class="controls">${seg}${periodNav}</div>
      ${body.panel}
    </section>
    ${workoutsHtml}
    ${body.after || ''}
    ${m.note ? `<p class="note">${esc(typeof m.note === 'function' ? m.note() : m.note)}</p>` : ''}
  `;
}

function headline(label, valueInner, note, noteCls = '', emptyText = 'No data') {
  return `<div class="headline">
    <div><div class="headline-label">${esc(label)}</div>
    <div class="headline-value ${valueInner ? '' : 'none'}">${valueInner || esc(emptyText)}</div></div>
    ${note ? `<div class="headline-note ${noteCls}">${esc(note)}</div>` : ''}
  </div>`;
}

// "61.0 ml/kg/min" → number with a smaller unit, so long units don't wrap on phones.
function statValue(v) {
  const m = /^([−\-]?[\d.,]+)\s+([^\d\s].*)$/.exec(String(v));
  return m ? `${esc(m[1])}<span class="u">${esc(m[2])}</span>` : esc(v);
}

function statCards(items) {
  return `<div class="stats">${items.map(s => `<div class="stat"><div class="stat-label">${esc(s.label)}</div><div class="stat-value">${statValue(s.value)}</div>${s.sub ? `<div class="stat-sub">${esc(s.sub)}</div>` : ''}</div>`).join('')}</div>`;
}

function hourLabels() {
  return Array.from({ length: 24 }, (_, h) => ({ 0: '12a', 6: '6a', 12: '12p', 18: '6p' }[h] || ''));
}
const BIO_UNITS = {
  vo2: v => `${fmt(v, 1)} ml/kg/min`, rhr: v => `${fmt(v, 0)} bpm`, steps: v => `${fmt(v, 0)} steps/day`,
  zone: v => `${fmt(v, 0)} min/week`, strength: v => `${fmt(v, 0)} min/week`, sleep: v => fmtDur(v * 60),
  sri: v => fmt(v, 0), bmi: v => fmt(v, 1),
};
const BIO_PEER_TEXT = { sleep: '7–8 h', bmi: '20–25', strength: 'none' };

function bioAgeDetail(d, idx) {
  const b = d.bio_age;
  if (!b) return '<p class="empty">Body age needs your age in your Google Health profile.</p>';
  if (b.status !== 'ok') {
    return `<p class="empty">Calibrating: body age needs at least three measures with enough data (14 days each), including VO₂ max or resting heart rate.${b.missing.length ? ` Still waiting on: ${esc(b.missing.join(', '))}.` : ''}</p>`;
  }
  const maxY = Math.max(0.5, ...b.drivers.map(x => Math.abs(x.years)));
  const rows = b.drivers.map(x => {
    const cls = x.years < -0.05 ? 'good' : x.years > 0.05 ? 'poor' : '';
    const w = Math.abs(x.years) / maxY * 50;
    const peer = BIO_PEER_TEXT[x.key] || BIO_UNITS[x.key](x.peer);
    return `<div class="row">
      <div class="row-main"><div class="row-title">${esc(x.label)}</div><div class="row-sub">You ${esc(BIO_UNITS[x.key](x.value))} · peers ${esc(peer)}</div></div>
      <div class="bio-bar" aria-hidden="true"><i style="${x.years < 0 ? `right:50%` : `left:50%`};width:${w}%;background:var(--${cls || 'text-3'})"></i><b></b></div>
      <div class="row-val ${cls}">${x.years > 0 ? '+' : x.years < 0 ? '−' : ''}${fmt(Math.abs(x.years), 1)} y</div></div>`;
  }).join('');
  const levers = b.levers.length ? `<div class="headline-label">What would move it</div><div class="rows">${b.levers.map(l => `<div class="row">
      <div class="row-main"><div class="row-title">${esc(l.label)}</div><div class="row-sub">${esc(BIO_UNITS[l.key](l.from))} → ${esc(BIO_UNITS[l.key](l.to))}</div></div>
      <div class="row-val good">−${fmt(Math.abs(l.years), 1)} y</div></div>`).join('')}</div>` : '';
  // Trend: body age over the last 90 days.
  const lo = Math.max(0, idx - 89);
  const win = [];
  for (let i = lo; i <= idx; i++) win.push(i);
  const vals = win.map(i => M.bioAge.pick(days()[i]));
  const trend = vals.filter(isNum).length > 1
    ? `<div class="headline-label">Last ${win.length} days</div>` + slot('bioTrend', w => lineChart(w, {
      key: 'bioAge', vals, labels: win.map(i => { const dt = parseDate(days()[i].date); return dt.getDate() === 1 ? fmtDate(days()[i].date, { month: 'short' }) : ''; }),
      color: 'var(--body)', tips: win.map((i, k) => `<b>${isNum(vals[k]) ? fmt(vals[k], 1) : '--'}</b><span>${longDate(days()[i].date)}</span>`),
      hrefs: win.map(i => hrefMetric('bioAge', 'day', days()[i].date)), selPos: vals.length - 1, H: 170, dots: false, baseline: b.chronological }))
    : '';
  return `<div class="headline-label">What’s moving it (years vs a typical ${b.chronological}-year-old)</div><div class="rows">${rows}</div>
    <p class="note">Positive years add to your body age, negative years take away. Activity measures count at half weight together and sleep measures at 80%, so overlapping habits aren’t counted twice.</p>
    ${levers}${trend}`;
}

const hourName = h => `${(h % 12) || 12}${h < 12 ? ' AM' : ' PM'}`;

function detailDay(key, color) {
  const m = M[key];
  const d = day();
  const idx = state.idx;
  const v = m.pick(d);
  const di = deltaInfo(key, idx);
  const r = normalRange(key, idx);
  let chart = '';
  let extra = '';

  if (m.intraday === 'hourly_steps' || m.intraday === 'hourly_calories') {
    const hourly = d.strain[m.intraday];
    if (hourly) {
      const tips = hourly.map((x, h) => `<b>${fmt(x)}${unitText(m.unit) || ' steps'}</b><span>${hourName(h)} – ${hourName((h + 1) % 24)}</span>`);
      const peak = hourly.indexOf(Math.max(...hourly));
      chart = slot('day', w => barChart(w, { key, vals: hourly, labels: hourLabels(), color, tips }));
      extra = statCards([
        { label: 'Most active hour', value: hourName(peak), sub: `${fmt(hourly[peak])}${unitText(m.unit) || ' steps'}` },
        { label: 'Active hours', value: String(hourly.filter(x => (key === 'steps' ? x >= 250 : x > 90)).length), sub: key === 'steps' ? '250+ steps' : 'above resting burn' },
        { label: 'Usual', value: valueText(key, baselineOf(key, idx)), sub: `${BASELINE_DAYS}-day average` },
        { label: m.goal ? 'Goal' : '30-day high', value: m.goal ? valueText(key, m.goal) : valueText(key, r && r.max), sub: m.goal && isNum(v) ? `${Math.min(100, Math.round(v / m.goal * 100))}% reached` : '' },
      ]);
    }
  } else if (key !== 'hr' && (m.intraday === 'hr' || m.intraday === 'zones')) {
    // Strain and zone minutes: time in each heart-rate zone, no heart-rate line
    // (that lives on the Heart page).
    const z = d.strain.zone_minutes;
    if (z) chart = `<div class="panel-title"><span class="label">Time in each zone · awake</span></div>${zoneBars(z, d.cardiovascular.rhr, state.data.profile.zone_max_hr || state.data.profile.max_hr)}`;
  } else if (m.intraday === 'hr') {
    const hr = d.strain.intraday_hr || [];
    if (hr.length) {
      const bpm = hr.map(p => p.bpm);
      const labels = hr.map(p => ({ '00:00': '12a', '06:00': '6a', '12:00': '12p', '18:00': '6p' }[p.time] || ''));
      const tips = hr.map(p => `<b>${p.bpm} bpm</b><span>${p.time}</span>`);
      chart = slot('day', w => lineChart(w, { key: 'hr', vals: bpm, labels, color, tips, dots: false, area: true, baseline: d.cardiovascular.rhr }));
      const z = d.strain.zone_minutes || {};
      const dayName = relativeDay(d.date) ? relativeDay(d.date).toLowerCase() : `on ${shortDate(d.date)}`;
      // Day stats from the per-minute averages (the chart above shows 10-minute samples).
      const hs = d.strain.hr_stats || { avg: Math.round(mean(bpm)), min: Math.min(...bpm), max: Math.max(...bpm), max_time: hr[bpm.indexOf(Math.max(...bpm))].time };
      chart += `<div class="hr-detail" data-hr-date="${d.date}"><p class="note hr-status">Loading every reading for this day…</p></div>`;
      extra = `<div class="hr-extra"><section class="panel"><div class="panel-title"><span class="label">Time in each zone ${esc(dayName)}</span></div>${zoneBars(z, d.cardiovascular.rhr, state.data.profile.zone_max_hr || state.data.profile.max_hr)}</section>`
        + statCards([
          { label: 'Average', value: `${hs.avg} bpm` },
          { label: 'Lowest', value: `${hs.min} bpm`, sub: 'minute average' },
          { label: 'Highest', value: `${hs.max} bpm`, sub: `at ${hs.max_time}` },
          { label: 'Resting', value: valueText('rhr', d.cardiovascular.rhr) },
        ]) + '</div>';
    }
  } else if (m.intraday === 'hypnogram') {
    const st = (d.sleep.hypnogram || []).filter(s => s.time && s.seconds);
    const sl = d.sleep;
    if (st.length) chart = slot('day', w => hypnogram(w, st));
    if (isNum(v)) {
      const mins = { wake: sl.wake_min, rem: sl.rem_min, light: sl.light_min, deep: sl.deep_min };
      const tot = Object.values(mins).filter(isNum).reduce((a, b) => a + b, 0) || 1;
      chart += `<div class="legend">${STAGES.map(s => `<span><i style="background:${s.color}"></i>${s.label}<b>${fmtDur(mins[s.key])}</b>&nbsp;· ${Math.round((mins[s.key] || 0) / tot * 100)}%</span>`).join('')}</div>`;
      let window = '';
      if (st.length) {
        const a = parseLocal(st[0].time);
        const last = st[st.length - 1];
        window = `${hhmm(a)} – ${hhmm(new Date(parseLocal(last.time).getTime() + last.seconds * 1000))}`;
      }
      extra = statCards([
        { label: 'In bed', value: fmtDur(sl.time_in_bed_minutes), sub: window },
        { label: 'Efficiency', value: `${fmt(sl.efficiency)}%` },
        { label: 'Short of 8h', value: sl.debt_minutes > 0 ? fmtDur(sl.debt_minutes) : 'None' },
        { label: 'Sleep score', value: isNum(sl.score) ? String(sl.score) : 'No score', sub: !isNum(sl.score) ? 'no sleep stages' : sl.score_source === 'app' ? 'from the Fitbit app' : 'estimated' },
      ]);
    }
  } else if (m.intraday === 'drivers') {
    const drivers = d.recovery.drivers.filter(x => DRIVER_KEY[x.metric]);
    if (isNum(v) && drivers.length) {
      const maxImp = Math.max(1, ...drivers.map(x => Math.abs(x.impact)));
      chart = `<div class="rows">${drivers.map(x => {
        const k = DRIVER_KEY[x.metric];
        const cls = x.impact > 0.05 ? 'good' : x.impact < -0.05 ? 'poor' : '';
        const wPct = Math.abs(x.impact) / maxImp * 50;
        return `<div class="row">
          <div class="row-main"><div class="row-title">${esc(M[k].label)}</div><div class="row-sub">${esc(valueText(k, M[k].pick(d)))} · usual ${esc(valueText(k, baselineOf(k, idx)))} · weight ${Math.round(x.weight * 100)}%${k === 'temp' || k === 'resp' ? ' · steady is best' : ''}</div></div>
          <svg class="row-meter" viewBox="0 0 100 10" preserveAspectRatio="none" style="height:10px" aria-hidden="true">
            <rect width="100" height="10" rx="5" style="fill:var(--raised)"/>
            <rect x="${x.impact >= 0 ? 50 : 50 - wPct}" width="${Math.max(1, wPct)}" height="10" rx="3" style="fill:var(--${cls || 'text-3'})"/>
            <rect x="49.6" width="0.8" height="10" style="fill:var(--text-3)"/></svg>
          <div class="row-val ${cls}">${x.impact > 0 ? '+' : x.impact < 0 ? '−' : ''}${fmt(Math.abs(x.impact), 1)}</div></div>`;
      }).join('')}</div><p class="note">Points each vital moved your score up or down from a typical night: starting from 50, they add up to your score.</p>`;
    } else if (d.cardiovascular.hrv_rmssd != null || isNum(d.cardiovascular.rhr)) {
      chart = `<p class="empty">Still building your baseline: recovery needs at least two vitals with 14 nights of data in the last 28 days${isNum(d.recovery.inputs_used) ? ` (${d.recovery.inputs_used} ready so far)` : ''}.</p>`;
    } else {
      chart = '<p class="empty">Recovery is calculated once last night’s HRV syncs.</p>';
    }
  } else if (m.intraday === 'bioage') {
    chart = bioAgeDetail(d, idx);
  } else if (m.intraday === 'scoreDrivers') {
    const sl = d.sleep;
    const model = state.data.overview.sleep_score_model || {};
    const drv = sl.score_drivers || [];
    if (drv.length) {
      const maxPts = Math.max(1, ...drv.map(x => Math.abs(x.points)));
      chart = `<div class="rows">${drv.map(x => {
        const cls = x.points > 0.05 ? 'good' : x.points < -0.05 ? 'poor' : '';
        const wPct = Math.abs(x.points) / maxPts * 50;
        return `<div class="row">
          <div class="row-main"><div class="row-title">${esc(x.label)}</div><div class="row-sub">${fmtDur(x.minutes)} · typical ${fmtDur(x.typical_minutes)}</div></div>
          <svg class="row-meter" viewBox="0 0 100 10" preserveAspectRatio="none" style="height:10px" aria-hidden="true">
            <rect width="100" height="10" rx="5" style="fill:var(--raised)"/>
            <rect x="${x.points >= 0 ? 50 : 50 - wPct}" width="${Math.max(1, wPct)}" height="10" rx="3" style="fill:var(--${cls || 'text-3'})"/>
            <rect x="49.6" width="0.8" height="10" style="fill:var(--text-3)"/></svg>
          <div class="row-val ${cls}">${x.points > 0 ? '+' : x.points < 0 ? '−' : ''}${fmt(Math.abs(x.points), 1)}</div></div>`;
      }).join('')}</div>`;
      const est = sl.score_estimate;
      const diff = est - model.typical_score;
      const lead = sl.score_source === 'app'
        ? `The Fitbit app scored this night ${sl.score}; the estimate would have been ${est}.`
        : `Estimated from this night’s sleep stages.`;
      chart += `<p class="note">${lead} A typical night of yours scores about ${model.typical_score}; this night’s differences from it add up to ${diff >= 0 ? '+' : '−'}${Math.abs(diff)} points.</p>`;
    } else if (isNum(d.sleep.duration_minutes)) {
      chart = '<p class="empty">This night was recorded without sleep stages (no REM or deep sleep), so there’s nothing to estimate from. Fitbit usually doesn’t score these nights either.</p>';
    } else {
      chart = '<p class="empty">No sleep was recorded for this night.</p>';
    }
    const win = weekWindow(idx);
    const wv = win.map(i => m.pick(days()[i]));
    if (wv.some(isNum)) {
      const wl = win.map(i => fmtDate(days()[i].date, { weekday: 'narrow' }));
      const wt = win.map((i, k) => `<b>${esc(valueText(key, wv[k]))}${esc(m.annotate(days()[i]))}</b><span>${longDate(days()[i].date)}</span>`);
      const wh = win.map(i => hrefMetric(key, 'day', days()[i].date));
      chart += `<div class="headline-label">Last 7 days</div>`
        + slot('week', w => lineChart(w, { key, vals: wv, labels: wl, color, tips: wt, hrefs: wh, selPos: wv.length - 1, band: r, H: 170,
          hollow: k => m.isEstimate(days()[win[k]]) }));
    }
  } else if (isNum(v) && r) {
    // Nightly single readings: where today sits, then the week leading up to it.
    const win = weekWindow(idx);
    const wv = win.map(i => m.pick(days()[i]));
    const wl = win.map(i => fmtDate(days()[i].date, { weekday: 'narrow' }));
    const wt = win.map((i, k) => `<b>${esc(valueText(key, wv[k]))}</b><span>${longDate(days()[i].date)}</span>`);
    const wh = win.map(i => hrefMetric(key, 'day', days()[i].date));
    chart = slot('day', w => rangeGauge(w, key, v, r))
      + `<div class="headline-label">Last 7 days</div>`
      + slot('week', w => lineChart(w, { key, vals: wv, labels: wl, color, tips: wt, hrefs: wh, selPos: wv.length - 1, band: r, H: 170 }));
  }

  if (key === 'vo2' && isNum(v)) {
    const b = d.body_age || {};
    const fa = b.fitness_age_limit === 'lower' ? '25 or younger' : b.fitness_age_limit === 'upper' ? '75 or older' : isNum(b.fitness_age) ? fmt(b.fitness_age, 0) : '--';
    extra = statCards([
      { label: 'For your age', value: isNum(b.percentile) ? (b.percentile >= 50 ? `Top ${100 - b.percentile}%` : `Bottom ${b.percentile}%`) : '--', sub: b.tier ? b.tier.replace(' for your age', '') : '' },
      { label: 'Fitness age', value: fa, sub: isNum(b.age_delta) ? `${b.age_delta > 0 ? '+' : b.age_delta < 0 ? '−' : ''}${fmt(Math.abs(b.age_delta), 0)} years vs your age` : '' },
      { label: 'Usual', value: valueText(key, baselineOf(key, idx)), sub: `${BASELINE_DAYS}-day average` },
      { label: '30-day high', value: valueText(key, r && r.max) },
    ]);
  }

  if (!extra && m.intraday !== 'drivers') {
    extra = statCards([
      { label: 'Usual', value: valueText(key, baselineOf(key, idx)), sub: `${BASELINE_DAYS}-day average` },
      { label: 'Normal range', value: r ? `${valueText(key, r.lo)} – ${valueText(key, r.hi)}` : '--', sub: 'last 30 days' },
      { label: '30-day low', value: valueText(key, r && r.min) },
      { label: '30-day high', value: valueText(key, r && r.max) },
    ]);
  }

  // The period bar above already names the day.
  const label = m.cardLabel || m.label;
  const valHtml = isNum(v) ? valueHtml(key, v, 'detail-' + key) : '';
  let note = di.text && isNum(v) ? di.text : '';
  let noteCls = di.cls;
  if (key === 'bioAge' && d.bio_age && d.bio_age.status === 'ok') {
    const b = d.bio_age;
    note = `${b.delta === 0 ? 'Same as' : `${fmt(Math.abs(b.delta), 1)} years ${b.delta < 0 ? 'younger' : 'older'} than`} your age (${b.chronological}) · ±${b.sigma}${b.floored ? ' · 17.0 is the lowest shown' : ''}`;
    noteCls = b.delta < 0 ? 'good' : b.delta > 0 ? 'poor' : '';
    const paceText = isNum(b.pace)
      ? (b.pace === 1 ? 'Steady' : b.pace < 1 ? 'Getting younger' : 'Getting older')
      : 'Needs 90 days';
    extra = statCards([
      { label: 'Body age', value: `${fmt(b.value, 1)}`, sub: `±${b.sigma} years` },
      { label: 'Your age', value: String(b.chronological) },
      { label: 'Pace of aging', value: isNum(b.pace) ? `${fmt(b.pace, 1)}×` : '--', sub: isNum(b.pace_change) ? `${paceText} · ${b.pace_change > 0 ? '+' : b.pace_change < 0 ? '−' : ''}${fmt(Math.abs(b.pace_change), 1)} y vs 6-month` : paceText },
      { label: 'Biggest lever', value: b.levers[0] ? b.levers[0].label : '--', sub: b.levers[0] ? `−${fmt(Math.abs(b.levers[0].years), 1)} years` : '' },
    ]);
  }
  if (key === 'sleepScore' && isNum(v)) {
    const model = state.data.overview.sleep_score_model || {};
    note = d.sleep.score_source === 'app' ? 'From the Fitbit app' : `Estimated · typically within ±${model.mae}`;
    noteCls = '';
  }
  const emptyText = key === 'sleepScore' && isNum(d.sleep.duration_minutes) ? 'No score'
    : key === 'recovery' && d.recovery.status === 'Calibrating' && (d.cardiovascular.hrv_rmssd != null || isNum(d.cardiovascular.rhr)) ? 'Calibrating' : 'No data';
  const panel = `${headline(label, valHtml, note, noteCls, emptyText)}${chart}`;
  return { panel, after: extra };
}

function detailPeriod(key, range, p, color) {
  const m = M[key];
  const vals = p.dates.map(iso => { const i = dateIndex(iso); return i >= 0 ? m.pick(days()[i]) : null; });
  const labels = axisLabelsFor(range, p.dates);
  const selPos = p.dates.indexOf(day().date);
  const dayAt = iso => { const i = dateIndex(iso); return i >= 0 ? days()[i] : null; };
  const tips = p.dates.map((iso, i) => `<b>${esc(valueText(key, vals[i]))}${esc(m.annotate && dayAt(iso) ? m.annotate(dayAt(iso)) : '')}</b><span>${longDate(iso)}</span>`);
  const hollow = m.isEstimate ? (i => { const dd = dayAt(p.dates[i]); return !!dd && m.isEstimate(dd); }) : null;
  const hrefs = p.dates.map(iso => (dateIndex(iso) >= 0 ? hrefMetric(key, 'day', iso) : null));
  // Today is still in progress: running totals (steps, calories...) would drag
  // averages down, so the summary leaves the unfinished day out.
  const todayIso = days()[days().length - 1].date;
  const partial = m.agg === 'sum' && relativeDay(todayIso) === 'Today';
  const summaryVals = vals.map((v, i) => (partial && p.dates[i] === todayIso ? null : v));
  const s = periodSummary(key, summaryVals);

  // Compare with the period before, like for like: while this period is still
  // running, only the same number of days from the start of the previous one.
  const prevP = periodOf(range, isoOf(addDays(parseDate(p.start), -1)));
  const lastCounted = p.dates.filter(iso => iso <= todayIso && !(partial && iso === todayIso)).length;
  const sameSpan = lastCounted < p.dates.length;
  const prevDates = sameSpan ? prevP.dates.slice(0, lastCounted) : prevP.dates;
  const prevVals = prevDates.map(iso => { const i = dateIndex(iso); return i >= 0 ? m.pick(days()[i]) : null; });
  const prevS = periodSummary(key, prevVals);
  const rangeName = range === '3m' ? '3 months' : range;
  let note = '';
  let noteCls = '';
  if (s && prevS && lastCounted > 0) {
    const a = s.avg, b = prevS.avg;
    const pct = b ? (a - b) / Math.abs(b) * 100 : 0;
    const span = `${lastCounted} ${lastCounted === 1 ? 'day' : 'days'}`;
    const than = !sameSpan ? `the previous ${rangeName}` : range === '3m' ? `the first ${span} of the previous 3 months` : `the same ${span} last ${rangeName}`;
    if (Math.abs(pct) < 0.5) note = `Same as ${than}`;
    else {
      note = `${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% ${pct > 0 ? 'higher' : 'lower'} than ${than}`;
      if (m.better) noteCls = (pct > 0) === (m.better === 'higher') ? 'good' : 'poor';
    }
  }

  const endIdx = dateIndex(p.dates.filter(d => dateIndex(d) >= 0).pop() || day().date);
  const band = m.kind === 'line' && !m.domain ? normalRange(key, Math.max(0, endIdx)) : null;
  const chart = slot('period', w => (m.kind === 'bar'
    ? barChart(w, { key, vals, labels, color: key === 'recovery' ? (v => tierOf(v).color) : color, goal: m.goal, tips, hrefs, selPos, domain: m.domain })
    : lineChart(w, { key, vals, labels, color: key === 'recovery' ? 'rgba(255, 255, 255, 0.45)' : color, tips, hrefs, selPos, band, domain: m.domain, hollow, dotColor: key === 'recovery' ? (v => tierOf(v).color) : null })));

  const headLabel = m.agg === 'sum' ? 'Daily average' : 'Average';
  const valHtml = s ? valueHtml(key, s.avg, 'period-' + key) : '';
  const best = s ? p.dates[summaryVals.indexOf(m.better === 'lower' ? s.min : s.max)] : null;
  const items = s ? [
    m.agg === 'sum' ? { label: 'Total', value: valueText(key, s.total) } : { label: 'Days logged', value: `${s.n} of ${p.dates.length}` },
    { label: 'Lowest', value: valueText(key, s.min), sub: longDate(p.dates[summaryVals.indexOf(s.min)]) },
    { label: 'Highest', value: valueText(key, s.max), sub: longDate(p.dates[summaryVals.indexOf(s.max)]) },
    m.agg === 'sum' ? { label: 'Days logged', value: `${s.n} of ${p.dates.length}` } : { label: m.better ? 'Best day' : 'Normal range', value: m.better ? valueText(key, vals[p.dates.indexOf(best)]) : (band ? `${valueText(key, band.lo)} – ${valueText(key, band.hi)}` : '--'), sub: m.better ? longDate(best) : '' },
  ] : [];
  void best;
  return {
    panel: `${headline(headLabel, valHtml, note, noteCls)}${chart}<p class="note">Select a ${m.kind === 'bar' ? 'bar' : 'point'} to open that day.${partial && p.dates.includes(todayIso) ? ' Today isn’t counted in the summary until it’s over.' : ''}</p>`,
    after: s ? statCards(items) : '',
  };
}

// ---------- Day strip scrolling ----------
// Keep the strip where the person left it across re-renders, then glide the
// selected day into the middle.
let stripScroll = null;
function placeStrip(root) {
  const strip = root.querySelector('.week');
  if (!strip) return;
  const sel = strip.querySelector('[aria-current="date"]');
  if (!sel) return;
  // Waits for layout: iOS Safari can drop a scroll position set before the
  // strip has a width, which left it at the start of history after a refresh.
  const place = () => {
    if (!strip.isConnected) return;
    if (!strip.clientWidth) { requestAnimationFrame(place); return; }
    // Measured against the strip itself (offsetLeft is relative to the page).
    const target = strip.scrollLeft + sel.getBoundingClientRect().left - strip.getBoundingClientRect().left
      - (strip.clientWidth - sel.offsetWidth) / 2;
    if (stripScroll === null || Math.abs(stripScroll - target) < 1) {
      strip.scrollLeft = target;
      requestAnimationFrame(() => { if (Math.abs(strip.scrollLeft - target) > 1) strip.scrollLeft = target; });
    } else {
      strip.scrollLeft = stripScroll;
      requestAnimationFrame(() => strip.scrollTo({ left: target, behavior: reducedMotion ? 'auto' : 'smooth' }));
    }
    stripScroll = target;
    // A strip being replaced can report a last scroll of 0; only the live one counts.
    strip.addEventListener('scroll', () => { if (strip.isConnected) stripScroll = strip.scrollLeft; }, { passive: true });
    requestAnimationFrame(() => dropInDays(strip));
  };
  place();
}

// Days at the strip's edges sit partly fallen: lifted and faded by how far
// they're cut off, settling into place as they come fully into view, and
// holding that pose when the finger stops. Pure CSS (a scroll-driven
// animation on the compositor) where the browser supports it; otherwise this
// sets the same pose from the scroll position once per frame.
const EDGE_CSS = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('animation-timeline: view()');
let edgeCleanup = null;
function dropInDays(strip) {
  if (edgeCleanup) { edgeCleanup(); edgeCleanup = null; }
  if (EDGE_CSS || reducedMotion || !strip.isConnected) return;
  const days = [...strip.querySelectorAll('.wday')];
  let boxes = [], width = 0, frame = 0;
  const measure = () => { width = strip.clientWidth; boxes = days.map(el => [el.offsetLeft - strip.offsetLeft, el.offsetWidth]); };
  const ease = t => t * t * (3 - 2 * t); // smoothstep
  const paint = () => {
    frame = 0;
    const x = strip.scrollLeft;
    days.forEach((el, i) => {
      const [left, w] = boxes[i];
      const l = left - x;
      // 1 when fully inside, 0 when fully outside, in between across the edge.
      const t = l < 0 ? (l + w) / w : l + w > width ? (width - l) / w : 1;
      if (t <= 0 || t >= 1) { if (el.style.transform) { el.style.transform = ''; el.style.opacity = ''; } return; }
      const k = 1 - ease(Math.max(0, Math.min(1, t)));
      el.style.transform = `translate3d(0, ${(-32 * k).toFixed(2)}px, 0) scale(${(1 - 0.08 * k).toFixed(3)})`;
      el.style.opacity = (1 - k).toFixed(3);
    });
  };
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const onResize = () => { measure(); onScroll(); };
  measure();
  paint();
  strip.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  edgeCleanup = () => { strip.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); if (frame) cancelAnimationFrame(frame); };
}

// ---------- Heart rate: every reading, loaded on demand ----------
// The dashboard file keeps only summaries. A day's raw readings (about one
// every 2 s) come from the phone's storage (DataStrapHost.dayHeartRate) or the
// local server (/hr/<date>.json) when the page is opened, so nothing grows.
const hrCache = new Map();
async function loadDayHr(date) {
  if (hrCache.has(date)) return hrCache.get(date);
  let data = null;
  try {
    if (window.DataStrapHost && window.DataStrapHost.dayHeartRate) data = await window.DataStrapHost.dayHeartRate(date);
    else if (!state.demo) {
      const res = await fetch(`hr/${date}.json`, { cache: 'no-cache' });
      if (res.ok) data = await res.json();
    }
  } catch { data = null; }
  if (hrCache.size >= 6) hrCache.delete(hrCache.keys().next().value);
  hrCache.set(date, data);
  return data;
}

const hms = sec => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

// Each reading counts until the next one (at most 10 s; minute averages count 60 s).
function analyseDayHr(data, rhr, maxHr) {
  const { t, b } = data;
  const gap = data.resolution === 'minute' ? 60 : 10;
  const dur = t.map((x, i) => (i + 1 < t.length ? Math.min(t[i + 1] - x, gap) : gap));
  let total = 0, wsum = 0, lo = 0, hi = 0;
  const zones = { light: 0, moderate: 0, vigorous: 0, peak: 0 };
  const hours = Array.from({ length: 24 }, () => null);
  t.forEach((x, i) => {
    const v = b[i], d = dur[i];
    total += d; wsum += v * d;
    if (v < b[lo]) lo = i;
    if (v > b[hi]) hi = i;
    if (isNum(rhr)) zones[zoneOf(v, rhr, maxHr)[0]] += d;
    const h = Math.min(23, Math.floor(x / 3600));
    const hr = hours[h] || (hours[h] = { sum: 0, dur: 0, min: v, max: v, maxT: x, n: 0 });
    hr.sum += v * d; hr.dur += d; hr.n += 1;
    if (v < hr.min) hr.min = v;
    if (v > hr.max) { hr.max = v; hr.maxT = x; }
  });
  return {
    n: t.length, worn: total, avg: total ? Math.round(wsum / total) : null,
    min: b[lo], minT: t[lo], max: b[hi], maxT: t[hi],
    zones: Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, v / 60])),
    hours: hours.map(h => (h ? { avg: Math.round(h.sum / h.dur), min: h.min, max: h.max, maxT: h.maxT, n: h.n } : null)),
  };
}

// The whole day as one smooth line (5-minute averages of every reading) over
// a soft fill, with the resting line and the true peak. The second-by-second
// detail lives in the hour zoom below, so the day view stays calm.
function dayEnvelopeChart(data, rhr, maxHr, focus, stats) {
  return w => {
    const H = 220, top = 22, bottom = 26, padL = 4, padR = 36;
    const plotB = H - bottom;
    const x = scale(0, 86400, padL, w - padR);
    const BIN = 300;
    const sums = new Array(288).fill(0), counts = new Array(288).fill(0);
    data.t.forEach((sec, i) => { const k = Math.min(287, Math.floor(sec / BIN)); sums[k] += data.b[i]; counts[k] += 1; });
    const pts = [];
    for (let k = 0; k < 288; k++) if (counts[k]) pts.push([k * BIN + BIN / 2, sums[k] / counts[k]]);
    const vals = pts.map(p => p[1]);
    const lo = Math.floor((Math.min(...vals, isNum(rhr) ? rhr : Infinity) - 6) / 10) * 10;
    const hi = Math.ceil((Math.max(stats.max, ...vals) + 4) / 10) * 10;
    const y = scale(lo, hi, plotB, top);
    // Break the line where the band wasn't worn for more than 30 minutes.
    let line = '';
    let area = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const d = run.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
        line += d;
        area += `${d}L${x(run[run.length - 1][0]).toFixed(1)},${plotB}L${x(run[0][0]).toFixed(1)},${plotB}Z`;
      }
      run = [];
    };
    pts.forEach((p, i) => { if (i && p[0] - pts[i - 1][0] > 1800) flush(); run.push(p); });
    flush();
    const labels = [lo, Math.round((lo + hi) / 2), hi].map(v => `<text x="${w - padR + 6}" y="${y(v) + 4}">${v}</text>`).join('');
    const rest = isNum(rhr) ? `<line class="goal" x1="${padL}" x2="${w - padR}" y1="${y(rhr)}" y2="${y(rhr)}"/>` : '';
    const band = focus !== null ? `<rect x="${x(focus * 3600)}" y="${top - 8}" width="${x(3600) - x(0)}" height="${plotB - top + 8}" rx="4" style="fill:var(--text);opacity:.07"/>` : '';
    const px = x(stats.maxT), py = y(stats.max);
    const peak = `<circle cx="${px}" cy="${py}" r="4" style="fill:var(--text);stroke:var(--card);stroke-width:2"/>
      <text x="${px}" y="${py - 9}" text-anchor="middle" style="fill:var(--text);font-weight:600">${stats.max}</text>`;
    const xt = [[0, '12a', 'start'], [21600, '6a', 'middle'], [43200, '12p', 'middle'], [64800, '6p', 'middle'], [86400, '12a', 'end']]
      .map(([sec, lab, a]) => `<text x="${x(sec)}" y="${H - 6}" text-anchor="${a}">${lab}</text>`).join('');
    // One scrub layer: the finger (or mouse) is followed continuously along the
    // 5-minute line; a tap without sliding still zooms into that hour.
    const scrubPts = JSON.stringify(pts.map(([t, v]) => [+x(t).toFixed(1), +y(v).toFixed(1), Math.round(v), t]));
    const hits = `<g class="scrub-mark" hidden><line y1="${top - 8}" y2="${plotB}"/><circle r="4.5"/></g>
      <rect class="day-scrub" x="${padL}" y="${top - 8}" width="${w - padR - padL}" height="${plotB - top + 8}" data-pts='${scrubPts}'/>`;
    return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Heart rate through the day">
      <defs><linearGradient id="dayFade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FF6F8E" stop-opacity=".22"/><stop offset="1" stop-color="#FF6F8E" stop-opacity="0"/></linearGradient></defs>
      ${band}<path d="${area}" fill="url(#dayFade)"/>${rest}
      <path d="${line}" style="fill:none;stroke:var(--heart);stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>
      ${peak}${labels}${xt}${hits}
    </svg>`;
  };
}

function heartDetailHtml(data, stats, rhr, maxHr, focus) {
  const perSecond = data.resolution === 'second';
  const hourRows = stats.hours.map((h, i) => {
    if (!h) return '';
    const pos = v => Math.max(0, Math.min(100, (v - 40) / (200 - 40) * 100));
    return `<button type="button" class="hour-row ${i === focus ? 'on' : ''}" data-hour="${i}">
      <span class="hour-time">${String(i).padStart(2, '0')}:00</span>
      <span class="hour-bar"><i style="left:${pos(h.min)}%;width:${Math.max(1, pos(h.max) - pos(h.min))}%"></i><b style="left:${pos(h.avg)}%"></b></span>
      <span class="hour-num"><b>${h.avg}</b> ${h.min}–${h.max}</span>
    </button>`;
  }).join('');
  let zoom = '';
  if (focus !== null && stats.hours[focus]) {
    const lo = focus * 3600;
    const idx = [];
    data.t.forEach((sec, i) => { if (sec >= lo && sec < lo + 3600) idx.push(i); });
    const pseudo = { name: 'this hour', time: `${String(focus).padStart(2, '0')}:00`, duration_minutes: 60, hr_t: idx.map(i => data.t[i] - lo), hr_bpm: idx.map(i => data.b[i]) };
    const h = stats.hours[focus];
    zoom = `<div class="hr-zoom">
      <div class="panel-title"><span class="label">${String(focus).padStart(2, '0')}:00–${String((focus + 1) % 24).padStart(2, '0')}:00 · ${perSecond ? 'every reading' : 'minute averages'}</span>
      <b>${h.avg}<small>bpm avg · ${h.min}–${h.max} · peak at ${hms(h.maxT)}</small></b></div>
      ${slot('hrHour', workoutChart(pseudo, rhr, maxHr))}
    </div>`;
  }
  return `<p class="note">${perSecond ? `Every reading: ${fmt(stats.n)}, about one every ${Math.max(1, Math.round(stats.worn / stats.n))} s, worn ${fmtDur(stats.worn / 60)}.` : 'Minute averages (raw readings aren’t stored on this device for this day).'} The line shows 5-minute averages; the dashed line is your resting heart rate. Tap the chart to see every reading in an hour.</p>
    ${zoom}
    <details class="hours-toggle" ${state.hrHoursOpen ? 'open' : ''}>
      <summary><span>Show hourly breakdown</span><span class="when-open">Hide hourly breakdown</span>${ph('chevron-right', 'toggle-chev')}</summary>
      <div class="hours">${hourRows}</div>
    </details>`;
}

async function hydrateHeartDetail(root) {
  const box = root.querySelector('[data-hr-date]');
  if (!box) return;
  const date = box.dataset.hrDate;
  const data = await loadDayHr(date);
  if (!box.isConnected) return;
  if (!data || !data.t || data.t.length < 2) {
    box.innerHTML = '<p class="note">Showing 10-minute samples: detailed readings aren’t available for this day.</p>';
    return;
  }
  const d = days()[dateIndex(date)];
  const rhr = d.cardiovascular.rhr;
  const maxHr = state.data.profile.zone_max_hr || state.data.profile.max_hr;
  const stats = analyseDayHr(data, rhr, maxHr);
  const draw = () => {
    const focus = state.hrFocus && state.hrFocus.date === date ? state.hrFocus.hour : null;
    charts.day = dayEnvelopeChart(data, rhr, maxHr, focus, stats);
    box.innerHTML = heartDetailHtml(data, stats, rhr, maxHr, focus);
    const panel = box.closest('.panel');
    mountCharts(panel, false);
    const extra = root.querySelector('.hr-extra');
    if (extra) {
      extra.innerHTML = `<section class="panel"><div class="panel-title"><span class="label">Time in each zone · every reading</span></div>${zoneBars(stats.zones, rhr, maxHr)}</section>`
        + statCards([
          { label: 'Average', value: `${stats.avg} bpm`, sub: 'time-weighted' },
          { label: 'Lowest', value: `${stats.min} bpm`, sub: `at ${hms(stats.minT)}` },
          { label: 'Highest', value: `${stats.max} bpm`, sub: `at ${hms(stats.maxT)}` },
          { label: 'Resting', value: valueText('rhr', rhr) },
        ]);
    }
  };
  draw();
  box.addEventListener('toggle', e => { if (e.target.matches('.hours-toggle')) state.hrHoursOpen = e.target.open; }, true);
  bindDayScrub(box.closest(".panel"), hour => {
    state.hrFocus = state.hrFocus && state.hrFocus.date === date && state.hrFocus.hour === hour ? null : { date, hour };
    draw();
  });
  box.closest('.panel').onclick = e => {
    const h = e.target.closest('.hour-row[data-hour]');
    if (!h) return;
    const hour = Number(h.dataset.hour);
    state.hrFocus = state.hrFocus && state.hrFocus.date === date && state.hrFocus.hour === hour ? null : { date, hour };
    hideTip();
    draw();
  };
}

// Follows the pointer along the day chart. Updates are batched to one per
// frame and only move existing SVG nodes, so sliding stays smooth.
function bindDayScrub(box, onTap) {
  let pts = null, mark = null, rect = null, frame = 0, lastX = 0, startX = 0, moved = false, active = false;
  const tip = $('#tooltip');
  const update = () => {
    frame = 0;
    const box2 = rect.getBoundingClientRect();
    const sx = rect.ownerSVGElement.viewBox.baseVal.width / rect.ownerSVGElement.getBoundingClientRect().width;
    const px = (lastX - rect.ownerSVGElement.getBoundingClientRect().left) * sx;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < px) lo = m + 1; else hi = m; }
    if (lo > 0 && px - pts[lo - 1][0] < pts[lo][0] - px) lo -= 1;
    const [cx, cy, bpm, t] = pts[lo];
    mark.removeAttribute('hidden');
    mark.querySelector('line').setAttribute('x1', cx);
    mark.querySelector('line').setAttribute('x2', cx);
    const c = mark.querySelector('circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy);
    tip.innerHTML = `<b>${bpm} bpm</b><span>${hms(t - 150).slice(0, 5)}–${hms(t + 150).slice(0, 5)}</span>`;
    tip.hidden = false;
    const svgR = rect.ownerSVGElement.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(svgR.left + cx / sx, 80), window.innerWidth - 80)}px`;
    tip.style.top = `${box2.top + 6}px`;
  };
  const end = e => {
    if (!active) return;
    active = false;
    if (frame) cancelAnimationFrame(frame), frame = 0;
    mark.setAttribute('hidden', ''); hideTip();
    if (!moved && e.type === 'pointerup') {
      const s = rect.ownerSVGElement, f = (e.clientX - s.getBoundingClientRect().left) / s.getBoundingClientRect().width;
      const t = (f * s.viewBox.baseVal.width - 4) / (s.viewBox.baseVal.width - 40) * 86400;
      const hour = Math.max(0, Math.min(23, Math.floor(t / 3600)));
      if (pts.some(p => Math.floor(p[3] / 3600) === hour)) onTap(hour);
    }
  };
  box.addEventListener('pointerdown', e => {
    rect = e.target.closest('.day-scrub');
    if (!rect) return;
    pts = JSON.parse(rect.dataset.pts);
    if (!pts.length) return;
    mark = rect.ownerSVGElement.querySelector('.scrub-mark');
    active = true; moved = false; startX = lastX = e.clientX;
    try { rect.setPointerCapture(e.pointerId); } catch {}
    update();
  });
  box.addEventListener('pointermove', e => {
    if (!active) return;
    lastX = e.clientX;
    if (Math.abs(lastX - startX) > 6) moved = true;
    if (!frame) frame = requestAnimationFrame(update);
  });
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ---------- Tab bar (phones) ----------
const TABS = [
  { id: 'today', label: 'Today', icon: 'house', href: iso => hrefHome(iso), keys: [] },
  { id: 'recovery', label: 'Recovery', icon: 'battery-charging', href: iso => hrefMetric('recovery', 'day', iso), keys: ['recovery'] },
  { id: 'sleep', label: 'Sleep', icon: 'moon', href: iso => hrefMetric('sleep', 'day', iso), keys: ['sleep', 'sleepScore', 'efficiency'] },
  { id: 'strain', label: 'Strain', icon: 'zap', href: iso => hrefMetric('strain', 'day', iso), keys: ['strain', 'steps', 'energy', 'zones'] },
  { id: 'heart', label: 'Heart', icon: 'heart-pulse', href: iso => hrefMetric('hr', 'day', iso), keys: ['hr', 'hrv', 'rhr', 'stress'] },
];

let lastTab = null;
function renderTabbar() {
  let bar = $('#tabbar');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'tabbar';
    bar.className = 'tabbar';
    bar.setAttribute('aria-label', 'Sections');
    document.body.appendChild(bar);
  }
  const r = state.route;
  const active = r.page === 'home' ? 'today' : r.page === 'workout' ? 'strain' : (TABS.find(t => t.keys.includes(r.key)) || {}).id;
  const iso = day().date;
  const accentOf = t => (t.id === 'today' ? 'var(--text)' : t.id === 'recovery' ? 'var(--good)' : GROUPS[t.id === 'strain' ? 'activity' : t.id].color);
  bar.innerHTML = '<span class="tab-ind" aria-hidden="true"></span>' + TABS.map(t => `<a href="${t.href(iso)}" class="tab ${t.id === active ? 'on' : ''} ${t.id === active && lastTab !== null && lastTab !== active ? 'pop' : ''}" ${t.id === active ? 'aria-current="page"' : ''} data-tab="${t.id}" style="--accent:${accentOf(t)}">
      <span class="tab-icon">${ph(t.icon, '', t.id === active ? 'fill' : 'regular')}</span><span class="tab-label">${t.label}</span></a>`).join('');
  const moved = lastTab !== null && lastTab !== active;
  lastTab = active;
  placeTabIndicator(bar, bar.querySelector('.tab.on'), { animate: moved });
  if (!bar.dataset.swipe) { bar.dataset.swipe = '1'; bindTabSwipe(bar); }
}

// One highlight pill for the whole bar, placed on the active tab's icon by
// measuring it, so it's always exactly centred. It slides between tabs.
let tabIndX = null;
function placeTabIndicator(bar, tab, { animate = false, x = null } = {}) {
  const ind = bar.querySelector('.tab-ind');
  if (!ind) return;
  if (!tab && x === null) { ind.style.opacity = '0'; return; }
  // Positions are relative to the bar's padding box (inside its border).
  let cx = x;
  if (cx === null) {
    // Layout offsets, not the on-screen box: the icon may be mid "pop"
    // animation (scaled and nudged down) at this moment.
    const iconEl = tab.querySelector('.tab-icon');
    cx = tab.offsetLeft + iconEl.offsetLeft + iconEl.offsetWidth / 2;
    ind.style.top = `${tab.offsetTop + iconEl.offsetTop}px`;
    ind.style.setProperty('--accent', tab.style.getPropertyValue('--accent'));
  } else {
    cx -= bar.clientLeft;
  }
  const at = v => `translateX(${(v - ind.offsetWidth / 2).toFixed(1)}px)`;
  const slide = animate && tabIndX !== null;
  // The bar is re-rendered on every page change, so a new pill first takes
  // the old one's place and then slides to the new tab.
  if (slide && !ind.style.transform) {
    ind.classList.remove('slide');
    ind.style.transform = at(tabIndX);
    void ind.offsetWidth;
  }
  ind.style.opacity = '1';
  ind.classList.toggle('slide', slide);
  ind.style.transform = at(cx);
  tabIndX = cx;
}

// Slide a finger along the bar: the highlight follows it and the tab under it
// lights up; lifting the finger opens that tab. A plain tap works as before.
function bindTabSwipe(bar) {
  let s = null;
  const tabAt = x => [...bar.querySelectorAll('.tab')].reduce((best, t) => {
    const b = t.getBoundingClientRect();
    const d = Math.abs(b.left + b.width / 2 - x);
    return !best || d < best.d ? { t, d } : best;
  }, null).t;
  const hover = t => bar.querySelectorAll('.tab').forEach(x => x.classList.toggle('near', x === t));
  bar.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    s = { startX: e.clientX, moved: false, tab: null, id: e.pointerId };
  });
  bar.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.id) return;
    if (!s.moved && Math.abs(e.clientX - s.startX) < 8) return;
    if (!s.moved) { s.moved = true; try { bar.setPointerCapture(e.pointerId); } catch {} }
    const barBox = bar.getBoundingClientRect();
    const tabs = bar.querySelectorAll('.tab');
    const first = tabs[0].getBoundingClientRect(), last = tabs[tabs.length - 1].getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX, first.left + first.width / 2), last.left + last.width / 2);
    const t = tabAt(x);
    if (t !== s.tab) {
      s.tab = t;
      hover(t);
      bar.querySelector('.tab-ind').style.setProperty('--accent', t.style.getPropertyValue('--accent'));
    }
    placeTabIndicator(bar, null, { x: x - barBox.left });
  });
  const end = e => {
    if (!s || e.pointerId !== s.id) return;
    const { moved, tab } = s;
    s = null;
    hover(null);
    if (!moved) return;
    // A slide ends on a tab: open it (and swallow the click that follows).
    addEventListener('click', block, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', block, { capture: true }), 400);
    if (tab && !tab.classList.contains('on')) go(tab.getAttribute('href'));
    else placeTabIndicator(bar, bar.querySelector('.tab.on'), { animate: true });
  };
  const block = e => { e.stopPropagation(); e.preventDefault(); };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  addEventListener('resize', () => placeTabIndicator(bar, bar.querySelector('.tab.on')));
}

// ---------- Render ----------
let renders = 0;
// A page that fails to draw shows what happened and, in the phone app, lets
// the person send the technical error (no health data) to the feedback Sheet.
function showPageError(main, error) {
  const route = (location.hash.split('?')[0] || '#/').slice(1);
  const report = `${error && error.name}: ${error && error.message}\nroute ${route}\n${String(error && error.stack || '').split('\n').slice(0, 6).join('\n')}`;
  console.error(error);
  const canSend = window.DataStrapHost && window.DataStrapHost.sendReport;
  main.innerHTML = `<section class="panel page-error">
      <div class="panel-title"><span class="label">Couldn’t show this page</span></div>
      <p>Something in your data tripped up this page. Other tabs still work.</p>
      ${canSend ? `<p class="note">Send a report so it can be fixed. It includes only the technical error, not your health data.</p>
      <button type="button" class="log-save" data-send-report>Send report</button>` : ''}
      <pre class="page-error-detail">${esc(report)}</pre>
    </section>`;
  const btn = main.querySelector('[data-send-report]');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const ok = await window.DataStrapHost.sendReport(report).catch(() => false);
    btn.textContent = ok ? 'Report sent. Thank you.' : 'Couldn’t send. Try again.';
    if (!ok) btn.disabled = false;
  });
}

function render({ pageEnter = false } = {}) {
  renders++;
  const d = day();
  const rel = relativeDay(d.date);
  $('#dateText').textContent = rel ? `${rel}, ${shortDate(d.date)}` : longDate(d.date);
  $('#dateBtn').setAttribute('aria-label', `${longDate(d.date)}. Pick a date`);
  $('#datePicker').value = d.date;
  $('#prevDay').disabled = state.idx === 0;
  $('#nextDay').disabled = state.idx === days().length - 1;

  charts = {};
  const main = $('#main');
  const page = state.route.page;
  try {
    main.innerHTML = page === 'home' ? renderHome() : page === 'workout' ? renderWorkout() : renderDetail();
  } catch (error) {
    showPageError(main, error);
    renderTabbar();
    return;
  }
  document.title = page === 'home' ? 'DataStrap'
    : page === 'workout' ? `${day().strain.workouts[state.route.index].name} · DataStrap` : `${M[state.route.key].label} · DataStrap`;
  if (pageEnter && !reducedMotion) {
    main.classList.remove('enter', 'enter-detail');
    void main.offsetWidth;
    main.classList.add(state.route.page === 'home' ? 'enter' : 'enter-detail');
  }
  renderTabbar();
  try {
    placeStrip(main);
    mountCharts(main, true);
  } catch (error) {
    showPageError(main, error);
    return;
  }
  hydrateHeartDetail(main);
  animateNumbers(main);
  // Rings start empty and sweep to their value on the next frame.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    main.querySelectorAll('[data-target]').forEach(arc => { arc.style.strokeDashoffset = arc.dataset.target; });
  }));
  observeReveals(main, { cascade: renders === 1 });
  if (pageEnter) main.focus({ preventScroll: true });
}

// Cards fade up as they scroll into view, and their charts draw at that moment
// rather than off-screen.
let revealObserver = null;
function observeReveals(root, { cascade = true } = {}) {
  if (revealObserver) revealObserver.disconnect();
  document.body.classList.toggle('first-load', cascade);
  const items = [...root.querySelectorAll('.reveal')];
  if (!cascade) {
    // After the first screen, content already in view appears with the page
    // transition instead of fading in piece by piece.
    for (const el of items) {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in', 'instant');
    }
  }
  items.forEach(el => {
    const siblings = [...el.parentElement.children].filter(c => c.classList.contains('reveal'));
    el.style.setProperty('--i', Math.min(siblings.indexOf(el), 8));
  });
  if (reducedMotion || !('IntersectionObserver' in window)) {
    items.forEach(el => el.classList.add('in'));
    return;
  }
  const pending = items.filter(el => !el.classList.contains('in'));
  revealObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      revealObserver.unobserve(e.target);
      if (e.boundingClientRect.top > window.innerHeight * 0.6) mountCharts(e.target, true);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  pending.forEach(el => revealObserver.observe(el));
  // Safety net: never leave on-screen content hidden if the observer doesn't fire.
  setTimeout(() => {
    items.forEach(el => { if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('in'); });
  }, 1500);
}

function setDay(i) {
  i = clampIdx(i);
  if (i === state.idx) return;
  const iso = days()[i].date;
  const r = state.route;
  go(r.page === 'home' ? hrefHome(iso) : hrefMetric(r.key, r.range, iso), { replace: true });
}

// ---------- Tooltip ----------
function showTip(el) {
  const tip = $('#tooltip');
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const svg = el.closest('svg').getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(r.left + r.width / 2, 80), window.innerWidth - 80)}px`;
  tip.style.top = `${el.classList.contains('hit') ? svg.top + 6 : r.top}px`;
}
const hideTip = () => { $('#tooltip').hidden = true; };

// Touch scrubbing for every chart built on hitStrips (trends, intraday lines
// and bars, workouts): the finger is followed across the columns, one update
// per frame. A tap still opens a column's link; a slide doesn't.
function bindChartScrub() {
  let s = null;
  const mark = (hit, on) => { const m = hit && hit.nextElementSibling; if (m && m.classList.contains('hover-mark')) m.classList.toggle('on', on); };
  const update = () => {
    if (!s) return;
    s.frame = 0;
    const { cols } = s;
    let lo = 0, hi = cols.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cols[m].left <= s.x) lo = m; else hi = m - 1; }
    const hit = cols[lo].el;
    if (hit === s.cur) return;
    mark(s.cur, false);
    s.cur = hit;
    mark(hit, true);
    showTip(hit);
  };
  const end = () => {
    if (!s) return;
    if (s.frame) cancelAnimationFrame(s.frame);
    mark(s.cur, false);
    hideTip();
    if (s.moved) {
      const block = e => { e.stopPropagation(); e.preventDefault(); };
      addEventListener('click', block, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', block, { capture: true }), 400);
    }
    s = null;
  };
  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return;
    const hit = e.target.closest('.hit');
    if (!hit || !hit.dataset.tip) return;
    const cols = [...hit.closest('svg').querySelectorAll('.hit[data-tip]')]
      .map(el => ({ el, left: el.getBoundingClientRect().left })).sort((a, b) => a.left - b.left);
    s = { cols, x: e.clientX, startX: e.clientX, cur: null, frame: 0, moved: false };
    try { hit.setPointerCapture(e.pointerId); } catch {}
    update();
  });
  document.addEventListener('pointermove', e => {
    if (!s) return;
    s.x = e.clientX;
    if (Math.abs(s.x - s.startX) > 6) s.moved = true;
    if (!s.frame) s.frame = requestAnimationFrame(update);
  });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

// ---------- Events ----------
function bindEvents() {
  // Bold chevrons on the date pill, matching the weight of the bar's icons.
  $('#prevDay').innerHTML = ph('chevron-left', '', 'bold');
  $('#nextDay').innerHTML = ph('chevron-right', '', 'bold');
  $('#prevDay').addEventListener('click', () => setDay(state.idx - 1));
  $('#nextDay').addEventListener('click', () => setDay(state.idx + 1));
  const picker = $('#datePicker');
  picker.min = days()[0].date;
  picker.max = days()[days().length - 1].date;
  $('#dateBtn').addEventListener('click', () => { try { picker.showPicker(); } catch { picker.click(); } });
  picker.addEventListener('change', e => { const i = dateIndex(e.target.value); if (i >= 0) setDay(i); });

  document.addEventListener('click', e => {
    if (e.target.closest('[data-log-open]')) { openLogSheet(); return; }
    const del = e.target.closest('[data-delete-workout]');
    if (del) { deleteWorkout(del); return; }
    const rep = e.target.closest('a[data-replace]');
    if (rep && rep.getAttribute('href')) {
      e.preventDefault();
      go(rep.getAttribute('href'), { replace: true });
      return;
    }
    const hit = e.target.closest('[data-href]');
    if (hit) { hideTip(); go(hit.dataset.href, { replace: true }); }
  });

  document.addEventListener('pointerover', e => { const t = e.target.closest('[data-tip]'); if (t) showTip(t); });
  document.addEventListener('pointerout', e => { if (e.target.closest('[data-tip]')) hideTip(); });
  bindChartScrub();
  window.addEventListener('scroll', () => {
    hideTip();
    $('.bar').classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  document.addEventListener('keydown', e => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') { setDay(state.idx - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setDay(state.idx + 1); e.preventDefault(); }
    if (e.key === 'Escape' && state.route.page !== 'home') go(hrefHome(day().date));
  });

  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', route);

  let timer;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      mountCharts($('#main'), false);
    }, 120);
  });
}

// ---------- Boot ----------
async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Sample data is generated once; slide its dates so the last day is today.
function shiftDemoDates(data) {
  const last = parseDate(data.days[data.days.length - 1].date);
  const now = new Date();
  const offset = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - last) / 86400000);
  if (!offset) return;
  const shift = iso => isoOf(addDays(parseDate(iso), offset));
  for (const d of data.days) {
    d.date = shift(d.date);
    d.day_name = longDate(d.date);
    for (const h of d.sleep.hypnogram || []) {
      const t = parseLocal(h.time);
      t.setDate(t.getDate() + offset);
      h.time = `${isoOf(t)}T${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.000`;
    }
  }
  data.overview.date_start = data.days[0].date;
  data.overview.date_end = data.days[data.days.length - 1].date;
}

// Shows a dataset: header initials, footer, and the selected day. Keeps the
// day being viewed when the data is refreshed, unless that was the latest day.
function showData(data, { demo = false } = {}) {
  const prev = state.data ? days()[state.idx]?.date : null;
  const wasLatest = !state.data || state.idx === days().length - 1;
  state.data = data;
  state.demo = demo;
  const keep = prev && !wasLatest ? days().findIndex(d => d.date === prev) : -1;
  state.idx = keep >= 0 ? keep : days().length - 1;
  M.temp.unit = useF() ? '°F' : '°C';
  const p = data.profile;
  const initials = (p.name || '').split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  $('#avatar').textContent = initials;
  $('#avatar').hidden = !initials || demo;
  $('#demoBanner').hidden = !demo;
  const o = data.overview;
  $('#foot').textContent = demo
    ? 'Sample data for a fictional person'
    : `${o.total_days_analyzed} days from Fitbit · ${shortDate(o.date_start)} – ${shortDate(o.date_end)}`;
}

// The Android app (mobile/) computes the data on the phone and provides it
// through window.DataStrapHost instead of dashboard_data.json.
window.DataStrap = {
  toast,
  refresh(data) {
    hrCache.clear();
    const first = !state.data;
    showData(data);
    if (first) bindEvents();
    lastHash = null; // re-render the current page with the new data
    route();
  },
};

document.addEventListener('DOMContentLoaded', async () => {
  if (window.DataStrapHost) {
    const data = await window.DataStrapHost.load();
    if (data) window.DataStrap.refresh(data);
    return;
  }
  let data;
  let demo = false;
  try {
    data = await loadJson('dashboard_data.json');
  } catch {
    try {
      // Not connected yet: show the bundled sample data.
      data = await loadJson('demo_data.json');
      demo = true;
      shiftDemoDates(data);
    } catch (err) {
      console.error(err);
      $('#main').innerHTML = '<section class="panel"><h1 class="detail-title">Couldn’t load any data</h1><p class="note">Run <code>python3 setup.py</code> to connect your Fitbit, then reload.</p></section>';
      return;
    }
  }
  showData(data, { demo });
  bindEvents();
  route();
});
