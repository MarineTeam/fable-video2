import { redis, k } from './redis';
import { isValidVideoGuid, toPublicGuidSet } from './publicVideos';

// Redis side of the public-video set.
//
//   k('public-videos')  SET of video guids
//
// Reads FAIL CLOSED. Everywhere else in this app a read failure degrades to
// "show it" because the thing being read is decoration over content already
// behind the viewer gate. This one IS the gate — it is the only thing standing
// between an anonymous visitor and a video — so an unreadable answer means
// "not public", never "public".
export async function isVideoPublic(guid) {
  if (!isValidVideoGuid(guid)) return false;
  try {
    return (await redis().sismember(k('public-videos'), guid)) === 1;
  } catch {
    return false;
  }
}

// For the admin Videos tab, which needs to render the toggle state per row.
// Fails closed to "none public" for the same reason.
export async function loadPublicVideoGuids() {
  try {
    return toPublicGuidSet(await redis().smembers(k('public-videos')));
  } catch {
    return new Set();
  }
}

export async function setVideoPublic(guid, isPublic) {
  if (!isValidVideoGuid(guid)) return { ok: false, error: 'Bad video id' };
  const r = redis();
  if (isPublic) await r.sadd(k('public-videos'), guid);
  else await r.srem(k('public-videos'), guid);
  return { ok: true, isPublic: Boolean(isPublic) };
}

// Deleting a video must also close its public door, or the guid lingers in the
// set and a future video reusing it would inherit the flag.
export async function clearVideoPublic(guid) {
  try {
    await redis().srem(k('public-videos'), guid);
  } catch {
    // best-effort, same no-orphans contract as chapters, notes and windows
  }
}
