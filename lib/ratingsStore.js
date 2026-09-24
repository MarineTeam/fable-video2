import { redis, k } from './redis';
import { normalizeRatings } from './ratings';
import { RECOUNT_SCRIPT, VOTE_SCRIPT } from './ratingScripts';

// Redis side of ratings, kept apart from lib/ratings.js so the pure vote logic
// stays importable from client-rendered code (see the note there).
//
//   k(`ratings:${email}`)  videoGuid -> 'up' | 'down'
//   k('rating_counts')     `${guid}:up` / `${guid}:down` -> integer
//
// Keyed by email exactly like k(`progress:${email}`) and k(`mylist:${email}`),
// for the reason spelled out in lib/ratings.js: a person's data in one place
// per feature, never a field under each video. (Nothing deletes it when a
// viewer is removed yet — pages/api/admin/viewers.js clears only the viewer
// entry and last-seen time. That is a known gap in FEATURES.md.)
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

// Sets ('up' / 'down') or clears (null) one viewer's vote AND moves the
// counters, as one Redis script — see lib/ratingScripts.js. There is no
// separate counter write left to fail, so the totals cannot drift from the
// votes the way the old best-effort HINCRBY could, and the previous vote is
// read inside the script, so two racing clicks cannot both count.
//
// Reports failure rather than throwing, like every write here: the viewer
// clicked and is owed an answer. A failure almost always means nothing was
// written; the exception is a reply lost after Redis ran the script, where
// the vote stands and the viewer's next click lands on the stored state.
export async function recordRating(email, guid, vote) {
  const id = String(guid || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    const changed = await redis().eval(VOTE_SCRIPT, [ratingsKey(email), k(COUNTS)], [id, vote || '']);
    return { ok: true, vote: vote || null, changed: Number(changed) === 1 };
  } catch {
    return { ok: false, error: vote ? 'Could not save your rating' : 'Could not change your rating' };
  }
}

export async function getRatingCounts() {
  try {
    return (await redis().hgetall(k(COUNTS))) || {};
  } catch {
    return {};
  }
}

// Every viewer's ratings hash, by SCAN. Used only by the admin recount — an
// occasional maintenance action, not a request path.
export async function scanRatingKeys() {
  const r = redis();
  const pattern = `${ratingsKey('')}*`;
  let cursor = '0';
  const keys = [];
  do {
    const [next, batch] = await r.scan(cursor, { match: pattern, count: 200 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

// Rebuilds the counters from the votes and replaces them, in one script.
// Corrects drift left by the old two-write path. THROWS on failure, unlike
// the viewer-facing calls above: its only caller is an admin route that has
// to say the recount did not happen.
export async function recountRatings() {
  const keys = await scanRatingKeys();
  const [votes, fields] = await redis().eval(RECOUNT_SCRIPT, [k(COUNTS), ...keys], []);
  return { viewers: keys.length, votes: Number(votes) || 0, fields: Number(fields) || 0 };
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
