// Per-video publish windows: a video can be hidden until a date, after a date,
// or both.
//
//   k('schedule')  videoGuid -> { from, until }   (either may be null)
//
// HONEST SCOPE — read this before relying on it. Scheduling here is a
// PUBLISHING CONVENIENCE, not an embargo or an access-control boundary:
//
//   * it fails OPEN. If the schedule can't be read, videos are shown. The
//     alternative — blanking the whole library on a Redis blip — is the
//     availability failure the architecture contract explicitly rules out for
//     the viewing path, and the video is still behind the viewer gate either
//     way. Group scopes (lib/groups.js) fail CLOSED because they ARE an access
//     decision; this is not one.
//   * an unparseable bound is ignored rather than treated as "hide", so a
//     mistyped date never silently buries content.
//
// If something genuinely must not be seen before a date, don't upload it yet,
// or scope it to a group. Say that out loud rather than implying more than
// this feature delivers.
//
// This module is PURE and must import nothing — the admin Videos tab calls
// windowState() during render, so anything pulled in here lands in the browser
// bundle. Importing lib/redis reaches lib/monitor and then node:async_hooks,
// which fails the client build outright. Redis access lives in
// lib/scheduleStore.js, mirroring the capabilities.js / roles.js split.

export function parseBound(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Normalizes an admin-supplied window to what gets stored. Returns null when
// neither bound is usable, which is the caller's signal to delete the entry
// rather than store an empty record.
export function normalizeWindow({ from, until } = {}) {
  const fromMs = parseBound(from);
  const untilMs = parseBound(until);
  if (fromMs === null && untilMs === null) return null;
  // An inverted window (until before from) can never be live and is almost
  // certainly a typo, so it is rejected at the API rather than stored.
  if (fromMs !== null && untilMs !== null && untilMs <= fromMs) return { invalid: true };
  return {
    from: fromMs === null ? null : new Date(fromMs).toISOString(),
    until: untilMs === null ? null : new Date(untilMs).toISOString(),
  };
}

export function isWithinWindow(entry, now = Date.now()) {
  if (!entry) return true;
  const from = parseBound(entry.from);
  const until = parseBound(entry.until);
  if (from !== null && now < from) return false;
  if (until !== null && now >= until) return false;
  return true;
}

// For the admin UI badge — describes an entry without deciding anything.
export function windowState(entry, now = Date.now()) {
  if (!entry || (!parseBound(entry.from) && !parseBound(entry.until))) return 'always';
  const from = parseBound(entry.from);
  const until = parseBound(entry.until);
  if (from !== null && now < from) return 'scheduled';
  if (until !== null && now >= until) return 'expired';
  return 'live';
}

export function filterVideosBySchedule(videos, scheduleMap, now = Date.now()) {
  const map = scheduleMap || {};
  return (videos || []).filter((v) => isWithinWindow(map[v?.guid], now));
}
