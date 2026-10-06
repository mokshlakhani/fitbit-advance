// Runs both parity tests (JS engine and JS ingest vs the Python pipeline) on
// this computer's data. Needs the desktop setup (../.venv, api_data/).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const python = join(here, '..', '..', '.venv', 'bin', 'python');
const dir = mkdtempSync(join(tmpdir(), 'datastrap-parity-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
try {
  run(python, [join(here, '..', 'make_seed.py'), join(dir, 'parity_input.json'), join(dir, 'parity_expected.json')]);
  run(python, [join(here, 'dump_api.py'), dir]);
  run(process.execPath, [join(here, 'parity.mjs'), dir]);
  run(process.execPath, [join(here, 'ingest_parity.mjs'), dir]);
  run(python, [join(here, 'dump_synthetic.py'), dir]);
  run(process.execPath, [join(here, 'synthetic_parity.mjs'), dir]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
