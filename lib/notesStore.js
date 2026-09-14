import { redis, k } from './redis';
import { parseStoredNotes } from './notes';

// Redis side of per-video notes, split from lib/notes.js so the pure helpers
// stay importable from client-rendered code.
//
//   k('notes')  videoGuid -> string
//
// Reads fail back to "no notes": notes are descriptive text over a video that
// plays fine without them, so an unreadable value degrades to today's page
// rather than breaking it.
export async function loadAllNotes() {
  try {
    const raw = (await redis().hgetall(k('notes'))) || {};
    const out = {};
    for (const [guid, value] of Object.entries(raw)) {
      const notes = parseStoredNotes(value);
      if (notes) out[guid] = notes;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getVideoNotes(guid) {
  try {
    return parseStoredNotes(await redis().hget(k('notes'), guid));
  } catch {
    return null;
  }
}

// Empty DELETES the entry, so "cleared" and "never set" are one state.
export async function setVideoNotes(guid, notes) {
  if (!notes) {
    await redis().hdel(k('notes'), guid);
    return { ok: true, notes: null };
  }
  await redis().hset(k('notes'), { [guid]: notes });
  return { ok: true, notes };
}

export async function clearVideoNotes(guid) {
  try {
    await redis().hdel(k('notes'), guid);
  } catch {
    // best-effort, same no-orphans contract as chapters and publish windows
  }
}
