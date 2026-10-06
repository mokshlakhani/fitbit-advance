// Parity on synthetic people (ages 22 and 45, men, women, unknown sex; 200 days).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/engine.js';

const cases = JSON.parse(readFileSync(join(process.argv[2], 'synthetic.json'), 'utf8'));
let diffs = 0;
function compare(a, b, path) {
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-9) report(); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) report(); return; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[k], b[k], `${path}.${k}`);
  function report() { if (diffs++ < 20) console.log(`  ${path}: python ${JSON.stringify(a)} js ${JSON.stringify(b)}`); }
}
cases.forEach((c, i) => {
  const last = c.expected.days[c.expected.days.length - 1].date;
  const actual = JSON.parse(JSON.stringify(assemble(c.src, c.profile, {}, { today: last })));
  compare(c.expected, actual, `case${i}`);
  const b = c.expected.days[c.expected.days.length - 1].bio_age;
  console.log(`case ${i} (${c.profile.chronological_age}, ${c.profile.sex}): body age ${b.value} (${b.delta}) ±${b.sigma} pace ${b.pace}`);
});
console.log(`${cases.length} synthetic cases, ${diffs} differences`);
process.exit(diffs ? 1 : 0);
