import { redis, k } from './redis';
import { normalizeEmail } from './auth';

export const WATERMARK_MODES = ['default', 'always', 'never'];

export function clampWatermarkMode(mode) {
  return WATERMARK_MODES.includes(mode) ? mode : 'default';
}

// Pure decision, kept separate from Redis so it's unit-testable. Precedence,
// most specific wins, with one absolute override: an exempt viewer never
// sees a watermark no matter what else is set. Below that: the share link's
// own explicit choice beats the video's, which beats the global default.
export function resolveWatermark({ exempt, shareMode = 'default', videoMode = 'default', globalDefault = false }) {
  if (exempt) return false;
  if (shareMode === 'always') return true;
  if (shareMode === 'never') return false;
  if (videoMode === 'always') return true;
  if (videoMode === 'never') return false;
  return Boolean(globalDefault);
}

// A watermark is a deterrence/traceability accessory, not an access control —
// unlike requireAdmin/requireViewer, every read here fails open (no
// watermark) rather than blocking or altering playback on a Redis hiccup.

export async function getGlobalDefault() {
  try {
    return Boolean(await redis().get(k('settings:watermarkDefault')));
  } catch {
    return false;
  }
}

export async function setGlobalDefault(on) {
  await redis().set(k('settings:watermarkDefault'), Boolean(on));
  return Boolean(on);
}

export async function getVideoMode(videoId) {
  try {
    const mode = await redis().hget(k('watermark:video'), videoId);
    return clampWatermarkMode(mode);
  } catch {
    return 'default';
  }
}

// Batched lookup for admin listings — one hash read instead of one per video.
export async function getVideoModes(videoIds) {
  try {
    const all = (await redis().hgetall(k('watermark:video'))) || {};
    const out = {};
    for (const id of videoIds) out[id] = clampWatermarkMode(all[id]);
    return out;
  } catch {
    return Object.fromEntries((videoIds || []).map((id) => [id, 'default']));
  }
}

// Stored only when not 'default' — an unset video is simply absent from the
// hash, keeping it small and matching the additive-field idiom used for
// share.watermark (see lib/share.js).
export async function setVideoMode(videoId, mode) {
  const clamped = clampWatermarkMode(mode);
  const r = redis();
  if (clamped === 'default') {
    await r.hdel(k('watermark:video'), videoId);
  } else {
    await r.hset(k('watermark:video'), { [videoId]: clamped });
  }
  return clamped;
}

export async function isExempt(email) {
  try {
    return (await redis().sismember(k('watermark-exempt'), normalizeEmail(email))) === 1;
  } catch {
    return false;
  }
}

export async function listExempt() {
  try {
    return ((await redis().smembers(k('watermark-exempt'))) || []).sort();
  } catch {
    return [];
  }
}

export async function addExempt(email) {
  const norm = normalizeEmail(email);
  if (!norm) return false;
  await redis().sadd(k('watermark-exempt'), norm);
  return true;
}

export async function removeExempt(email) {
  await redis().srem(k('watermark-exempt'), normalizeEmail(email));
}
