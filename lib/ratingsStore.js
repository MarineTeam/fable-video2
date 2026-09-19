import { redis, k } from './redis';
import { normalizeRatings } from './ratings';

// Redis side of ratings, kept apart from lib/ratings.js so the pure vote logic
// stays importable from client-rendered code (see the note there).
//
//   k(`ratings:${email}`)  videoGuid -> 'up' | 'down'
//   k('rating_counts')     `${guid}:up` / `${guid}:down` -> integer
//
// Keyed by email exactly like k(`progress:${email}`) and k(`mylist:${email}`),
// and for the reason spelled out in lib/ratings.js: removing a viewer has to
// remove what was recorded about them, and there is no sweep over video keys.
//
// Reads fail back to 'not rated' / 'no counts'. A vote is decoration over a
// video that plays fine without it, so an unreadable value must degrade to
// today's behaviour rather than break the watch page — same posture as
// lib/chaptersStore.js and lib/mylistStore.js.

const ratingsKey = (email) => k(`ratings:${String(email || '').trim()}`);
const COUNTS = 'rating_counts';

export async function getRatings(email) {
  if (!String(email || '').trim()) return {};
  try {
    return normalizeRatings(await redis().hgetall(ratingsKey(email)));
  } catch {
    return {};
  }
}

export async function setRating(email, guid, vote) {
  const id = String(guid || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis().hset(ratingsKey(email), { [id]: vote });
    return { ok: true, vote };
  } catch {
    // Unlike a read, a write failure is worth reporting: the viewer clicked
    // and is owed an answer.
    return { ok: false, error: 'Could not save your rating' };
  }
}

export async function clearRating(email, guid) {
  const id = String(guid || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis().hdel(ratingsKey(email), id);
    return { ok: true, vote: null };
  } catch {
    return { ok: false, error: 'Could not change your rating' };
  }
}

export async function getRatingCounts() {
  try {
    return (await redis().hgetall(k(COUNTS))) || {};
  } catch {
    return {};
  }
}

// Applies the deltas from voteDelta(). BEST-EFFORT AND LAST: the viewer's own
// vote is the authoritative write and has already succeeded by the time this
// runs, so a counter failure costs an admin an accurate total and costs the
// viewer nothing. A counter can therefore drift by one against the votes;
// lib/ratings.js clamps a negative back to zero, and the drift is recorded in
// FEATURES.md rather than pretended away.
export async function applyRatingCounts(deltas) {
  for (const [field, delta] of Object.entries(deltas || {})) {
    if (!field || !delta) continue;
    try {
      await redis().hincrby(k(COUNTS), field, delta);
    } catch {
      // best-effort
    }
  }
}

// Called when a video is deleted, so the counters never hold totals for a
// video that no longer exists and a recycled bunny.net guid cannot inherit
// another video's score. The per-viewer votes are left alone: they are keyed
// by a guid that no longer resolves, so they read as nothing, and rewriting
// every viewer's hash on a delete would be a scan this repo does not do.
export async function clearVideoRatingCounts(guid) {
  try {
    await redis().hdel(k(COUNTS), `${guid}:up`, `${guid}:down`);
  } catch {
    // best-effort
  }
}
