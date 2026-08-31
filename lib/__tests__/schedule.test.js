import { describe, it, expect } from 'vitest';
import {
  parseBound,
  normalizeWindow,
  isWithinWindow,
  windowState,
  filterVideosBySchedule,
} from '../schedule';

const T = (iso) => Date.parse(iso);
const NOW = T('2026-06-15T12:00:00.000Z');

describe('parseBound', () => {
  it('accepts a parseable date string', () => {
    expect(parseBound('2026-06-15T12:00:00.000Z')).toBe(NOW);
  });
  it('rejects blanks and garbage rather than throwing', () => {
    expect(parseBound('')).toBeNull();
    expect(parseBound('   ')).toBeNull();
    expect(parseBound('not a date')).toBeNull();
    expect(parseBound(null)).toBeNull();
    expect(parseBound(12345)).toBeNull();
  });
});

describe('normalizeWindow', () => {
  it('returns null when neither bound is usable — the signal to delete the entry', () => {
    expect(normalizeWindow({})).toBeNull();
    expect(normalizeWindow({ from: '', until: '' })).toBeNull();
    expect(normalizeWindow({ from: 'garbage' })).toBeNull();
  });

  it('normalizes one-sided windows to ISO', () => {
    expect(normalizeWindow({ from: '2026-06-15T12:00' })).toEqual({
      from: new Date(T('2026-06-15T12:00')).toISOString(),
      until: null,
    });
    expect(normalizeWindow({ until: '2026-06-15T12:00' }).from).toBeNull();
  });

  it('rejects an inverted window instead of storing one that can never be live', () => {
    expect(normalizeWindow({ from: '2026-06-15T12:00:00Z', until: '2026-06-01T12:00:00Z' })).toEqual({
      invalid: true,
    });
    // Equal bounds are also empty, not a zero-length window.
    expect(normalizeWindow({ from: '2026-06-15T12:00:00Z', until: '2026-06-15T12:00:00Z' })).toEqual({
      invalid: true,
    });
  });
});

describe('isWithinWindow', () => {
  it('shows a video with no window at all', () => {
    expect(isWithinWindow(null, NOW)).toBe(true);
    expect(isWithinWindow(undefined, NOW)).toBe(true);
    expect(isWithinWindow({}, NOW)).toBe(true);
  });

  it('hides before the start and shows from the start onwards', () => {
    expect(isWithinWindow({ from: '2026-07-01T00:00:00Z' }, NOW)).toBe(false);
    expect(isWithinWindow({ from: '2026-06-01T00:00:00Z' }, NOW)).toBe(true);
    expect(isWithinWindow({ from: '2026-06-15T12:00:00.000Z' }, NOW)).toBe(true);
  });

  it('hides from the end onwards — the end bound is exclusive', () => {
    expect(isWithinWindow({ until: '2026-07-01T00:00:00Z' }, NOW)).toBe(true);
    expect(isWithinWindow({ until: '2026-06-01T00:00:00Z' }, NOW)).toBe(false);
    expect(isWithinWindow({ until: '2026-06-15T12:00:00.000Z' }, NOW)).toBe(false);
  });

  it('applies both bounds together', () => {
    const w = { from: '2026-06-01T00:00:00Z', until: '2026-07-01T00:00:00Z' };
    expect(isWithinWindow(w, NOW)).toBe(true);
    expect(isWithinWindow(w, T('2026-05-01T00:00:00Z'))).toBe(false);
    expect(isWithinWindow(w, T('2026-08-01T00:00:00Z'))).toBe(false);
  });

  // Scheduling is a publishing convenience, not an access boundary: a mistyped
  // date must never silently bury content.
  it('ignores an unparseable bound rather than hiding the video', () => {
    expect(isWithinWindow({ from: 'nonsense' }, NOW)).toBe(true);
    expect(isWithinWindow({ until: 'nonsense' }, NOW)).toBe(true);
  });
});

describe('windowState', () => {
  it('describes an entry for the admin badge', () => {
    expect(windowState(null, NOW)).toBe('always');
    expect(windowState({}, NOW)).toBe('always');
    expect(windowState({ from: 'nonsense' }, NOW)).toBe('always');
    expect(windowState({ from: '2026-07-01T00:00:00Z' }, NOW)).toBe('scheduled');
    expect(windowState({ until: '2026-06-01T00:00:00Z' }, NOW)).toBe('expired');
    expect(windowState({ from: '2026-06-01T00:00:00Z', until: '2026-07-01T00:00:00Z' }, NOW)).toBe(
      'live'
    );
  });
});

describe('filterVideosBySchedule', () => {
  const videos = [{ guid: 'a' }, { guid: 'b' }, { guid: 'c' }];

  it('drops only videos outside their window', () => {
    const map = {
      a: { from: '2026-07-01T00:00:00Z' },
      b: { until: '2026-07-01T00:00:00Z' },
    };
    expect(filterVideosBySchedule(videos, map, NOW).map((v) => v.guid)).toEqual(['b', 'c']);
  });

  it('is a no-op with no schedule data', () => {
    expect(filterVideosBySchedule(videos, {}, NOW)).toHaveLength(3);
    expect(filterVideosBySchedule(videos, null, NOW)).toHaveLength(3);
    expect(filterVideosBySchedule(null, {}, NOW)).toEqual([]);
  });
});
