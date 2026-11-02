// Request validation. Each function returns { value } or { error }.

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function validateRecipe(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'The body must be a JSON object.' };
  const { title, ingredients = [], steps = [], tags = [], minutes = null } = body;
  if (typeof title !== 'string' || !title.trim()) return { error: 'A title is required.' };
  for (const [name, v] of [
    ['ingredients', ingredients],
    ['steps', steps],
    ['tags', tags],
  ])
    if (!isStringArray(v)) return { error: `${name} must be an array of strings.` };
  if (minutes !== null && !(Number.isInteger(minutes) && minutes > 0))
    return { error: 'minutes must be a positive whole number.' };
  return { value: { title: title.trim(), ingredients, steps, tags, minutes } };
}

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;

/** { value: { type, bytes } }, or { error, status } with status 400 or 413. */
export function validatePhoto(body) {
  const url = body && typeof body === 'object' ? body.dataUrl : undefined;
  if (typeof url !== 'string') return { status: 400, error: 'dataUrl is required.' };
  const m = DATA_URL.exec(url.trim());
  if (!m) return { status: 400, error: 'The photo must be a base64 PNG or JPEG data URL.' };
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) return { status: 400, error: 'The photo is empty.' };
  if (bytes.length > MAX_PHOTO_BYTES)
    return { status: 413, error: 'The photo is larger than 2 MB.' };
  return { value: { type: m[1], bytes } };
}
