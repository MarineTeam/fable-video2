import { redis, k } from './redis';
import { normalizeList } from './mylist';

// Redis side of the per-viewer saved queue, kept apart from lib/mylist.js so
// the pure list logic stays importable from client-rendered code (see the note
// there).
//
//   k(`mylist:${email}`)  videoGuid -> epoch ms when it was saved
//
// Keyed by email exactly like k(`progress:${email}`), and deliberately a
// SEPARATE key rather than a field inside it: progress is derived from
// playback and written on a timer, this is written only by an explicit click,
// and merging them would make a saved list vulnerable to a progress write
// racing it.
//
// Reads fail back to an empty list. A saved row is a convenience over a
// library that works without it, so an unreadable value must degrade to
// today's behaviour rather than break the homepage — same posture as
// lib/chaptersStore.js.

const listKey = (email) => k(`mylist:${String(email || '').trim()}`);

export async function getMyList(email) {
  if (!String(email || '').trim()) return {};
  try {
    return (await redis().hgetall(listKey(email))) || {};
  } catch {
    return {};
  }
}

// Normalised entries, newest first — what a caller usually wants.
export async function getMyListEntries(email) {
  return normalizeList(await getMyList(email));
}

export async function saveToMyList(email, guid) {
  const id = String(guid || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis().hset(listKey(email), { [id]: Date.now() });
    return { ok: true, saved: true };
  } catch {
    // Unlike a read, a write failure is worth reporting: the viewer clicked
    // and is owed an answer.
    return { ok: false, error: 'Could not save to your list' };
  }
}

export async function removeFromMyList(email, guid) {
  const id = String(guid || '').trim();
  if (!id || !String(email || '').trim()) return { ok: false, error: 'Bad request' };
  try {
    await redis().hdel(listKey(email), id);
    return { ok: true, saved: false };
  } catch {
    return { ok: false, error: 'Could not change your list' };
  }
}
