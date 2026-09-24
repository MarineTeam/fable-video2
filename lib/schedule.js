// Per-video publish windows: a video can be hidden until a date, after a date,
// or both.
//
//   k('schedule')  videoGuid -> { from, until, repeat?, groups? }
//
// `from`/`until` are the DEFAULT window (either may be null). `repeat` narrows
// it to weekly slots; `groups` gives named groups extra windows of their own.
// Both are described at their sections below.
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

// --- Repeating windows ------------------------------------------------------
//
// A weekly slot on the DEFAULT window: { days: [0-6, Sunday = 0], start:
// 'HH:MM', end: 'HH:MM', timeZone: IANA name }. When present, the video is
// visible only inside a slot (as well as inside from/until). A slot whose end
// is not after its start runs past midnight into the next day — 'Saturday
// 22:00-02:00'. The zone is the one the rule was saved in, so summer time
// does not move the slot.
//
// It narrows the default window only, and it lives inside isWithinWindow(),
// which every enforcement point (and the public page) already calls — so
// there is no new call site to forget. Per-group windows are separate grants
// and are not bound by it.
//
// A malformed stored rule reads as NO rule, by the same reasoning as an
// unparseable bound above; validateRepeat() refuses one on the way in.

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function minutesOf(time) {
  const m = TIME.exec(String(time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function normalizeRepeat(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort();
  const start = minutesOf(raw.start);
  const end = minutesOf(raw.end);
  if (!days.length || start === null || end === null || start === end) return null;
  if (!isValidTimeZone(raw.timeZone)) return null;
  return { days, start: raw.start, end: raw.end, timeZone: raw.timeZone };
}

// The weekday (0-6) and minute of the day at `now`, in `timeZone`.
function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return { day: WEEKDAYS[get('weekday')], minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Whether `now` falls inside one of the rule's weekly slots. No usable rule
// means no constraint.
export function inRepeatSlot(repeat, now = Date.now()) {
  const rule = normalizeRepeat(repeat);
  if (!rule) return true;
  const { day, minute } = localClock(now, rule.timeZone);
  const start = minutesOf(rule.start);
  const end = minutesOf(rule.end);
  return rule.days.some((d) => {
    if (start < end) return day === d && minute >= start && minute < end;
    // Past midnight: the evening of day d, and the early hours of the next.
    return (day === d && minute >= start) || (day === (d + 1) % 7 && minute < end);
  });
}

// Refuses a rule that would not do what the admin meant. Returns an error
// string, or null (including for "no rule").
export function validateRepeat(repeat) {
  if (repeat === undefined || repeat === null) return null;
  if (typeof repeat !== 'object' || Array.isArray(repeat)) return 'The repeat rule is not valid';
  const days = Array.isArray(repeat.days) ? repeat.days : [];
  if (!days.length || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return 'Choose at least one day for the repeat';
  }
  const start = minutesOf(repeat.start);
  const end = minutesOf(repeat.end);
  if (start === null || end === null) return 'Repeat times must be HH:MM';
  if (start === end) return 'A repeat slot must not start and end at the same time';
  if (!isValidTimeZone(repeat.timeZone)) return 'The repeat time zone is not recognised';
  return null;
}

// --- Per-group windows ------------------------------------------------------
//
// `groups: { <groupId>: { from, until } }` — "members of this group can ALSO
// watch during this window". ADDITIVE ONLY, never a way to hold a video back
// from a group:
//
//   * every place that checks a window has to be handed the viewer's groups,
//     and one will eventually be missed. With additive windows a missed call
//     site only withholds an early preview (the default window applies) — the
//     safe direction. A window that could DELAY a video for a group would turn
//     the same slip into showing it early.
//   * holding a video back from a group is what group scopes are for, and
//     they are checked BEFORE the window, so a group window never reaches a
//     viewer the video's scope excludes.
//
// Group ids here are the random-suffixed ids from lib/groups.js, never names,
// so a new group of the same name cannot inherit an old one's windows; the
// group's windows are still pruned when it is deleted (lib/scheduleStore.js).
// The id shape is repeated here rather than imported because lib/groups.js
// reaches Redis, and this module must stay importable from the browser.

export const MAX_GROUP_WINDOWS = 20;
const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

function isGroupKey(id) {
  return typeof id === 'string' && GROUP_ID.test(id);
}

// Stored group windows, cleaned: unusable ids and empty/inverted windows are
// dropped. Returns null when none are left.
export function normalizeGroupWindows(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (count >= MAX_GROUP_WINDOWS) break;
    if (!isGroupKey(id)) continue;
    const window = normalizeWindow(value || {});
    if (!window || window.invalid) continue;
    out[id] = window;
    count += 1;
  }
  return count ? out : null;
}

// Admin input: { <groupId>: { from, until } }, checked against the groups that
// exist. Returns { groups } (null for none) or { error }. A window for an
// unknown group is refused rather than stored.
export function validateGroupWindows(raw, knownGroupIds) {
  if (raw === undefined || raw === null) return { groups: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Group windows must be an object' };
  const entries = Object.entries(raw);
  if (entries.length > MAX_GROUP_WINDOWS) return { error: `At most ${MAX_GROUP_WINDOWS} group windows` };
  const known = new Set(knownGroupIds || []);
  const out = {};
  for (const [id, value] of entries) {
    if (!isGroupKey(id) || !known.has(id)) {
      return { error: 'One of the groups no longer exists — reload and try again' };
    }
    const window = normalizeWindow(value || {});
    if (window?.invalid) return { error: 'A group window must end after it starts' };
    if (window) out[id] = window;
  }
  return { groups: Object.keys(out).length ? out : null };
}

// --- Whole entries ----------------------------------------------------------

// A stored entry, cleaned, or null for "no constraint of any kind". A default
// window with unparseable bounds keeps its repeat and group windows.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const from = typeof raw.from === 'string' && parseBound(raw.from) !== null ? raw.from : null;
  const until = typeof raw.until === 'string' && parseBound(raw.until) !== null ? raw.until : null;
  const repeat = normalizeRepeat(raw.repeat);
  const groups = normalizeGroupWindows(raw.groups);
  if (!from && !until && !repeat && !groups) return null;
  const entry = { from, until };
  if (repeat) entry.repeat = repeat;
  if (groups) entry.groups = groups;
  return entry;
}

export function isWithinWindow(entry, now = Date.now()) {
  if (!entry) return true;
  const from = parseBound(entry.from);
  const until = parseBound(entry.until);
  if (from !== null && now < from) return false;
  if (until !== null && now >= until) return false;
  // A weekly repeat narrows the default window further (see above).
  if (entry.repeat && !inRepeatSlot(entry.repeat, now)) return false;
  return true;
}

// Whether a video is within its window for a viewer in `groupIds`: the default
// window, OR the window of any group they belong to. See "Per-group windows"
// for why this must stay an OR.
export function isWithinWindowFor(entry, groupIds, now = Date.now()) {
  if (isWithinWindow(entry, now)) return true;
  const groups = entry?.groups;
  if (!groups || typeof groups !== 'object' || !Array.isArray(groupIds)) return false;
  return groupIds.some(
    (id) =>
      isGroupKey(id) &&
      Object.prototype.hasOwnProperty.call(groups, id) &&
      isWithinWindow({ from: groups[id]?.from, until: groups[id]?.until }, now)
  );
}

// For the admin UI badge — describes an entry without deciding anything.
// 'off-slot' is inside its dates but between weekly slots right now.
export function windowState(entry, now = Date.now()) {
  const from = parseBound(entry?.from);
  const until = parseBound(entry?.until);
  const repeat = normalizeRepeat(entry?.repeat);
  if (from === null && until === null && !repeat) return 'always';
  if (from !== null && now < from) return 'scheduled';
  if (until !== null && now >= until) return 'expired';
  if (repeat && !inRepeatSlot(repeat, now)) return 'off-slot';
  return 'live';
}

// `groupIds` is the viewer's groups, for per-group windows; omit it for the
// default window only. (Staff pass an empty map and so see everything.)
export function filterVideosBySchedule(videos, scheduleMap, now = Date.now(), groupIds = null) {
  const map = scheduleMap || {};
  return (videos || []).filter((v) => isWithinWindowFor(map[v?.guid], groupIds, now));
}
