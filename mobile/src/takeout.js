// Reads VO2 max from a Google Takeout export, the only place Fitbit provides
// it (the Google Health API has none), so fitness age can be shown.
//
// Accepts the Takeout .zip itself (read as a stream: only the VO2 max files
// are unpacked, so multi-gigabyte exports are fine) or the extracted
// demographic_vo2_max-*.json files. Same parsing as load_vo2_max() in
// process_fitbit_openstrap.py.
import { Unzip, UnzipInflate } from './fflate.js';
import { pyRound } from './engine.js';

const VO2_FILE = /demographic_vo2_max-[^/]*\.json$/;

function parseVo2(text, out) {
  for (const item of JSON.parse(text)) {
    const [m, d, y] = item.dateTime.split(' ')[0].split('/');
    const v = item.value || {};
    const val = v.filteredDemographicVO2Max ?? v.demographicVO2Max;
    if (val == null) continue;
    out[`20${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`] = pyRound(Number(val), 1);
  }
}

function readZip(file, onFile) {
  return new Promise((resolve, reject) => {
    const pending = [];
    const unzip = new Unzip(entry => {
      if (!VO2_FILE.test(entry.name)) return; // skipped without unpacking
      const chunks = [];
      pending.push(new Promise((res, rej) => {
        entry.ondata = (err, chunk, final) => {
          if (err) return rej(err);
          chunks.push(chunk);
          if (final) res(onFile(new TextDecoder().decode(concat(chunks))));
        };
      }));
      entry.start();
    });
    unzip.register(UnzipInflate);
    const reader = file.stream().getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) {
        unzip.push(new Uint8Array(0), true);
        Promise.all(pending).then(resolve, reject);
        return;
      }
      unzip.push(value);
      pump();
    }).catch(reject);
    pump();
  });
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let i = 0;
  for (const c of chunks) { out.set(c, i); i += c.length; }
  return out;
}

/** Files picked by the person -> {date: VO2 max}. */
export async function importTakeout(files) {
  const vo2 = {};
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) await readZip(file, text => parseVo2(text, vo2));
    else if (VO2_FILE.test(file.name)) parseVo2(await file.text(), vo2);
  }
  return vo2;
}
