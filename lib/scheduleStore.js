import { redis, k } from './redis';

// Redis side of publish windows, kept apart from lib/schedule.js so the pure
// window logic stays importable from client-rendered code (see the note there).
//
//   k('schedule')  videoGuid -> { from, until }
//
// Reads fail OPEN — a video is shown when its window cannot be read. That is
// deliberate and is argued in lib/schedule.js: scheduling is a publishing
// convenience, not an access boundary, and blanking the library on a Redis blip
// is the availability failure the architecture contract rules out.

function parseEntry(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const from = typeof raw.from === 'string' ? raw.from : null;
  const until = typeof raw.until === 'string' ? raw.until : null;
  if (!from && !until) return null;
  return { from, until };
}

// guid -> window, for every video that has one. Fails open (see above).
export async function loadSchedule() {
  try {
    const raw = (await redis().hgetall(k('schedule'))) || {};
    const out = {};
    for (const [guid, value] of Object.entries(raw)) {
      const entry = parseEntry(value);
      if (entry) out[guid] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

export async function getVideoWindow(guid) {
  try {
    return parseEntry(await redis().hget(k('schedule'), guid));
  } catch {
    return null;
  }
}

export async function setVideoWindow(guid, window) {
  if (window === null) {
    await redis().hdel(k('schedule'), guid);
    return { ok: true, window: null };
  }
  await redis().hset(k('schedule'), { [guid]: window });
  return { ok: true, window };
}

// Called when a video is deleted, so the hash never accumulates entries for
// videos that no longer exist — same cleanup contract as the order list.
export async function clearVideoWindow(guid) {
  try {
    await redis().hdel(k('schedule'), guid);
  } catch {
    // best-effort
  }
}
