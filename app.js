// OpenStrap dashboard.
// Home shows the selected day at a glance; every metric opens a detail page
// with Day / Week / Month / 3-month views over calendar periods.

const state = { data: null, idx: 0, route: { page: 'home' } };

const BASELINE_DAYS = 14;
const RANGE_DAYS = 30;
const RANGES = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: '3m', label: '3 Months' },
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

// ---------- Icons (24px stroke) ----------
const I = {
  recovery: 'M12 3a9 9 0 1 0 9 9M12 7v5l3 2',
  steps: 'M3 16h18v-1.5c0-1.6-1.3-2.9-2.9-3.2L14 10.5 12 6H9l-.5 4L5 11c-1.2.4-2 1.5-2 2.8zM3 19.5h18',
  energy: 'M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8z',
  strain: 'M13 3 5 13h6l-1 8 8-10h-6z',
  zones: 'M5 19v-6M10 19V9M15 19v-4M20 19V5',
  sleep: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  sleepScore: 'M12 3.5l2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.4l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7z',
  efficiency: 'M4 17a8 8 0 1 1 16 0M12 17l4-5',
  rhr: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  hrv: 'M3 12h3l2-5 3 10 3-8 2 3h5',
  hr: 'M3 12h4l2.5-6 4 12 2.5-6H21',
  stress: 'M4 16a8 8 0 0 1 16 0M12 16l-3.5-4.5M4 20h16',
  temp: 'M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0zM12 9v7',
  spo2: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  resp: 'M3 9h11a3 3 0 1 0-3-3M3 15h14a3 3 0 1 1-3 3M3 12h7',
  vo2: 'M12 4v7M12 11c-2 0-3-3-5-3-2 0-3 4-3 7 0 2 1 4 3 4 3 0 5-3 5-8zM12 11c2 0 3-3 5-3 2 0 3 4 3 7 0 2-1 4-3 4-3 0-5-3-5-8z',
  lift: 'M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11',
  run: 'M14 4.5a1.5 1.5 0 1 0 0 .01M6 21l3.5-5.5L12 17l1-5 3 3h3M9.5 10.5 12 8.5l1 3.5',
  ball: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5l3.5 2.5-1.3 4h-4.4l-1.3-4z',
  chev: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[name]}"/></svg>`;

// ---------- Metrics ----------
const GROUPS = {
  recovery: { color: 'var(--good)' },
  activity: { label: 'Activity', color: 'var(--activity)' },
  sleep: { label: 'Sleep', color: 'var(--sleep)' },
  heart: { label: 'Heart', color: 'var(--heart)' },
  body: { label: 'Body', color: 'var(--body)' },
};

const avgHr = d => (d.strain.intraday_hr && d.strain.intraday_hr.length ? Math.round(mean(d.strain.intraday_hr.map(p => p.bpm))) : null);
const zoneMin = d => (d.strain.zone_minutes ? d.strain.zone_minutes.fat_burn + d.strain.zone_minutes.cardio + d.strain.zone_minutes.peak : null);
// Temperatures are stored in °C; show them in the unit set in the user's Google Health settings.
const useF = () => (state.data.profile.temperature_unit || '').toUpperCase() === 'FAHRENHEIT';
const tempIn = c => (isNum(c) ? (useF() ? c * 9 / 5 + 32 : c) : null);

// kind: chart style for periods; agg: how a period headline summarises days.
const M = {
  recovery: { label: 'Recovery', group: 'recovery', unit: '%', dp: 0, kind: 'line', agg: 'avg', better: 'higher', domain: [0, 100], intraday: 'drivers', defaultRange: 'day',
    pick: d => (d.cardiovascular.hrv_rmssd != null ? d.recovery.score : null) },
  steps: { label: 'Steps', group: 'activity', unit: '', dp: 0, kind: 'bar', agg: 'sum', goal: 10000, intraday: 'hourly_steps', defaultRange: 'day', pick: d => d.strain.steps },
  energy: { label: 'Energy burned', cardLabel: 'Energy', group: 'activity', unit: 'cal', dp: 0, kind: 'bar', agg: 'sum', intraday: 'hourly_calories', defaultRange: 'day', pick: d => d.strain.calories },
  strain: { label: 'Day strain', group: 'activity', unit: '/21', dp: 1, kind: 'bar', agg: 'avg', domain: [0, 21], intraday: 'hr', defaultRange: 'week', pick: d => d.strain.score },
  zones: { label: 'Zone minutes', group: 'activity', unit: 'min', dp: 0, kind: 'bar', agg: 'sum', intraday: 'zones', defaultRange: 'week', pick: zoneMin },
  sleep: { label: 'Time asleep', group: 'sleep', unit: 'dur', dp: 0, kind: 'bar', agg: 'avg', goal: 480, better: 'higher', intraday: 'hypnogram', defaultRange: 'day', pick: d => d.sleep.duration_minutes },
  sleepScore: { label: 'Sleep score', group: 'sleep', unit: '', dp: 0, kind: 'line', agg: 'avg', better: 'higher', intraday: 'scoreDrivers', defaultRange: 'day',
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
  stress: { label: 'Stress index', group: 'heart', unit: '', dp: 0, kind: 'line', agg: 'avg', better: 'lower', defaultRange: 'month', pick: d => d.cardiovascular.stress_index,
    note: 'Derived from your nightly HRV and resting heart rate.' },
  temp: { label: 'Skin temperature', group: 'body', unit: '°C', dp: 1, kind: 'line', agg: 'avg', defaultRange: 'month', pick: d => tempIn(d.cardiovascular.temp),
    note: 'Nightly skin temperature measured at the wrist.' },
  spo2: { label: 'Blood oxygen', group: 'body', unit: '%', dp: 1, kind: 'line', agg: 'avg', better: 'higher', defaultRange: 'month', pick: d => d.cardiovascular.spo2 },
  resp: { label: 'Breathing rate', group: 'body', unit: 'br/min', dp: 1, kind: 'line', agg: 'avg', defaultRange: 'month', pick: d => d.cardiovascular.respiration_rate },
  vo2: { label: 'VO₂ max', group: 'body', unit: 'ml/kg/min', dp: 1, kind: 'line', agg: 'avg', better: 'higher', defaultRange: '3m', pick: d => d.cardiovascular.vo2_max,
    note: 'Your last measured cardio fitness score, carried forward until Fitbit measures it again.' },
};

const SECTIONS = [
  { group: 'activity', keys: ['steps', 'energy', 'strain', 'zones'] },
  { group: 'sleep', keys: ['sleep', 'sleepScore', 'efficiency'] },
  { group: 'heart', keys: ['rhr', 'hrv', 'hr', 'stress'] },
  { group: 'body', keys: ['temp', 'spo2', 'resp', 'vo2'] },
];

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

function deltaInfo(key, idx) {
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
  return { text: `${shown}${u} ${dir > 0 ? 'above' : 'below'} usual`, cls, dir };
}

function deltaHtml(key, idx) {
  const d = deltaInfo(key, idx);
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
  let links = '';
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
    return `<rect class="stage-mark" x="${x1}" y="${top + r * rowH + 6}" width="${x2 - x1}" height="${rowH - 12}" rx="4" style="fill:${st.color};animation-delay:${Math.min(i * 10, 360)}ms" data-tip="${esc(tip)}"/>`;
  }).join('');
  const ticks = [[t0, hhmm(segs[0].start)], [t1, hhmm(segs[segs.length - 1].end)]];
  const h0 = new Date(t0);
  h0.setMinutes(0, 0, 0);
  h0.setHours(h0.getHours() + 1);
  for (let t = h0.getTime(); t < t1; t += 3600000) {
    if (new Date(t).getHours() % 2 === 0 && t - t0 > 2700000 && t1 - t > 2700000) ticks.push([t, hhmm(new Date(t))]);
  }
  const xl = ticks.map(([t, lab]) => `<text x="${Math.min(Math.max(x(t), labelW + 16), w - 22)}" y="${H - 8}" text-anchor="middle">${lab}</text>`).join('');
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Sleep stages ${hhmm(segs[0].start)} to ${hhmm(segs[segs.length - 1].end)}">${rows}${links}${blocks}${xl}</svg>`;
}

// Where today's value sits in your last 30 days.
function rangeGauge(w, key, v, r) {
  const H = 76;
  const color = accent(key);
  const lo = Math.min(r.min, v), hi = Math.max(r.max, v);
  const pad = (hi - lo) * 0.08 || 1;
  const x = scale(lo - pad, hi + pad, 8, w - 8);
  const yT = 30;
  return `<svg class="chart" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${esc(valueText(key, v))}, usual range ${esc(valueText(key, r.lo))} to ${esc(valueText(key, r.hi))}">
    <rect x="8" y="${yT - 5}" width="${w - 16}" height="10" rx="5" style="fill:var(--raised)"/>
    <rect x="${x(r.lo)}" y="${yT - 5}" width="${Math.max(6, x(r.hi) - x(r.lo))}" height="10" rx="5" style="fill:${color};opacity:.35"/>
    <circle class="dot" cx="${x(v)}" cy="${yT}" r="9" style="fill:${color};stroke:var(--surface);stroke-width:3"/>
    <text x="${x(r.lo)}" y="${yT + 30}" text-anchor="middle">${esc(valueText(key, r.lo))}</text>
    <text x="${x(r.hi)}" y="${yT + 30}" text-anchor="middle">${esc(valueText(key, r.hi))}</text>
    <text x="${(x(r.lo) + x(r.hi)) / 2}" y="${yT - 14}" text-anchor="middle">usual range</text>
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
const shown = {};
function animateNumbers(root) {
  root.querySelectorAll('[data-num]').forEach(el => {
    const key = el.dataset.key;
    const to = parseFloat(el.dataset.num);
    const dp = parseInt(el.dataset.dp, 10) || 0;
    const from = shown[key] ?? to * 0.75;
    shown[key] = to;
    if (reducedMotion || from === to) { el.textContent = fmt(to, dp); return; }
    const t0 = performance.now();
    const tick = now => {
      const p = Math.min(1, (now - t0) / 520);
      el.textContent = fmt(from + (to - from) * (1 - (1 - p) ** 3), dp);
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

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, q] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const d = new URLSearchParams(q || '').get('d');
  if (d) {
    const i = dateIndex(d);
    state.idx = i >= 0 ? i : clampIdx(d < days()[0].date ? 0 : days().length - 1);
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
function route() {
  // hashchange and popstate can both fire for one navigation.
  if (location.hash === lastHash) return;
  lastHash = location.hash;
  const prevKey = lastPage;
  state.route = parseRoute();
  const pageKey = state.route.page === 'home' ? 'home' : `m:${state.route.key}`;
  const changedPage = pageKey !== prevKey;
  lastPage = pageKey;
  render({ pageEnter: changedPage });
  if (changedPage) window.scrollTo({ top: 0, behavior: 'instant' });
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
  return `<a class="card ${wide ? 'wide' : ''}" href="${hrefMetric(key, m.defaultRange, iso)}" style="--accent:${accent(key)}" aria-label="${esc(m.label)}: ${esc(valueText(key, v))}${estimated ? ', estimated' : ''}. Open details">
    <div class="card-top"><span class="glyph">${icon(key)}</span><span class="card-label">${esc(m.cardLabel || m.label)}</span>${estimated ? '<span class="tag" title="Estimated: Google’s API doesn’t provide Fitbit’s sleep score">Est.</span>' : ''}${icon('chev', 'chev')}</div>
    ${value}
    ${deltaHtml(key, state.idx)}
    ${extra || `<div class="spark">${slot('spark-' + key, w => sparkChart(w, key, vals, vals.length - 1))}</div>`}
  </a>`;
}

function workoutsCard() {
  const ws = day().strain.workouts || [];
  const glyphFor = n => (/(run|walk|hike|treadmill)/i.test(n) ? 'run' : /(football|soccer|sport|tennis|basket|cricket|badminton)/i.test(n) ? 'ball' : 'lift');
  const body = ws.length ? `<div class="workouts">${ws.map(w => `<div class="workout">
      <span class="glyph" style="--accent:var(--activity)">${icon(glyphFor(w.name))}</span>
      <div><div class="workout-name">${esc(w.name)}</div>
      <div class="workout-meta">${esc([w.time, `${w.duration_minutes} min`, w.calories ? `${w.calories} cal` : null, w.avg_hr ? `${w.avg_hr} bpm avg` : null].filter(Boolean).join(' · '))}</div></div>
    </div>`).join('')}</div>` : '<p class="empty">No workouts logged.</p>';
  return `<div class="card full" style="--accent:var(--activity)">
    <div class="card-top"><span class="glyph">${icon('lift')}</span><span class="card-label">Workouts</span></div>
    ${body}
  </div>`;
}

function pulseBackdrop(d) {
  const hr = (d.strain.intraday_hr || []).map(p => p.bpm);
  if (hr.length < 10) return '';
  const lo = Math.min(...hr), hi = Math.max(...hr);
  const y = scale(lo - 5, hi + 5, 196, 20);
  const pts = hr.map((v, i) => `${(i / (hr.length - 1) * 1000).toFixed(1)},${y(v).toFixed(1)}`);
  return `<svg class="hero-pulse" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="pulseFade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--mood)" stop-opacity=".16"/><stop offset="1" stop-color="var(--mood)" stop-opacity="0"/></linearGradient></defs>
    <path class="fill" d="M0,200L${pts.join('L')}L1000,200Z"/>
    <path d="M${pts.join('L')}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderHome() {
  const d = day();
  const iso = d.date;
  const rec = M.recovery.pick(d);
  const t = tierOf(rec);
  document.documentElement.style.setProperty('--mood', t ? t.color : 'var(--text-3)');
  const story = buildStory(d, state.idx);
  const C = 2 * Math.PI * 86;
  const rel = relativeDay(iso);

  const pill = (key, colorVar) => {
    const v = M[key].pick(d);
    return `<a class="stat-pill" href="${hrefMetric(key, M[key].defaultRange, iso)}"><i style="background:${colorVar}"></i>${esc(M[key].label === 'Day strain' ? 'Strain' : M[key].label === 'Time asleep' ? 'Sleep' : M[key].label)}<b>${esc(valueText(key, v))}</b></a>`;
  };

  const sections = SECTIONS.map(sec => {
    const g = GROUPS[sec.group];
    const cards = sec.keys.map(k => metricCard(k, { wide: k === 'sleep' })).join('') + (sec.group === 'activity' ? workoutsCard() : '');
    return `<section class="section" aria-labelledby="h-${sec.group}">
      <div class="section-head"><h2 id="h-${sec.group}">${g.label}</h2></div>
      <div class="grid">${cards}</div>
    </section>`;
  }).join('');

  return `
    <section class="hero" aria-label="Recovery">
      ${pulseBackdrop(d)}
      <a class="ring-link" href="${hrefMetric('recovery', 'day', iso)}" aria-label="Recovery ${isNum(rec) ? rec + '%' : 'no data'}. Open details">
        <svg class="ring" viewBox="0 0 196 196" aria-hidden="true">
          <circle class="ring-track" cx="98" cy="98" r="86"/>
          <circle class="ring-arc" id="ringArc" cx="98" cy="98" r="86" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-target="${isNum(rec) ? C * (1 - rec / 100) : C}"/>
        </svg>
        <div class="ring-center">
          <div class="ring-value">${isNum(rec) ? `<span data-num="${rec}" data-dp="0" data-key="ring">${rec}</span><small>%</small>` : '—'}</div>
          <div class="ring-label">Recovery</div>
          <div class="ring-tier">${t ? t.word : 'Waiting on sleep'}</div>
        </div>
      </a>
      <div class="hero-copy">
        <p class="eyebrow">${esc(rel ? `${rel} · ${fullDate(iso)}` : fullDate(iso))}</p>
        <h1 class="hero-head">${esc(story.head)}</h1>
        <p class="hero-body">${esc(story.body)}</p>
        <div class="hero-stats">
          ${pill('strain', 'var(--activity)')}
          ${pill('sleep', 'var(--sleep)')}
          ${pill('steps', 'var(--activity)')}
        </div>
      </div>
    </section>
    ${sections}
  `;
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
    ${RANGES.map(r => `<a href="${hrefMetric(key, r.key, iso)}" data-replace aria-current="${r.key === range}">${r.label}</a>`).join('')}
  </nav>`;
  const periodNav = `<div class="period">
    <a class="icon-btn" ${prevHref ? `href="${prevHref}"` : 'aria-disabled="true"'} data-replace aria-label="Previous ${range === '3m' ? 'three months' : range}">${icon('back')}</a>
    <span class="period-label">${esc(periodLabel(range, p))}</span>
    <a class="icon-btn" ${nextHref ? `href="${nextHref}"` : 'aria-disabled="true"'} data-replace aria-label="Next ${range === '3m' ? 'three months' : range}">${icon('chev')}</a>
  </div>`;

  const body = range === 'day' ? detailDay(key, color) : detailPeriod(key, range, p, color);

  return `
    <div class="detail-head">
      <a class="back" href="${hrefHome(iso)}">${icon('back')}Today</a>
    </div>
    <h1 class="detail-title"><span class="glyph" style="--accent:${color}">${icon(key)}</span>${esc(m.label)}</h1>
    <section class="panel" style="--accent:${color}">
      <div class="controls">${seg}${periodNav}</div>
      ${body.panel}
    </section>
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

function statCards(items) {
  return `<div class="stats">${items.map(s => `<div class="stat"><div class="stat-label">${esc(s.label)}</div><div class="stat-value">${esc(s.value)}</div>${s.sub ? `<div class="stat-sub">${esc(s.sub)}</div>` : ''}</div>`).join('')}</div>`;
}

function hourLabels() {
  return Array.from({ length: 24 }, (_, h) => ({ 0: '12a', 6: '6a', 12: '12p', 18: '6p' }[h] || ''));
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
  } else if (m.intraday === 'hr' || m.intraday === 'zones') {
    const hr = d.strain.intraday_hr || [];
    if (hr.length) {
      const bpm = hr.map(p => p.bpm);
      const labels = hr.map(p => ({ '00:00': '12a', '06:00': '6a', '12:00': '12p', '18:00': '6p' }[p.time] || ''));
      const tips = hr.map(p => `<b>${p.bpm} bpm</b><span>${p.time}</span>`);
      chart = slot('day', w => lineChart(w, { key: 'hr', vals: bpm, labels, color: key === 'hr' ? color : 'var(--heart)', tips, dots: false, area: true, baseline: d.cardiovascular.rhr }));
      const z = d.strain.zone_minutes || {};
      const zrows = [['fat_burn', 'Fat burn', 'var(--fair)'], ['cardio', 'Cardio', 'var(--activity)'], ['peak', 'Peak', 'var(--poor)']];
      const zmax = Math.max(1, ...zrows.map(([k]) => z[k] || 0));
      extra = `<section class="panel"><h2 class="card-label" style="font-size:1rem">Heart rate zones</h2><div class="rows">${zrows.map(([k, lab, c]) => `<div class="row">
          <div class="row-main"><div class="row-title">${lab}</div></div>
          <svg class="row-meter" viewBox="0 0 100 8" preserveAspectRatio="none" style="height:8px" aria-hidden="true"><rect width="100" height="8" rx="4" style="fill:var(--raised)"/><rect width="${(z[k] || 0) / zmax * 100}" height="8" rx="4" style="fill:${c}"/></svg>
          <div class="row-val">${z[k] || 0} min</div></div>`).join('')}</div></section>`
        + statCards([
          { label: 'Average', value: `${Math.round(mean(bpm))} bpm` },
          { label: 'Lowest', value: `${Math.min(...bpm)} bpm` },
          { label: 'Highest', value: `${Math.max(...bpm)} bpm`, sub: `at ${hr[bpm.indexOf(Math.max(...bpm))].time}` },
          { label: 'Resting', value: valueText('rhr', d.cardiovascular.rhr) },
        ]);
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
          <div class="row-main"><div class="row-title">${esc(M[k].label)}</div><div class="row-sub">${esc(valueText(k, M[k].pick(d)))} · usual ${esc(valueText(k, baselineOf(k, idx)))} · weight ${Math.round(x.weight * 100)}%</div></div>
          <svg class="row-meter" viewBox="0 0 100 10" preserveAspectRatio="none" style="height:10px" aria-hidden="true">
            <rect width="100" height="10" rx="5" style="fill:var(--raised)"/>
            <rect x="${x.impact >= 0 ? 50 : 50 - wPct}" width="${Math.max(1, wPct)}" height="10" rx="3" style="fill:var(--${cls || 'text-3'})"/>
            <rect x="49.6" width="0.8" height="10" style="fill:var(--text-3)"/></svg>
          <div class="row-val ${cls}">${x.impact > 0 ? '+' : x.impact < 0 ? '−' : ''}${fmt(Math.abs(x.impact), 1)}</div></div>`;
      }).join('')}</div><p class="note">Points each vital added to or took from your score, compared with your previous ${BASELINE_DAYS} days.</p>`;
    } else {
      chart = '<p class="empty">Recovery is calculated once last night’s HRV syncs.</p>';
    }
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

  if (!extra && m.intraday !== 'drivers') {
    extra = statCards([
      { label: 'Usual', value: valueText(key, baselineOf(key, idx)), sub: `${BASELINE_DAYS}-day average` },
      { label: 'Normal range', value: r ? `${valueText(key, r.lo)} – ${valueText(key, r.hi)}` : '--', sub: 'last 30 days' },
      { label: '30-day low', value: valueText(key, r && r.min) },
      { label: '30-day high', value: valueText(key, r && r.max) },
    ]);
  }

  const label = relativeDay(day().date) || longDate(day().date);
  const valHtml = isNum(v) ? valueHtml(key, v, 'detail-' + key) : '';
  let note = di.text && isNum(v) ? di.text : '';
  let noteCls = di.cls;
  if (key === 'sleepScore' && isNum(v)) {
    const model = state.data.overview.sleep_score_model || {};
    note = d.sleep.score_source === 'app' ? 'From the Fitbit app' : `Estimated · typically within ±${model.mae}`;
    noteCls = '';
  }
  const emptyText = key === 'sleepScore' && isNum(d.sleep.duration_minutes) ? 'No score' : 'No data';
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

  // Compare with the period before.
  const prevP = periodOf(range, isoOf(addDays(parseDate(p.start), -1)));
  const prevVals = prevP.dates.map(iso => { const i = dateIndex(iso); return i >= 0 ? m.pick(days()[i]) : null; });
  const prevS = periodSummary(key, prevVals);
  let note = '';
  let noteCls = '';
  if (s && prevS) {
    const a = s.avg, b = prevS.avg;
    const pct = b ? (a - b) / Math.abs(b) * 100 : 0;
    if (Math.abs(pct) < 0.5) note = 'Same as the previous period';
    else {
      note = `${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% ${pct > 0 ? 'higher' : 'lower'} than the previous ${range === '3m' ? '3 months' : range}`;
      if (m.better) noteCls = (pct > 0) === (m.better === 'higher') ? 'good' : 'poor';
    }
  }

  const endIdx = dateIndex(p.dates.filter(d => dateIndex(d) >= 0).pop() || day().date);
  const band = m.kind === 'line' && !m.domain ? normalRange(key, Math.max(0, endIdx)) : null;
  const chart = slot('period', w => (m.kind === 'bar'
    ? barChart(w, { key, vals, labels, color: key === 'recovery' ? (v => tierOf(v).color) : color, goal: m.goal, tips, hrefs, selPos, domain: m.domain })
    : lineChart(w, { key, vals, labels, color, tips, hrefs, selPos, band, domain: m.domain, hollow, dotColor: key === 'recovery' ? (v => tierOf(v).color) : null })));

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

// ---------- Render ----------
function render({ pageEnter = false } = {}) {
  const d = day();
  const rel = relativeDay(d.date);
  $('#dateText').textContent = rel ? `${rel}, ${shortDate(d.date)}` : longDate(d.date);
  $('#dateBtn').setAttribute('aria-label', `${longDate(d.date)}. Pick a date`);
  $('#datePicker').value = d.date;
  $('#prevDay').disabled = state.idx === 0;
  $('#nextDay').disabled = state.idx === days().length - 1;

  charts = {};
  const main = $('#main');
  main.innerHTML = state.route.page === 'home' ? renderHome() : renderDetail();
  document.title = state.route.page === 'home' ? 'OpenStrap' : `${M[state.route.key].label} · OpenStrap`;
  if (pageEnter && !reducedMotion) {
    main.classList.remove('enter', 'enter-detail');
    void main.offsetWidth;
    main.classList.add(state.route.page === 'home' ? 'enter' : 'enter-detail');
  }
  mountCharts(main, true);
  animateNumbers(main);
  const arc = $('#ringArc');
  if (arc) requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = arc.dataset.target; }));
  if (pageEnter) main.focus({ preventScroll: true });
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

// ---------- Events ----------
function bindEvents() {
  $('#prevDay').addEventListener('click', () => setDay(state.idx - 1));
  $('#nextDay').addEventListener('click', () => setDay(state.idx + 1));
  const picker = $('#datePicker');
  picker.min = days()[0].date;
  picker.max = days()[days().length - 1].date;
  $('#dateBtn').addEventListener('click', () => { try { picker.showPicker(); } catch { picker.click(); } });
  picker.addEventListener('change', e => { const i = dateIndex(e.target.value); if (i >= 0) setDay(i); });

  document.addEventListener('click', e => {
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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.data = await loadJson('dashboard_data.json');
  } catch {
    try {
      // Not connected yet: show the bundled sample data.
      state.data = await loadJson('demo_data.json');
      state.demo = true;
      shiftDemoDates(state.data);
    } catch (err) {
      console.error(err);
      $('#main').innerHTML = '<section class="panel"><h1 class="detail-title">Couldn’t load any data</h1><p class="note">Run <code>python3 setup.py</code> to connect your Fitbit, then reload.</p></section>';
      return;
    }
  }
  state.idx = days().length - 1;
  M.temp.unit = useF() ? '°F' : '°C';
  const p = state.data.profile;
  const initials = (p.name || '').split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
  $('#avatar').textContent = initials;
  $('#avatar').hidden = !initials || state.demo;
  $('#demoBanner').hidden = !state.demo;
  const o = state.data.overview;
  $('#foot').textContent = state.demo
    ? 'Sample data for a fictional person'
    : `${o.total_days_analyzed} days from Fitbit · ${shortDate(o.date_start)} – ${shortDate(o.date_end)}`;
  bindEvents();
  route();
});
