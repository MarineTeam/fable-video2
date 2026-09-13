import { redis, k } from './redis';
import { parseStoredChapters } from './chapters';

// Redis side of chapters, kept apart from lib/chapters.js so the pure parsing
// and formatting stay importable from client-rendered code (see the note
// there).
//
//   k('chapters')  videoGuid -> [{ at, label }, ...]
//
// Reads fail back to "no chapters". A chapter list is navigation sugar over a
// video that plays fine without it, so an unreadable value must degrade to
// today's behaviour rather than break the watch page.
export async function loadAllChapters() {
  try {
    const raw = (await redis().hgetall(k('chapters'))) || {};
    const out = {};
    for (const [guid, value] of Object.entries(raw)) {
      const chapters = parseStoredChapters(value);
      if (chapters.length) out[guid] = chapters;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getVideoChapters(guid) {
  try {
    return parseStoredChapters(await redis().hget(k('chapters'), guid));
  } catch {
    return [];
  }
}

// An empty list DELETES the entry rather than storing [], so "cleared" and
// "never set" are the same state — same contract as the site name.
export async function setVideoChapters(guid, chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    await redis().hdel(k('chapters'), guid);
    return { ok: true, chapters: [] };
  }
  await redis().hset(k('chapters'), { [guid]: chapters });
  return { ok: true, chapters };
}

// Called when a video is deleted, so the hash never accumulates entries for
// videos that no longer exist — same no-orphans contract as publish windows.
export async function clearVideoChapters(guid) {
  try {
    await redis().hdel(k('chapters'), guid);
  } catch {
    // best-effort
  }
}
