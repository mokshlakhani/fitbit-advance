// Checks the JS engine against the Python pipeline on the same inputs.
// Usage: python mobile/make_seed.py DIR/parity_input.json DIR/parity_expected.json && node mobile/test/parity.mjs DIR
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/engine.js';

const dir = process.argv[2];
const input = JSON.parse(readFileSync(join(dir, 'parity_input.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(dir, 'parity_expected.json'), 'utf8'));
const lastDay = expected.days[expected.days.length - 1].date;
const actual = JSON.parse(JSON.stringify(assemble(input.src, input.profile, input.labels, { today: lastDay })));

const diffs = [];
function compare(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 1e-9) diffs.push(`${path}: python ${a} js ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) diffs.push(`${path}: python ${JSON.stringify(a)} js ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) compare(a[k], b[k], `${path}.${k}`);
}
compare(expected, actual, '$');
console.log(`${expected.days.length} days compared, ${diffs.length} differences`);
for (const d of diffs.slice(0, 40)) console.log('  ' + d);
process.exit(diffs.length ? 1 : 0);
