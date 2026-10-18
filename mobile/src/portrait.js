// Today portrait (phone side). The person picks a photo of themselves; it's
// shrunk here, sent once through DataStrap's helper (token-server/src/portrait.js)
// to Google Gemini, and the side-profile portrait that comes back is kept on
// this device only, next to the health data. Nothing is kept by the helper.
import * as store from './store.js';

const MAX_SIDE = 1024;

// The stored portrait, if any: {data (base64), mime, pins, aspect, createdAt}.
export async function loadPortrait() {
  const p = await store.get('portrait');
  return p && p.data ? p : null;
}

export const savePortrait = p => store.set('portrait', p);
export const removePortrait = () => store.del('portrait');

// What app.js needs to draw the hero. Portraits are stored already cut out
// and toned (cutOut below), so they're drawn like the hand-made one.
export function toDashboard(p) {
  return { src: `data:${p.mime};base64,${p.data}`, spots: p.pins, aspect: p.aspect, generated: !p.cutout };
}

// The portrait comes on a seamless white backdrop. Cut the person out of it,
// on the phone: the backdrop is whatever touches the image's edges and is
// close to the backdrop's colour, with a soft edge; the backdrop mixed into
// edge pixels is taken back out (so there's no white fringe). Then the same
// toning as the hand-made portrait (mostly monochrome, slightly dimmed, a
// touch more contrast), and a crop to the person. Pins move with the crop.
export async function cutOut(dataUrl, pins) {
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth, H = img.naturalHeight, N = W * H;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const frame = ctx.getImageData(0, 0, W, H);
  const px = frame.data;

  // Backdrop colour: the median of the top rows and the right-hand columns.
  const samples = [[], [], []];
  for (let y = 0; y < 16; y++) for (let x = 0; x < W; x += 4) for (let c = 0; c < 3; c++) samples[c].push(px[(y * W + x) * 4 + c]);
  for (let y = 0; y < H; y += 4) for (let x = W - 16; x < W; x++) for (let c = 0; c < 3; c++) samples[c].push(px[(y * W + x) * 4 + c]);
  const bg = samples.map(v => v.sort((a, b) => a - b)[v.length >> 1]);

  // How much each pixel looks like the backdrop (1) or the person (0).
  const bgness = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
    bgness[i] = Math.min(1, Math.max(0, 1 - (d - 18) / 72));
  }
  // Only backdrop-like pixels connected to the image's edges count (so bright
  // skin inside the body stays), grown by 3 px to reach into the soft edge.
  let reach = new Uint8Array(N);
  const stack = [];
  const seed = i => { if (!reach[i] && bgness[i] > 0.5) { reach[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % W;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (i >= W) seed(i - W);
    if (i < N - W) seed(i + W);
  }
  for (let pass = 0; pass < 3; pass++) {
    const grown = reach.slice();
    for (let i = 0; i < N; i++) {
      if (reach[i]) continue;
      const x = i % W;
      if ((x > 0 && reach[i - 1]) || (x < W - 1 && reach[i + 1]) || (i >= W && reach[i - W]) || (i < N - W && reach[i + W])) grown[i] = 1;
    }
    reach = grown;
  }
  // Alpha, tightened slightly, then softened with a 3×3 blur.
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) raw[i] = reach[i] ? Math.min(1, Math.max(0, (1 - bgness[i] - 0.15) / 0.85)) : 1;
  const alpha = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) { sum += raw[yy * W + xx]; n++; }
    }
    alpha[y * W + x] = sum / n;
  }

  // Take the backdrop back out of edge pixels, then tone. Contrast pivots on
  // the person's average brightness, as the hand-made portrait's did.
  let lumSum = 0, lumN = 0;
  for (let i = 0; i < N; i++) if (alpha[i] > 0.5) { lumSum += 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; lumN++; }
  const mean = (lumN ? lumSum / lumN : 128) * 0.9;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) {
    const a = alpha[i], o = i * 4;
    const k = Math.max(a, 0.05);
    const f = [0, 1, 2].map(c => Math.min(255, Math.max(0, (px[o + c] - (1 - k) * bg[c]) / k)));
    const l = 0.299 * f[0] + 0.587 * f[1] + 0.114 * f[2];
    for (let c = 0; c < 3; c++) {
      const v = (l + (f[c] - l) * 0.28) * 0.9;           // colour 0.28, brightness 0.9
      px[o + c] = Math.min(255, Math.max(0, mean + (v - mean) * 1.08)); // contrast 1.08
    }
    px[o + 3] = Math.round(a * 255);
    if (a > 0.03) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  ctx.putImageData(frame, 0, 0);
  if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(canvas, x0, y0, cw, ch, 0, 0, cw, ch);
  // WebP where the browser can write it (Chrome, Android), PNG otherwise.
  let url = out.toDataURL('image/webp', 0.9);
  if (!url.startsWith('data:image/webp')) url = out.toDataURL('image/png');
  const moved = {};
  for (const [k, p] of Object.entries(pins || {})) {
    moved[k] = { x: ((p.x / 100) * W - x0) / cw * 100, y: ((p.y / 100) * H - y0) / ch * 100 };
  }
  fitPins(moved, (x, y) => alpha[(y0 + y) * W + x0 + x] > 0.5, cw, ch);
  for (const p of Object.values(moved)) { p.x = Math.round(p.x * 10) / 10; p.y = Math.round(p.y * 10) / 10; }
  const [head, data] = url.split(',');
  return { data, mime: head.slice(5, head.indexOf(';')), pins: moved, aspect: cw / ch, cutout: true };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file isn’t a photo this phone can open. Try a JPEG or PNG.'));
    img.src = src;
  });
}

// The photo as a JPEG at most 1024 px on its longest side, as base64. Drawing
// it onto a canvas also drops its metadata (location, camera, time).
export async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86).split(',')[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MESSAGES = {
  weekly_limit: (n, resets) => `You’ve used this week’s ${n} tries. You can make a new portrait from ${new Date(`${resets}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}.`,
  one_person: 'Use a photo with just you in it.',
  face: 'Your face needs to be clearly visible and facing the camera.',
  unclear: 'That photo didn’t work. Try a clearer one of just you, facing the camera.',
  portrait_blocked: 'Google wouldn’t make a portrait from that photo. Try a different one.',
  not_configured: 'Portraits aren’t switched on for this app yet.',
  sign_in: 'Sign in with Google again (↻), then try once more.',
  busy: 'Google is busy right now. Try again in a minute.',
};

// The model's pins are a good start but vary between runs, so check them
// against the cut-out silhouette (a profile facing right; `inside(x, y)` in
// pixels of the crop). The throat goes just below the chin: the row where the
// front outline jumps back most (the underside of the jaw). The shoulder stays
// near the top of the shoulder, and shoulder and chest are kept inside the body.
function fitPins(pins, inside, cw, ch) {
  const front = y => { for (let x = cw - 1; x >= 0; x--) if (inside(x, y)) return x; return -1; };
  const back = y => { for (let x = 0; x < cw; x++) if (inside(x, y)) return x; return -1; };
  const row = pct => Math.min(ch - 1, Math.max(0, Math.round(pct / 100 * ch)));
  // The underside of the jaw: the biggest step back in the front outline over a
  // few rows, between the middle of the face and the chest.
  const from = row(Math.max(30, (pins.brain?.y ?? 20) + 15)), to = row(Math.min(85, (pins.chest?.y ?? 85) - 8));
  const step = Math.max(2, Math.round(ch * 0.02));
  let jawY = -1, drop = 0;
  for (let y = from; y + step <= to; y++) {
    const a = front(y), b = front(y + step);
    if (a >= 0 && b >= 0 && a - b > drop) { drop = a - b; jawY = y + step; }
  }
  if (jawY >= 0 && drop > 0.04 * cw) {
    const y = Math.min(ch - 1, jawY + Math.round(0.05 * ch));
    pins.throat = { x: (front(y) - 0.06 * cw) / cw * 100, y: y / ch * 100 };
  }
  const pullIn = (p, minY, depth) => {
    if (!p) return;
    const y = row(Math.max(minY, Math.min(94, p.y)));
    const b = back(y), f = front(y);
    if (b < 0) return;
    const x = Math.min(Math.max(p.x / 100 * cw, b + depth * cw), f - 0.04 * cw);
    p.x = x / cw * 100; p.y = y / ch * 100;
  };
  const throatY = pins.throat ? pins.throat.y : 55;
  if (pins.shoulder) pins.shoulder.y = Math.min(pins.shoulder.y, throatY + 20);
  pullIn(pins.shoulder, throatY + 8, 0.15);
  pullIn(pins.chest, throatY + 15, 0.3);
}

// Sends the photo and returns {portrait} or {error: message}. `sex` picks the
// framing (men bare-chested; everyone else cropped at the collarbones).
export async function requestPortrait(server, getToken, image, sex = null) {
  const send = token => fetch(`${server}/portrait`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image, sex: sex === 'male' || sex === 'female' ? sex : null }),
  });
  let res;
  try {
    let token = await getToken();
    res = await send(token);
    if (res.status === 401) {
      // An expired Google pass: renew it once and resend.
      token = await getToken({ refresh: true, stale: token });
      res = await send(token);
    }
  } catch {
    return { error: 'Couldn’t reach the portrait service. Check your connection and try again.' };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.image) {
    const cut = await cutOut(`data:${body.mime};base64,${body.image}`, body.pins);
    return { portrait: { ...cut, createdAt: Date.now() }, remaining: body.remaining };
  }
  const m = MESSAGES[body.reason] || MESSAGES[body.error];
  return {
    error: typeof m === 'function' ? m(body.limit, body.resets) : m || 'Couldn’t make the portrait right now. Try again in a minute.',
    remaining: body.remaining,
  };
}
