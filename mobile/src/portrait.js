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

// What app.js needs to draw the hero.
export function toDashboard(p) {
  return { src: `data:${p.mime};base64,${p.data}`, spots: p.pins, aspect: p.aspect, generated: true };
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

// Sends the photo and returns {portrait} or {error: message}.
export async function requestPortrait(server, getToken, image) {
  const send = token => fetch(`${server}/portrait`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ image }),
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
    const img = await loadImage(`data:${body.mime};base64,${body.image}`);
    return {
      portrait: { data: body.image, mime: body.mime, pins: body.pins, aspect: img.naturalWidth / img.naturalHeight, createdAt: Date.now() },
      remaining: body.remaining,
    };
  }
  const m = MESSAGES[body.reason] || MESSAGES[body.error];
  return {
    error: typeof m === 'function' ? m(body.limit, body.resets) : m || 'Couldn’t make the portrait right now. Try again in a minute.',
    remaining: body.remaining,
  };
}
