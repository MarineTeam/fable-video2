import { redis, k } from './redis';
import { groupIdsForEmail } from './groups';
import { isWithinWindow, isWithinWindowFor, normalizeEntry } from './schedule';

// Redis side of publish windows, kept apart from lib/schedule.js so the pure
// window logic stays importable from client-rendered code (see the note there).
//
//   k('schedule')  videoGuid -> { from, until, repeat?, groups? }
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
  return normalizeEntry(raw);
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

// The viewer's group ids, for per-group windows. An unreadable membership
// reads as none: group windows only ever ADD time, so the default window then
// applies — the safe direction, and no library is blanked by it.
export async function viewerGroupIds(email) {
  try {
    return await groupIdsForEmail(email);
  } catch {
    return [];
  }
}

// One video, for one non-staff viewer: its default window, or a window of a
// group they are in. Membership is only read when the default window says no
// and the video has group windows at all, so the common case costs nothing
// extra.
export async function isVideoInWindowFor(guid, email) {
  const entry = await getVideoWindow(guid);
  if (isWithinWindow(entry)) return true;
  if (!entry?.groups) return false;
  return isWithinWindowFor(entry, await viewerGroupIds(email));
}

// Called when a group is deleted, so no window is left naming a group that no
// longer exists. Group ids are random-suffixed, so a new group of the same
// name would not inherit these anyway; this keeps the hash honest. Unlike the
// viewer reads it does NOT fail open — a failure here is the caller's to
// report.
export async function pruneGroupFromSchedules(groupId) {
  const raw = (await redis().hgetall(k('schedule'))) || {};
  let touched = 0;
  for (const [guid, value] of Object.entries(raw)) {
    const entry = parseEntry(value);
    if (!entry?.groups || !Object.prototype.hasOwnProperty.call(entry.groups, groupId)) continue;
    const groups = { ...entry.groups };
    delete groups[groupId];
    const next = normalizeEntry({ ...entry, groups });
    if (next) await redis().hset(k('schedule'), { [guid]: next });
    else await redis().hdel(k('schedule'), guid);
    touched += 1;
  }
  return touched;
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
