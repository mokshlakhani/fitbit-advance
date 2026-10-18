// Portrait for the Today hero: turns a person's front-facing photo into a
// side-profile studio portrait with Google's Gemini API, and finds where the
// hero's pins go on it.
//
//   POST /portrait  {image: <base64 JPEG>}   Authorization: Bearer <Google token>
//     -> {image: <base64>, mime, pins: {brain, throat, chest, shoulder}}
//
// Steps, all in one request:
//   1. The caller's Google token must open their Google Health profile. That
//      proves they're a signed-in DataStrap user and gives a stable ID for the
//      daily limit (only a salted hash of it is kept, for two days, as a count).
//   2. A quick check (a cheap vision model) that the photo shows exactly one
//      person with their face clearly visible. Rejected photos don't use a try.
//   3. The portrait itself (an image model), from the fixed prompt below.
//   4. The four pin positions on the portrait (the cheap vision model again).
// The photo and the portrait are never stored or logged here.

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const HEALTH_PROFILE = 'https://health.googleapis.com/v4/users/me/profile';
const MAX_IMAGE_CHARS = 3_000_000; // base64 of the phone's ≤1024 px JPEG, with room to spare

// Everything about the look is fixed here, so every person gets the same
// portrait style and the endpoint can't be used for anything else.
export const PORTRAIT_PROMPT = [
  'Using the person in the attached photo, create a photorealistic studio portrait of that exact same person.',
  'Keep their identity exactly: the same face, facial features, face shape, skin tone, hair colour, hair texture and hairstyle, and any facial hair or glasses. Do not beautify, age or change them.',
  'Pose: a strict side profile facing the right-hand side of the frame, head level with the chin very slightly raised, eyes gently closed, a calm and neutral expression, mouth closed.',
  'Framing: head, neck, shoulders and upper chest, cropped at mid-chest. A little space above the head. Place the person slightly left of centre so there is clear empty space in front of the face on the right.',
  'Clothing: a plain, close-fitting light heather-grey crew-neck T-shirt with no logos, text or pattern.',
  'Lighting: soft, diffused studio light from the front, gentle shading that shows the shape of the face, neck and shoulders, fine natural skin texture, a subtle rim light on the hair and shoulders.',
  'Background: a seamless, perfectly flat, pure black backdrop (#000000). Nothing else in the frame.',
  'Style: high-end editorial portrait photography, sharp focus, natural colours. One person only. No text, no watermark, no border.',
].join('\n');

const CHECK_PROMPT = 'Look at this photo. Does it show exactly one real person (not a drawing, statue or screen), with their face clearly visible and roughly facing the camera? Answer in JSON.';

const PINS_PROMPT = [
  'This is a side-profile portrait of one person facing right, wearing a T-shirt.',
  'Give the position of each of these points on the image, as x and y from 0 to 1000 (x from the left edge, y from the top edge).',
  'Every point must be on the person, inside their outline, never on the edge of the body or on the background:',
  'brain: the centre of the skull, directly above the ear and halfway between the ear and the top of the head;',
  'throat: the front of the neck, just below the chin and in front of the neck’s centre;',
  'chest: the front of the chest over the heart, below the collarbone and in front of the arm, roughly level with the armpit;',
  'shoulder: the rounded top of the upper arm (the deltoid), on the shoulder itself and a little below its outline.',
].join('\n');

const POINT = { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] };

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function gemini(env, model, parts, generationConfig) {
  const res = await fetch(`${GEMINI}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`gemini ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const partsOf = body => (body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [];
const textOf = body => partsOf(body).map(p => p.text || '').join('');
const blocked = body => Boolean((body.promptFeedback && body.promptFeedback.blockReason)
  || /SAFETY|PROHIBITED/.test((body.candidates && body.candidates[0] && body.candidates[0].finishReason) || ''));

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Pins as % of the image; anything missing or out of range falls back to
// where they sit on a typical portrait from this prompt.
const DEFAULT_PINS = { brain: { x: 45, y: 22 }, throat: { x: 62, y: 55 }, chest: { x: 64, y: 82 }, shoulder: { x: 34, y: 74 } };
function cleanPins(raw) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULT_PINS)) {
    const p = raw && raw[k];
    const ok = p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 1000;
    out[k] = ok ? { x: Math.round(p.x) / 10, y: Math.round(p.y) / 10 } : d;
  }
  // The chest is below and in front of the throat; the model sometimes picks
  // the upper arm instead. Then place it from the throat.
  const { throat, chest } = out;
  if (chest.y < throat.y + 12 || chest.x < throat.x - 12) out.chest = { x: Math.round((throat.x - 4) * 10) / 10, y: Math.min(92, Math.round((throat.y + 25) * 10) / 10) };
  return out;
}

/**
 * @param {Request} request  already checked for origin and method
 * @param {object} env       GEMINI_API_KEY, PORTRAIT_LIMITS (KV), PORTRAIT_SALT, models, limit
 * @param {(body, status) => Response} json
 */
export async function portrait(request, env, json) {
  if (!env.GEMINI_API_KEY || !env.PORTRAIT_LIMITS || !env.PORTRAIT_SALT) return json({ error: 'not_configured' }, 503);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'sign_in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const image = typeof body.image === 'string' ? body.image : '';
  if (!image || image.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: 'bad_image' }, 400);

  // 1. Who's asking: their Google Health profile's resource name.
  const prof = await fetch(HEALTH_PROFILE, { headers: { Authorization: `Bearer ${token}` } });
  if (prof.status === 401 || prof.status === 403) return json({ error: 'sign_in' }, 401);
  const who = (await prof.json().catch(() => ({}))).name;
  if (!prof.ok || !who) return json({ error: 'google_error' }, 502);

  const limit = Number(env.PORTRAIT_DAILY_LIMIT) || 3;
  const day = new Date().toISOString().slice(0, 10);
  const key = `p:${await sha256(`${env.PORTRAIT_SALT}:${who}:${day}`)}`;
  const used = Number(await env.PORTRAIT_LIMITS.get(key)) || 0;
  if (used >= limit) return json({ error: 'daily_limit', limit }, 429);

  const photo = { inlineData: { mimeType: 'image/jpeg', data: image } };
  const checkModel = env.GEMINI_CHECK_MODEL || 'gemini-3.5-flash-lite';
  try {
    // 2. Is it one person's face?
    const check = await gemini(env, checkModel, [photo, { text: CHECK_PROMPT }], {
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { one_person: { type: 'BOOLEAN' }, face_visible: { type: 'BOOLEAN' } }, required: ['one_person', 'face_visible'] },
    });
    const verdict = parseJson(textOf(check));
    if (blocked(check) || !verdict) return json({ error: 'photo_rejected', reason: 'unclear' }, 422);
    if (!verdict.one_person) return json({ error: 'photo_rejected', reason: 'one_person' }, 422);
    if (!verdict.face_visible) return json({ error: 'photo_rejected', reason: 'face' }, 422);

    // Counts as a try from here on, whatever happens next.
    await env.PORTRAIT_LIMITS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });

    // 3. The portrait.
    const made = await gemini(env, env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1', [photo, { text: PORTRAIT_PROMPT }], {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '3:4' },
    });
    const out = partsOf(made).find(p => p.inlineData && p.inlineData.data);
    if (!out) return json({ error: blocked(made) ? 'portrait_blocked' : 'no_portrait', remaining: limit - used - 1 }, 422);
    const mime = out.inlineData.mimeType || 'image/png';

    // 4. Where the pins go (best effort: defaults if this fails).
    let pins = DEFAULT_PINS;
    try {
      const located = await gemini(env, checkModel, [{ inlineData: { mimeType: mime, data: out.inlineData.data } }, { text: PINS_PROMPT }], {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { brain: POINT, throat: POINT, chest: POINT, shoulder: POINT }, required: ['brain', 'throat', 'chest', 'shoulder'] },
      });
      pins = cleanPins(parseJson(textOf(located)));
    } catch { /* keep the defaults */ }

    return json({ image: out.inlineData.data, mime, pins, remaining: limit - used - 1 }, 200);
  } catch (err) {
    return json({ error: err.status === 429 ? 'busy' : 'gemini_error' }, err.status === 429 ? 503 : 502);
  }
}
