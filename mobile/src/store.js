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

// Small settings are also kept in localStorage. If the phone ever clears the
// IndexedDB database (seen on some iPhones' home-screen web apps), the app
// restores these instead of asking for sign-in and sex again.
const MIRRORED = new Set(['signedIn', 'profile', 'sexAsked', 'tempUnit', 'webToken', 'labels']);
const LS = 'ds-mirror:';
const lsGet = key => { try { const v = localStorage.getItem(LS + key); return v === null ? undefined : JSON.parse(v); } catch { return undefined; } };
const lsSet = (key, value) => { try { if (value === undefined) localStorage.removeItem(LS + key); else localStorage.setItem(LS + key, JSON.stringify(value)); } catch { /* storage full or blocked */ } };

const idbGet = key => tx('readonly', s => s.get(key));
export async function get(key) {
  const v = await idbGet(key);
  if (v !== undefined || !MIRRORED.has(key)) return v;
  const backup = lsGet(key);
  if (backup !== undefined) {
    wiped = true;
    await tx('readwrite', s => { s.put(backup, key); }).catch(() => {});
  }
  return backup;
}
export const set = (key, value) => {
  if (MIRRORED.has(key)) lsSet(key, value);
  return tx('readwrite', s => { s.put(value, key); });
};
export const del = key => {
  if (MIRRORED.has(key)) lsSet(key, undefined);
  return tx('readwrite', s => { s.delete(key); });
};

/** True once a setting had to be restored from the backup copy this session. */
let wiped = false;
export const wasWiped = () => wiped;

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
