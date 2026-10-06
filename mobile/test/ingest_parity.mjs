// Checks the JS ingest against api_ingest.py on the desktop's api_data/ folder.
// Usage: python mobile/test/dump_api.py DIR && node mobile/test/ingest_parity.mjs DIR
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApiSources, loadWorkoutSamples } from '../src/ingest.js';

const API = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api_data');
const expected = JSON.parse(readFileSync(join(process.argv[2], 'api_expected.json'), 'utf8'));
const raw = { points: {}, rows: {} };
for (const t of ['daily-heart-rate-variability', 'daily-resting-heart-rate', 'daily-oxygen-saturation',
  'daily-sleep-temperature-derivations', 'daily-respiratory-rate', 'sleep', 'exercise']) {
  const f = join(API, `${t}.json`);
  raw.points[t] = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}
for (const t of ['heart-rate', 'steps', 'total-calories']) {
  raw.rows[t] = {};
  for (const f of readdirSync(join(API, t)).filter(f => f.endsWith('.csv.gz'))) {
    const lines = gunzipSync(readFileSync(join(API, t, f))).toString().trim().split('\n').slice(1);
    const rows = lines.filter(Boolean).map(l => l.split(','));
    // Keep the columns the phone stores: heart-rate [time, bpm]; steps/calories [start, end, value].
    raw.rows[t][f.slice(0, 10)] = rows.map(r => (t === 'heart-rate' ? [r[0], r[1]] : [r[0], r[1], r[2]]));
  }
}
const t0 = Date.now();
const actual = JSON.parse(JSON.stringify(loadApiSources(raw, expected.tz)));
// Workout samples: from the same rows, stored the way the phone stores them.
const hrDays = {};
for (const [day, rows] of Object.entries(raw.rows['heart-rate'])) {
  const start = Date.parse(`${day}T00:00:00Z`);
  const pairs = rows.map(([t, b]) => [Math.round((Date.parse(t) - start) / 1000), Number(b)]).sort((x, y) => x[0] - y[0]);
  hrDays[day] = { t: pairs.map(p => p[0]), bpm: pairs.map(p => p[1]) };
}
actual.workout_hr = loadWorkoutSamples(hrDays, expected.tz, actual.workouts);
console.log(`ingest took ${Date.now() - t0} ms`);
let diffs = 0;
function compare(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-9) report(); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) report(); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], `${path}.${k}`);
  function report() { if (diffs++ < 30) console.log(`  ${path}: python ${JSON.stringify(a)} js ${JSON.stringify(b)}`); }
}
for (const k of Object.keys(expected)) if (k !== 'tz') compare(expected[k], actual[k], k);
console.log(`${diffs} differences`);
process.exit(diffs ? 1 : 0);
