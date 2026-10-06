// Everything the app keeps on the phone, in one IndexedDB key-value store:
//   profile, labels, seed, lastSync, dashboard  (small records)
//   points:<type>            {pointKey: point} for summary/session types
//   rows:<type>:<utcDay>     compact rows for steps / total-calories
//   hr:<utcDay>              full-resolution heart rate for one UTC day
//                            {t: Int32Array seconds into the day, bpm: Uint8Array}
//   hrmin:<utcDay>           per-minute {sums, counts} derived from hr:<utcDay>
const DB_NAME = 'datastrap';
const STORE = 'kv';

let dbPromise;
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const get = key => tx('readonly', s => s.get(key));
export const set = (key, value) => tx('readwrite', s => { s.put(value, key); });
export const del = key => tx('readwrite', s => { s.delete(key); });

/** {key: value} for every key starting with `prefix`. */
export function getPrefix(prefix) {
  return db().then(d => new Promise((resolve, reject) => {
    const out = {};
    const t = d.transaction(STORE, 'readonly');
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const req = t.objectStore(STORE).openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out[c.key] = c.value;
      c.continue();
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  }));
}

export function keysWithPrefix(prefix) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export function clearAll() {
  return tx('readwrite', s => { s.clear(); });
}
