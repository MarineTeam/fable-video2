// Repeating (weekly) windows and per-group windows (lib/schedule.js).
//
// Every instant below is written in UTC with the local time it corresponds
// to in the rule's zone beside it, because the whole point of the time zone
// is that the two differ — and differ by a different amount across a
// daylight-saving change. (2026-09-20 and 2026-11-01 are Sundays.)
import { describe, it, expect } from 'vitest';
import {
  filterVideosBySchedule,
  inRepeatSlot,
  isValidTimeZone,
  isWithinWindow,
  isWithinWindowFor,
  MAX_GROUP_WINDOWS,
  normalizeEntry,
  validateGroupWindows,
  validateRepeat,
  windowState,
} from '../schedule';

const at = (iso) => Date.parse(iso);

// Sunday service, 09:00–13:00 London time.
const sundayMorning = { days: [0], start: '09:00', end: '13:00', timeZone: 'Europe/London' };

describe('inRepeatSlot', () => {
  it('is inside the slot on the right day at the right local time (summer, UTC+1)', () => {
    // Sun 2026-09-20 10:00 London = 09:00 UTC
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T09:00:00Z'))).toBe(true);
  });

  it('is outside before the start and AT the end (end is exclusive)', () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T07:59:00Z'))).toBe(false); // 08:59 London
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T12:00:00Z'))).toBe(false); // 13:00 London
  });

  it('is outside on another day at the same time', () => {
    expect(inRepeatSlot(sundayMorning, at('2026-09-21T09:00:00Z'))).toBe(false); // Mon 10:00
  });

  it("uses the RULE's time zone, not UTC, and follows daylight saving", () => {
    // 08:30 UTC is 09:30 London in summer (inside) but 08:30 in winter (outside).
    expect(inRepeatSlot(sundayMorning, at('2026-09-20T08:30:00Z'))).toBe(true);
    expect(inRepeatSlot(sundayMorning, at('2026-11-01T08:30:00Z'))).toBe(false);
    expect(inRepeatSlot(sundayMorning, at('2026-11-01T09:30:00Z'))).toBe(true);
  });

  it('works in a zone far from UTC, where the local DAY differs', () => {
    const la = { ...sundayMorning, timeZone: 'America/Los_Angeles' };
    expect(inRepeatSlot(la, at('2026-09-20T17:00:00Z'))).toBe(true); // Sun 10:00 PDT
    expect(inRepeatSlot(la, at('2026-09-21T02:00:00Z'))).toBe(false); // still Sun, 19:00 PDT
  });

  it('runs a slot past midnight into the next day, and only that day', () => {
    const lateSaturday = { days: [6], start: '22:00', end: '02:00', timeZone: 'UTC' };
    expect(inRepeatSlot(lateSaturday, at('2026-09-19T23:00:00Z'))).toBe(true); // Sat 23:00
    expect(inRepeatSlot(lateSaturday, at('2026-09-20T01:30:00Z'))).toBe(true); // Sun 01:30
    expect(inRepeatSlot(lateSaturday, at('2026-09-20T02:00:00Z'))).toBe(false); // Sun 02:00
    expect(inRepeatSlot(lateSaturday, at('2026-09-19T21:59:00Z'))).toBe(false); // Sat 21:59
    expect(inRepeatSlot(lateSaturday, at('2026-09-19T01:00:00Z'))).toBe(false); // Sat 01:00
  });

  it('covers several days', () => {
    const weekdays = { days: [1, 2, 3, 4, 5], start: '18:00', end: '20:00', timeZone: 'UTC' };
    expect(inRepeatSlot(weekdays, at('2026-09-23T19:00:00Z'))).toBe(true); // Wed
    expect(inRepeatSlot(weekdays, at('2026-09-26T19:00:00Z'))).toBe(false); // Sat
  });

  it('treats a malformed stored rule as NO rule rather than taking the video down', () => {
    expect(inRepeatSlot({ days: [0], start: '9am', end: '13:00', timeZone: 'UTC' })).toBe(true);
    expect(inRepeatSlot({ days: [0], start: '09:00', end: '13:00', timeZone: 'Mars/Olympus' })).toBe(true);
  });
});

describe('repeat narrows the DEFAULT window', () => {
  const entry = { from: '2026-09-01T00:00:00.000Z', until: null, repeat: sundayMorning };

  it('is within inside both the dates and a slot, and not outside the slot', () => {
    expect(isWithinWindow(entry, at('2026-09-20T09:00:00Z'))).toBe(true);
    expect(isWithinWindow(entry, at('2026-09-21T09:00:00Z'))).toBe(false);
  });

  it('is not within inside a slot but before the start date', () => {
    expect(isWithinWindow(entry, at('2026-08-30T09:00:00Z'))).toBe(false);
  });

  it('narrows a record that has no dates at all', () => {
    const onlyRule = { from: null, until: null, repeat: sundayMorning };
    expect(isWithinWindow(onlyRule, at('2026-09-21T09:00:00Z'))).toBe(false);
  });

  it("does NOT bind a group's own window — leaders can preview outside service hours", () => {
    const withGroup = { ...entry, groups: { 'leaders-a1': { from: '2026-09-01T00:00:00.000Z', until: null } } };
    const mondayMorning = at('2026-09-21T09:00:00Z');
    expect(isWithinWindowFor(withGroup, ['leaders-a1'], mondayMorning)).toBe(true);
    expect(isWithinWindowFor(withGroup, ['crew-b2'], mondayMorning)).toBe(false);
  });

  it('describes the between-slots state for the admin badge', () => {
    expect(windowState(entry, at('2026-09-20T09:00:00Z'))).toBe('live');
    expect(windowState(entry, at('2026-09-21T09:00:00Z'))).toBe('off-slot');
    expect(windowState(entry, at('2026-08-30T09:00:00Z'))).toBe('scheduled');
    expect(windowState({ from: null, until: null, repeat: sundayMorning }, at('2026-09-21T09:00:00Z'))).toBe(
      'off-slot'
    );
  });
});

describe('validateRepeat', () => {
  it('accepts a sensible rule, and nothing at all', () => {
    expect(validateRepeat(sundayMorning)).toBeNull();
    expect(validateRepeat(null)).toBeNull();
    expect(validateRepeat(undefined)).toBeNull();
  });

  it.each([
    [{ ...sundayMorning, days: [] }, /at least one day/],
    [{ ...sundayMorning, days: [7] }, /at least one day/],
    [{ ...sundayMorning, start: '9:00' }, /HH:MM/],
    [{ ...sundayMorning, end: '24:00' }, /HH:MM/],
    [{ ...sundayMorning, end: '09:00' }, /same time/],
    [{ ...sundayMorning, timeZone: 'Nowhere/Special' }, /time zone/],
    [[1, 2], /not valid/],
  ])('refuses %j', (rule, message) => {
    expect(validateRepeat(rule)).toMatch(message);
  });

  it('knows a real time zone from a made-up one', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Nowhere/Special')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('per-group windows are ADDITIVE only', () => {
  const NOW = at('2026-09-15T12:00:00Z');
  // Everyone from October; youth leaders from September 10th.
  const entry = {
    from: '2026-10-01T00:00:00.000Z',
    until: null,
    groups: { 'youth-leaders-x1': { from: '2026-09-10T00:00:00.000Z', until: null } },
  };

  it("lets a member watch in their group's window before everyone else", () => {
    expect(isWithinWindowFor(entry, ['youth-leaders-x1'], NOW)).toBe(true);
    expect(isWithinWindowFor(entry, ['choir-z9'], NOW)).toBe(false);
    expect(isWithinWindowFor(entry, [], NOW)).toBe(false);
  });

  it('falls back to the default window when the groups are not supplied — the safe direction', () => {
    expect(isWithinWindowFor(entry, null, NOW)).toBe(false);
    expect(isWithinWindowFor(entry, undefined, NOW)).toBe(false);
  });

  it('can never HIDE a video from a group the default window shows it to', () => {
    const hold = { from: null, until: null, groups: { 'youth-x1': { from: '2099-01-01T00:00:00.000Z', until: null } } };
    expect(isWithinWindowFor(hold, ['youth-x1'], NOW)).toBe(true);
  });

  it('keeps a group window that has ended closed', () => {
    const ended = { ...entry, groups: { 'youth-x1': { from: null, until: '2026-09-01T00:00:00.000Z' } } };
    expect(isWithinWindowFor(ended, ['youth-x1'], NOW)).toBe(false);
  });

  it('does not read inherited properties as group windows', () => {
    expect(isWithinWindowFor(entry, ['constructor', '__proto__', 'toString'], NOW)).toBe(false);
  });

  it('filters a list by the viewer’s groups', () => {
    const videos = [{ guid: 'a' }, { guid: 'b' }];
    const map = { a: entry };
    expect(filterVideosBySchedule(videos, map, NOW).map((v) => v.guid)).toEqual(['b']);
    expect(filterVideosBySchedule(videos, map, NOW, ['youth-leaders-x1']).map((v) => v.guid)).toEqual(['a', 'b']);
  });
});

describe('validateGroupWindows', () => {
  const known = ['youth-x1', 'choir-z9'];

  it('accepts windows for groups that exist, and drops empty ones', () => {
    const r = validateGroupWindows(
      { 'youth-x1': { from: '2026-09-10T00:00', until: '' }, 'choir-z9': { from: '', until: '' } },
      known
    );
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.groups)).toEqual(['youth-x1']);
    expect(r.groups['youth-x1'].from).toMatch(/^2026-09-10T/);
  });

  it('reads nothing as no group windows', () => {
    expect(validateGroupWindows(null, known)).toEqual({ groups: null });
    expect(validateGroupWindows({}, known)).toEqual({ groups: null });
  });

  it('refuses a window for a group that does not exist', () => {
    expect(validateGroupWindows({ 'gone-q1': { from: '2026-09-10T00:00' } }, known).error).toMatch(/no longer exists/);
    expect(validateGroupWindows({ __proto__: { from: '2026-09-10T00:00' } }, ['__proto__']).groups).toBeNull();
  });

  it('refuses an inverted group window', () => {
    const r = validateGroupWindows({ 'youth-x1': { from: '2026-09-10T00:00', until: '2026-09-01T00:00' } }, known);
    expect(r.error).toMatch(/end after it starts/);
  });

  it('refuses too many, and a non-object', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_GROUP_WINDOWS + 1 }, (_, i) => [`g-${i}`, { from: '2026-09-10T00:00' }])
    );
    expect(validateGroupWindows(many, Object.keys(many)).error).toMatch(/At most/);
    expect(validateGroupWindows([], known).error).toMatch(/object/);
  });
});

describe('normalizeEntry', () => {
  it('keeps a record that has only a repeat, or only group windows', () => {
    expect(normalizeEntry({ repeat: sundayMorning })).toEqual({ from: null, until: null, repeat: sundayMorning });
    expect(normalizeEntry({ groups: { 'youth-x1': { from: '2026-09-10T00:00:00.000Z' } } })).toEqual({
      from: null,
      until: null,
      groups: { 'youth-x1': { from: '2026-09-10T00:00:00.000Z', until: null } },
    });
  });

  it('drops a malformed repeat and unusable group keys, and is null when nothing is left', () => {
    expect(normalizeEntry({ repeat: { days: [0] }, groups: { 'Bad Key': { from: '2026-09-10' } } })).toBeNull();
    expect(normalizeEntry({ from: 'garbage' })).toBeNull();
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry([])).toBeNull();
  });
});
