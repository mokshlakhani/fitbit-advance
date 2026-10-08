// DataStrap on a phone: the Android app and the web app (iPhone home screen,
// any browser). Signs in to Google, downloads from the Google Health API,
// computes everything with engine.js on the device, and hands the result to
// the dashboard (app.js) through window.DataStrapHost / window.DataStrap.
import * as store from './store.js';
import { sync, loadRaw, dashboardProfile, logWorkout as logWorkoutApi, deleteWorkout as deleteWorkoutApi } from './google.js';
import { loadApiSources, mergeSources, loadWorkoutSamples, workoutUtcDays, localDayReadings } from './ingest.js';
import { assemble } from './engine.js';
import * as webauth from './webauth.js';

const FIRST_SYNC_DAYS = 90;
const FIRST_SYNC_DAYS_WITH_SEED = 30;
const SYNC_DAYS = 7;
const HR_BACKFILL_PER_SYNC = 14; // older heart-rate days fill in over several syncs
const AUTO_SYNC_MS = 5 * 60 * 1000;
const SILENT_REDIRECT_GAP_MS = 10 * 60 * 1000;
// Bump when engine.js changes what it computes, so phones recompute instead of
// showing a cached dashboard from the old version.
const ENGINE_VERSION = 9;

const cap = window.Capacitor;
const NATIVE = Boolean(cap?.isNativePlatform?.());
const Auth = NATIVE ? cap.registerPlugin('GoogleHealthAuth') : null;

// iPhone/iPad (iPadOS reports as a Mac with touch): the frosted tab bar is cheap there.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) document.documentElement.classList.add('ios');

const ui = { state: 'idle', detail: '', error: '', note: '' };
let syncing = null;
let seedPromise;

// ---------- Seed and settings ----------
// seed.json is history from the computer (see make_seed.py), bundled into
// personal Android builds only. Everything works without it.
function loadSeed() {
  seedPromise ||= NATIVE
    ? fetch('seed.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);
  return seedPromise;
}

async function profile() {
  const seed = await loadSeed();
  const sp = seed?.profile || {};
  const base = {
    name: sp.name || null, age: sp.chronological_age ?? null, sex: sp.sex ?? null,
    height_cm: sp.height_cm ?? null, weight_kg: sp.weight_kg ?? null,
    timezone: sp.timezone ?? null, temperature_unit: sp.temperature_unit ?? null,
  };
  const saved = (await store.get('profile')) || {};
  for (const [k, v] of Object.entries(saved)) if (v != null) base[k] = v;
  // Temperature unit: your choice in the sheet, else the unit set on your
  // computer (seed), else Google's setting.
  const chosen = await store.get('tempUnit');
  if (chosen) base.temperature_unit = chosen;
  else if (sp.temperature_unit) base.temperature_unit = sp.temperature_unit;
  return base;
}

async function labels() {
  const seed = await loadSeed();
  return { ...(seed?.labels || {}), ...((await store.get('labels')) || {}) };
}

// ---------- Compute ----------
async function compute() {
  const seed = await loadSeed();
  const prof = dashboardProfile(await profile());
  const raw = await loadRaw();
  const api = loadApiSources(raw, prof.timezone);
  const base = { ...(seed?.src || {}) };
  base.vo2 = { ...((await store.get('takeoutVo2')) || {}), ...(base.vo2 || {}) };
  const src = mergeSources(base, api);
  // Raw heart rate (every ~2 s) around each workout, from the downloaded days.
  const hrDays = {};
  for (const day of workoutUtcDays(src.workouts)) {
    const v = await store.get(`hr:${day}`);
    if (v) hrDays[day] = v;
  }
  Object.assign(src.workout_hr, loadWorkoutSamples(hrDays, prof.timezone, src.workouts));
  const hasData = ['hrv', 'sleep', 'intraday_hr'].some(k => Object.keys(src[k]).length);
  if (!hasData) return null;
  const data = assemble(src, prof, await labels());
  await store.set('dashboard', data);
  await store.set('dashboardVersion', ENGINE_VERSION);
  return data;
}

async function recomputeAndShow() {
  const data = await compute();
  if (data) {
    document.body.classList.remove('m-empty');
    window.DataStrap.refresh(data);
    askSexOnce();
  }
  return data;
}

// Google doesn't share sex, and strain (Banister TRIMP) and body age depend on
// it, so ask once after the first data arrives. Skipping uses the average of
// the men's and women's formulas; the sync sheet can change it later.
let sexPromptShown = false;
async function askSexOnce() {
  if (sexPromptShown || (await profile()).sex || (await store.get('sexAsked'))) return;
  sexPromptShown = true;
  const el = document.createElement('div');
  el.className = 'm-sheet';
  el.innerHTML = `<div class="m-scrim"></div><div class="m-panel" role="dialog" aria-modal="true" aria-labelledby="sexTitle">
    <div class="m-grab"></div><div class="m-body">
      <h2 class="m-title" id="sexTitle">One question</h2>
      <p class="m-note">Google doesn't share this. Strain and body age use different formulas for men and women, so they're more accurate when the app knows.</p>
      <div class="m-pair"><button class="m-btn primary" data-sex="male">Male</button><button class="m-btn primary" data-sex="female">Female</button></div>
      <button class="m-btn m-skip" data-sex="">Skip</button>
      <p class="m-note">You can change this later under ↻.</p>
    </div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-sex]');
    if (!b) return;
    await store.set('sexAsked', true);
    if (b.dataset.sex) {
      const saved = (await store.get('profile')) || {};
      saved.sex = b.dataset.sex;
      await store.set('profile', saved);
    }
    el.classList.remove('open');
    setTimeout(() => el.remove(), 260);
    if (b.dataset.sex) await recomputeAndShow();
  });
}

// ---------- Google sign-in ----------
async function getToken({ refresh = false, stale = null, interactive = false } = {}) {
  if (!NATIVE) return webauth.getToken({ refresh });
  if (refresh && stale) await Auth.clearToken({ token: stale }).catch(() => {});
  const r = await Auth.authorize({ interactive });
  return r.accessToken;
}

async function signIn() {
  try {
    setUi('syncing', 'Signing in');
    if (!NATIVE) {
      await webauth.signIn(); // leaves the page; completeRedirect() finishes on return
      return;
    }
    await getToken({ interactive: true });
    await store.set('signedIn', true);
    await runSync();
  } catch (err) {
    setUi('error', '', err.code === 'CANCELED' ? 'Sign-in was cancelled.' : String(err.message || err));
  }
}

async function signOut() {
  if (NATIVE) await Auth.signOut().catch(() => {});
  else await webauth.signOut();
  await store.set('signedIn', false);
  setUi('signedOut');
}

// Web only: Google's browser tokens last an hour. When one runs out, go to
// Google and straight back (no screen while still signed in to Google). At
// most once every 10 minutes, so a problem can't cause a redirect loop.
function silentRefreshAllowed() {
  const last = Number(localStorage.getItem('ds-silent') || 0);
  return Date.now() - last > SILENT_REDIRECT_GAP_MS;
}

async function refreshSilently() {
  localStorage.setItem('ds-silent', String(Date.now()));
  await webauth.refreshSilently();
}

// ---------- Sync ----------
// `background`: the 5-minute timer. The web app's Google pass lasts an hour and
// renewing it means a trip to Google and back, so a background sync never does
// that mid-use; it waits for the next open, return to the app, or ↻.
async function runSync({ background = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!(await store.get('signedIn'))) { setUi('signedOut'); return; }
      if (!NATIVE && !(await webauth.hasValidToken())) {
        if (background) return;
        if (document.visibilityState === 'visible' && silentRefreshAllowed()) {
          setUi('syncing', 'Refreshing Google sign-in');
          await refreshSilently().catch(e => setUi('error', '', String(e.message || e)));
        } else {
          setUi('signedOut', '', 'Google sign-in has expired. Sign in again to sync.');
        }
        return;
      }
      const seed = await loadSeed();
      const first = !(await store.get('lastSync'));
      const days = first ? (seed ? FIRST_SYNC_DAYS_WITH_SEED : FIRST_SYNC_DAYS) : SYNC_DAYS;
      const historyDays = seed ? FIRST_SYNC_DAYS_WITH_SEED : FIRST_SYNC_DAYS;
      const t0 = performance.now();
      setUi('syncing', first ? 'Downloading your latest data' : 'Checking for new data');
      const report = await sync({
        getToken, phase: 'recent', days, historyDays,
        onProgress: (n, total) => setUi('syncing', first ? `Downloading your latest data · ${n}/${total}` : 'Checking for new data'),
      });
      // Recompute only when something new arrived (or nothing is on screen yet).
      if (report.fetched || first || !(await store.get('dashboard'))) {
        setUi('syncing', 'Updating');
        await recomputeAndShow();
      }
      const seconds = (performance.now() - t0) / 1000;
      await store.set('lastSyncSeconds', seconds);
      if (report.errors.length) setUi('error', '', `Some data didn’t download: ${report.errors[0]}`, '');
      else setUi('idle', '', '', '');
      runHistory(historyDays);
    } catch (err) {
      if (err.code === 'NEEDS_REDIRECT' && background) {
        // Leave it for the next open, return or ↻.
      } else if (err.code === 'NEEDS_REDIRECT' && silentRefreshAllowed() && document.visibilityState === 'visible') {
        await refreshSilently().catch(e => setUi('error', '', String(e.message || e)));
      } else if (['NEEDS_CONSENT', 'NEEDS_REDIRECT'].includes(err.code) || err.status === 401 || err.status === 403) {
        await store.set('signedIn', false);
        setUi('signedOut', '', 'Google sign-in has expired. Sign in again to keep syncing.');
      } else {
        setUi('error', '', String(err.message || err));
      }
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// Older days and the profile, after the dashboard has updated. Quiet: the sync
// button doesn't spin for it.
let history = null;
function runHistory(historyDays) {
  if (history) return history;
  history = sync({ getToken, phase: 'history', days: SYNC_DAYS, historyDays, backfillLimit: { 'heart-rate': HR_BACKFILL_PER_SYNC } })
    .then(async report => {
      if (report.fetched) await recomputeAndShow();
      const note = report.pending ? `${report.pending} older days of heart rate still to download; they’ll come in over the next few syncs.` : '';
      if (ui.state !== 'syncing') setUi(ui.state, ui.detail, ui.error, note);
    })
    .catch(() => { /* the next sync retries */ })
    .finally(() => { history = null; });
  return history;
}

// ---------- Takeout (VO2 max) ----------
async function importTakeoutFiles(files) {
  setUi('syncing', 'Reading your Takeout export');
  try {
    const { importTakeout } = await import('./takeout.js');
    const vo2 = await importTakeout(files);
    const n = Object.keys(vo2).length;
    if (!n) {
      setUi('error', '', 'No VO₂ max found. Choose the Takeout .zip, or the demographic_vo2_max files inside “Google Health/Global Export Data”.');
      return;
    }
    await store.set('takeoutVo2', { ...((await store.get('takeoutVo2')) || {}), ...vo2 });
    await recomputeAndShow();
    setUi('idle', '', '', `Imported VO₂ max for ${n} days.`);
  } catch (err) {
    setUi('error', '', `Couldn’t read that file: ${err.message || err}`);
  }
}

// ---------- UI ----------
const ICON_SYNC = ph('refresh', '', 'bold');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function setUi(state, detail = '', error = '', note = ui.note) {
  Object.assign(ui, { state, detail, error, note });
  const btn = document.getElementById('syncBtn');
  if (btn) {
    btn.dataset.state = state;
    btn.setAttribute('aria-label', state === 'syncing' ? 'Syncing' : 'Sync and settings');
  }
  const sheet = document.getElementById('syncSheet');
  if (sheet && !sheet.hidden) renderSheet();
  renderFirstSync();
}

function viewedDate() {
  const m = /[?&]d=(\d{4}-\d{2}-\d{2})/.exec(location.hash);
  if (m) return m[1];
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Feedback ----------
// Messages go to the owner's Google Form (web.config.json → feedback), so
// friends need no account and the owner reads them in Google Forms or Sheets.
// Only what the person types is sent, plus which app, page and version they're
// on; no health data.
// Whether the browser keeps this app's storage, and whether it was cleared,
// for feedback and crash reports (helps explain "asked to sign in again").
let storageNote = 'unknown';
(async () => {
  try {
    const kept = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    await store.get('signedIn');
    storageNote = `${kept === null ? 'n/a' : kept ? 'kept' : 'not kept'}${store.wasWiped() ? ', was cleared' : ''}`;
  } catch { storageNote = 'error'; }
})();

let appConfigPromise;
const appConfig = () => (appConfigPromise ||= fetch('config.json').then(r => (r.ok ? r.json() : {})).catch(() => ({})));

function feedbackContext() {
  const v = (document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '').match(/v=(\d+)/)?.[1] || '?';
  const platform = NATIVE ? 'Android app'
    : /iphone|ipad/i.test(navigator.userAgent) ? (navigator.standalone ? 'iPhone home-screen app' : 'iPhone Safari')
      : /android/i.test(navigator.userAgent) ? 'Android browser' : 'Browser';
  const page = (location.hash.split('?')[0] || '#/').slice(1) || '/';
  return `v${v} · ${platform} · page ${page} · storage ${storageNote} · ${new Date().toISOString()}`;
}

async function sendFeedback(form) {
  const cfg = (await appConfig()).feedback;
  const f = new FormData(form);
  const text = String(f.get('message') || '').trim();
  const kind = String(f.get('kind') || 'Other');
  if (!text) return { error: 'Write a message first.' };
  const body = new URLSearchParams({
    [cfg.fields.message]: `[${kind}] ${text}`,
    [cfg.fields.contact]: String(f.get('contact') || '').trim(),
    [cfg.fields.context]: feedbackContext(),
  });
  try {
    // Google Forms doesn't allow reading the reply from another site, so a
    // completed request is taken as delivered.
    await fetch(cfg.formUrl, { method: 'POST', mode: 'no-cors', body });
    return { ok: true };
  } catch {
    return { error: 'Couldn’t send. Check your connection and try again.' };
  }
}

async function feedbackHtml() {
  if (!(await appConfig()).feedback) return '';
  return `
    <h2 class="m-title">Send feedback</h2>
    <p class="m-note">Found a bug or have an idea? It goes straight to the person who runs DataStrap. Only what you write here is sent, with the app version and page you’re on.</p>
    <form class="m-feedback" data-form="feedback" novalidate>
      <div class="m-seg" role="radiogroup" aria-label="Kind of feedback">
        ${['Bug', 'Idea', 'Other'].map((k, i) => `<label><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}><span>${k}</span></label>`).join('')}
      </div>
      <label class="m-field"><span>Message</span>
        <textarea class="m-input" name="message" id="feedbackMessage" rows="4" maxlength="2000" placeholder="What happened, or what would you like?"></textarea></label>
      <label class="m-field"><span>Name or email <small>(optional, if you’d like a reply)</small></span>
        <input class="m-input" name="contact" id="feedbackContact" type="text" maxlength="120" autocomplete="email"></label>
      <p class="m-note m-feedback-status" role="status"></p>
      <button class="m-btn primary" type="submit">Send feedback</button>
    </form>`;
}

let sheetMode = 'all'; // 'feedback' when opened from the feedback button
async function renderSheet(mode = sheetMode) {
  const sheet = document.getElementById('syncSheet');
  const [signedIn, lastSync, lab, prof, vo2, lastSeconds, tempUnit] = [
    await store.get('signedIn'), await store.get('lastSync'), await labels(), await profile(),
    (await store.get('takeoutVo2')) || {}, await store.get('lastSyncSeconds'), await store.get('tempUnit'),
  ];
  const date = viewedDate();
  const status = ui.state === 'syncing'
    ? `<span class="m-spin"></span>${esc(ui.detail || 'Syncing')}`
    : signedIn ? `Last synced ${ago(lastSync)}${lastSeconds ? ` · took ${lastSeconds < 10 ? lastSeconds.toFixed(1) : Math.round(lastSeconds)} s` : ''}` : 'Not connected to Google';
  const sexOpt = (v, label) => `<option value="${v}" ${(prof.sex || '') === v ? 'selected' : ''}>${label}</option>`;
  if (mode === 'feedback') {
    sheet.querySelector('.m-body').innerHTML = await feedbackHtml();
    sheet.querySelector('#feedbackMessage')?.focus({ preventScroll: true });
    return;
  }
  sheet.querySelector('.m-body').innerHTML = `
    <h2 class="m-title">Sync</h2>
    <p class="m-status">${status}</p>
    ${ui.error ? `<p class="m-error">${esc(ui.error)}</p>` : ''}
    ${ui.note ? `<p class="m-note">${esc(ui.note)}</p>` : ''}
    ${signedIn
      ? `<button class="m-btn primary" data-act="sync" ${ui.state === 'syncing' ? 'disabled' : ''}>Sync now</button>`
      : '<button class="m-btn primary" data-act="signin">Sign in with Google</button>'}
    <p class="m-note">Updates when you open the app and every 5 minutes while it’s open. New readings appear after your Fitbit syncs to the Fitbit app.</p>

    <h2 class="m-title">Fitbit app sleep score</h2>
    <p class="m-note">Google doesn’t share the app’s sleep score, so DataStrap estimates it. Entering the app’s score for a night uses the real value and teaches the estimate.</p>
    <form class="m-row" data-form="score">
      <input class="m-input" type="date" name="date" value="${date}" required>
      <input class="m-input" type="number" name="score" min="0" max="100" inputmode="numeric" placeholder="Score" value="${lab[date] ?? ''}" required>
      <button class="m-btn" type="submit">Save</button>
    </form>
    <p class="m-note">${Object.keys(lab).length} nights entered.</p>

    <h2 class="m-title">Units</h2>
    <label class="m-field">
      <span>Temperature</span>
      <select class="m-input" data-field="tempUnit">
        <option value="" ${!tempUnit ? 'selected' : ''}>Automatic (${prof.temperature_unit === 'FAHRENHEIT' ? '°F' : '°C'})</option>
        <option value="CELSIUS" ${tempUnit === 'CELSIUS' ? 'selected' : ''}>°C</option>
        <option value="FAHRENHEIT" ${tempUnit === 'FAHRENHEIT' ? 'selected' : ''}>°F</option>
      </select>
    </label>

    <h2 class="m-title">About you</h2>
    <label class="m-field">
      <span>Sex <small>(Google doesn’t share it; strain uses it)</small></span>
      <select class="m-input" data-field="sex">${sexOpt('', 'Not set')}${sexOpt('male', 'Male')}${sexOpt('female', 'Female')}</select>
    </label>

    <h2 class="m-title">VO₂ max and fitness age</h2>
    <p class="m-note">Google’s API doesn’t include VO₂ max. Import it from a Google Takeout export (takeout.google.com → Fitbit). Choose the downloaded .zip; only the VO₂ max files are read, and nothing is uploaded.</p>
    <label class="m-btn m-file">Import from Takeout<input type="file" accept=".zip,.json,application/zip,application/json" multiple data-field="takeout" hidden></label>
    <p class="m-note">${Object.keys(vo2).length ? `${Object.keys(vo2).length} days of VO₂ max imported.` : 'None imported yet.'}</p>

    ${await feedbackHtml()}

    ${signedIn ? '<button class="m-btn quiet" data-act="signout">Sign out of Google</button>' : ''}
  `;
}

function openSheet(mode = 'all') {
  const sheet = document.getElementById('syncSheet');
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  sheetMode = typeof mode === 'string' ? mode : 'all';
  renderSheet();
}

function closeSheet() {
  const sheet = document.getElementById('syncSheet');
  sheet.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; }, 220);
}

function mountUi() {
  const avatar = document.getElementById('avatar');
  const btn = document.createElement('button');
  btn.id = 'syncBtn';
  btn.type = 'button';
  btn.className = 'icon-btn sync-btn';
  btn.innerHTML = ICON_SYNC;
  // Feedback sits right next to sync: same size, its own speech-bubble icon
  // and accent ring so it reads as "send feedback" at a glance.
  const fb = document.createElement('button');
  fb.id = 'feedbackBtn';
  fb.type = 'button';
  fb.className = 'icon-btn feedback-btn';
  fb.setAttribute('aria-label', 'Send feedback');
  fb.title = 'Send feedback';
  fb.innerHTML = ph('feedback', '', 'bold');
  fb.hidden = true;
  appConfig().then(c => { fb.hidden = !c.feedback; });
  fb.addEventListener('click', () => openSheet('feedback'));
  const actions = document.createElement('div');
  actions.className = 'm-actions';
  actions.append(fb, btn);
  avatar.replaceWith(actions);
  // app.js still sets the initials on #avatar; keep a detached one for it.
  avatar.style.display = 'none';
  document.body.appendChild(avatar);

  const sheet = document.createElement('div');
  sheet.id = 'syncSheet';
  sheet.className = 'm-sheet';
  sheet.hidden = true;
  sheet.innerHTML = '<div class="m-scrim" data-act="close"></div><div class="m-panel" role="dialog" aria-modal="true" aria-label="Sync"><div class="m-grab"></div><div class="m-body"></div></div>';
  document.body.appendChild(sheet);

  btn.addEventListener('click', openSheet);
  sheet.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeSheet();
    if (act === 'sync') runSync();
    if (act === 'signin') signIn();
    if (act === 'signout') signOut();
  });
  sheet.addEventListener('change', async e => {
    const field = e.target.dataset?.field;
    if (field === 'sex') {
      const saved = (await store.get('profile')) || {};
      saved.sex = e.target.value || null;
      await store.set('profile', saved);
      await recomputeAndShow();
    }
    if (field === 'tempUnit') {
      await store.set('tempUnit', e.target.value || null);
      await recomputeAndShow();
      renderSheet();
    }
    if (field === 'takeout' && e.target.files.length) await importTakeoutFiles([...e.target.files]);
  });
  sheet.addEventListener('submit', async e => {
    e.preventDefault();
    if (e.target.dataset.form === 'feedback') {
      const form = e.target;
      const btn = form.querySelector('button[type="submit"]');
      const status = form.querySelector('.m-feedback-status');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const res = await sendFeedback(form);
      if (res.ok) {
        form.reset();
        status.textContent = 'Thanks. Your feedback was sent.';
        btn.textContent = 'Sent';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Send feedback'; }, 8000);
      } else {
        status.textContent = res.error;
        btn.disabled = false;
        btn.textContent = 'Send feedback';
      }
      return;
    }
    const f = new FormData(e.target);
    const score = Number(f.get('score'));
    if (!(score >= 0 && score <= 100)) return;
    const saved = (await store.get('labels')) || {};
    saved[f.get('date')] = score;
    await store.set('labels', saved);
    await recomputeAndShow();
    renderSheet();
  });
}

// Signed in but nothing computed yet (the first download): show progress
// rather than the sign-in screen.
function showFirstSync() {
  document.body.classList.add('m-empty');
  document.getElementById('main').innerHTML = `
    <section class="panel m-connect m-first" aria-live="polite">
      <div class="m-first-ring" aria-hidden="true"><span></span></div>
      <h1 class="detail-title">Downloading your data</h1>
      <p class="note" id="firstSyncMsg"></p>
      <p class="m-note">The first download takes a minute or two. Keep the app open.</p>
      <p class="m-error" id="firstSyncErr"></p>
      <button class="m-btn primary" id="firstSyncRetry" hidden>Try again</button>
    </section>
    <div class="m-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`;
  document.getElementById('firstSyncRetry').addEventListener('click', () => runSync());
  renderFirstSync();
}

function renderFirstSync() {
  const msg = document.getElementById('firstSyncMsg');
  if (!msg) return;
  msg.textContent = ui.state === 'syncing' ? (ui.detail || 'Starting') : ui.state === 'error' ? 'The download stopped.' : 'Waiting to start';
  document.getElementById('firstSyncErr').textContent = ui.error || '';
  document.getElementById('firstSyncRetry').hidden = ui.state !== 'error';
}

function showConnect(message = '') {
  document.body.classList.add('m-empty');
  document.getElementById('main').innerHTML = `
    <section class="panel m-connect">
      <h1 class="detail-title">Connect your Fitbit</h1>
      <p class="note">DataStrap reads your Fitbit data from Google Health and works everything out on this device. Your data isn’t sent anywhere else.</p>
      <button class="m-btn primary" id="connectBtn">Sign in with Google</button>
      <p class="m-error" id="connectErr">${esc(message)}</p>
      ${NATIVE ? '' : '<p class="m-note">On iPhone: tap Share, then <b>Add to Home Screen</b>, and open DataStrap from there.</p>'}
    </section>`;
  document.getElementById('connectBtn').addEventListener('click', async () => {
    await signIn();
    if (ui.error) document.getElementById('connectErr').textContent = ui.error;
  });
}

// ---------- Pull to refresh, haptics ----------
const tick = ms => { try { navigator.vibrate?.(ms); } catch { /* not supported (iPhone) */ } };

function pullToRefresh() {
  const ind = document.createElement('div');
  ind.className = 'm-ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = ICON_SYNC;
  document.body.appendChild(ind);
  const THRESHOLD = 72;
  let startY = null;
  let pull = 0;
  let armed = false;
  const reset = () => { ind.style.transform = ''; ind.style.opacity = ''; ind.classList.remove('ready', 'dragging'); };
  addEventListener('touchstart', e => {
    const sheetOpen = !document.getElementById('syncSheet')?.hidden;
    // Touches that start on a chart are for scrubbing, not pull-to-refresh.
    const onChart = e.target instanceof Element && e.target.closest('svg.chart');
    startY = window.scrollY <= 0 && !sheetOpen && !syncing && !onChart ? e.touches[0].clientY : null;
    pull = 0;
    armed = false;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (startY === null) return;
    pull = Math.min(120, Math.max(0, e.touches[0].clientY - startY) * 0.5);
    ind.classList.add('dragging');
    ind.style.opacity = String(Math.min(1, pull / 40));
    ind.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 3}deg)`;
    const ready = pull >= THRESHOLD;
    if (ready !== armed) { armed = ready; ind.classList.toggle('ready', ready); if (ready) tick(10); }
  }, { passive: true });
  addEventListener('touchend', () => {
    if (startY === null) return;
    startY = null;
    if (!armed) { reset(); return; }
    ind.classList.remove('dragging', 'ready');
    ind.classList.add('spinning');
    ind.style.transform = '';
    ind.style.opacity = '';
    runSync().finally(() => { ind.classList.remove('spinning'); reset(); });
  });
}

// A light tick when switching tabs, days and ranges (Android; iPhones don't allow it).
document.addEventListener('click', e => {
  if (e.target.closest('.tab, .wday, .segmented a, .ring-row, a.card')) tick(6);
});

// ---------- Heart page detail ----------
// One local day of raw readings, read from storage only when the page asks.
async function dayHeartRate(date) {
  const prof = dashboardProfile(await profile());
  const hrDays = {};
  for (const k of [-1, 0, 1]) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + k);
    const day = d.toISOString().slice(0, 10);
    const v = await store.get(`hr:${day}`);
    if (v) hrDays[day] = v;
  }
  const raw = localDayReadings(hrDays, prof.timezone, date);
  if (raw.t.length > 100) return { date, resolution: 'second', ...raw };
  // Older days on the phone: per-minute averages from the bundled history.
  const seed = await loadSeed();
  const minutes = seed?.src?.intraday_hr?.[date];
  if (minutes && minutes.length) {
    return {
      date, resolution: 'minute',
      t: minutes.map(p => { const [h, m] = p.time.split(':').map(Number); return h * 3600 + m * 60; }),
      b: minutes.map(p => p.bpm),
    };
  }
  return null;
}

// ---------- Host ----------
// ---------- Logging workouts (Log +) ----------
// Writing needs one more Google permission, asked for the first time someone
// saves. On the web that's a trip to Google, so the workout waits in storage
// and is saved when the page comes back.
async function writeToken() {
  if (NATIVE) return (await Auth.authorize({ interactive: true, write: true })).accessToken;
  return (await webauth.canWrite()) ? webauth.getToken() : null;
}

async function runWrite(job) {
  const token = await writeToken();
  if (!token) {
    await store.set('pendingWrite', job);
    await webauth.signInToWrite(); // leaves the page
    return new Promise(() => {});
  }
  const tok = async ({ refresh = false } = {}) => (refresh ? writeToken() : token);
  if (job.kind === 'log') {
    const e = job.entry;
    await logWorkoutApi(tok, { ...e, start: new Date(e.start) });
  } else {
    await deleteWorkoutApi(tok, job.id);
  }
  await recomputeAndShow();
}

async function resumePendingWrite() {
  const job = await store.get('pendingWrite');
  if (!job) return;
  await store.del('pendingWrite');
  if (!(await webauth.canWrite())) {
    window.DataStrap.toast('Google didn’t allow adding workouts, so nothing was saved.');
    return;
  }
  try {
    await runWrite(job);
    window.DataStrap.toast(job.kind === 'log' ? `${job.entry.label} logged. It’ll show in the Fitbit app too.` : 'Workout deleted.');
  } catch (err) {
    window.DataStrap.toast(`Couldn’t save: ${err.message || err}`);
  }
}

// Error reports from a page that failed to draw: the error text only.
async function sendReport(text) {
  const cfg = (await appConfig()).feedback;
  if (!cfg) return false;
  const body = new URLSearchParams({
    [cfg.fields.message]: `[Crash] ${text}`.slice(0, 1800),
    [cfg.fields.contact]: '',
    [cfg.fields.context]: feedbackContext(),
  });
  try {
    await fetch(cfg.formUrl, { method: 'POST', mode: 'no-cors', body });
    return true;
  } catch {
    return false;
  }
}

window.DataStrapHost = {
  dayHeartRate,
  sendReport,
  logWorkout: entry => runWrite({ kind: 'log', entry }),
  deleteWorkout: id => runWrite({ kind: 'delete', id }),
  async load() {
    mountUi();
    pullToRefresh();
    let notice = '';
    if (!NATIVE) {
      const result = await webauth.completeRedirect();
      if (result === 'signed-in') await store.set('signedIn', true);
      if (result === 'needs-consent' || result === 'error') {
        // A silent refresh that needs the person: show sign-in instead of looping.
        const error = await store.get('webAuthError');
        if (result === 'needs-consent' || error) await store.set('signedIn', false);
        if (error && error !== 'access_denied') notice = `Google sign-in failed (${error}).`;
        if (error === 'access_denied') notice = 'Sign-in was cancelled.';
        if (!error && result === 'needs-consent') notice = 'Google sign-in has expired. Sign in again to keep syncing.';
      }
      navigator.storage?.persist?.().catch(() => {});
    }
    let data = (await store.get('dashboardVersion')) === ENGINE_VERSION ? await store.get('dashboard') : null;
    if (!data) data = await compute().catch(err => { console.error(err); return null; });
    const signedIn = await store.get('signedIn');
    setUi(signedIn ? 'idle' : 'signedOut', '', notice);
    if (signedIn) setTimeout(runSync, 300);
    if (!data) {
      if (signedIn) showFirstSync();
      else showConnect(notice);
      return null;
    }
    if (signedIn) setTimeout(askSexOnce, 800);
    if (signedIn && !NATIVE) setTimeout(resumePendingWrite, 600);
    return data;
  },
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runSync();
});
setInterval(() => {
  if (document.visibilityState === 'visible') runSync({ background: true });
}, AUTO_SYNC_MS);

// Android back button: close the sheet, then go back through the dashboard's pages.
cap?.Plugins?.App?.addListener?.('backButton', ({ canGoBack }) => {
  const sheet = document.getElementById('syncSheet');
  if (sheet && !sheet.hidden) closeSheet();
  else if (canGoBack) history.back();
  else cap.Plugins.App.exitApp();
});

// Web: offline support and quick start from the home screen.
if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
