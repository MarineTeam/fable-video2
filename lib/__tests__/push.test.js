import { describe, it, expect } from 'vitest';
import { shouldAnnounce, eligibleSubs, ANNOUNCE_WINDOW_MS } from '../push';

const NOW = Date.parse('2026-07-01T12:00:00Z');

describe('shouldAnnounce', () => {
  it('announces a recently uploaded, finished video', () => {
    const video = { status: 4, dateUploaded: '2026-07-01T00:00:00Z' };
    expect(shouldAnnounce(video, NOW)).toBe(true);
  });

  it('never announces videos that are not finished encoding', () => {
    expect(shouldAnnounce({ status: 2, dateUploaded: '2026-07-01T00:00:00Z' }, NOW)).toBe(false);
    expect(shouldAnnounce({ status: 5, dateUploaded: '2026-07-01T00:00:00Z' }, NOW)).toBe(false);
  });

  it('never back-blasts old library videos', () => {
    const old = { status: 4, dateUploaded: new Date(NOW - ANNOUNCE_WINDOW_MS - 1000).toISOString() };
    expect(shouldAnnounce(old, NOW)).toBe(false);
  });

  it('rejects missing or unparseable upload dates', () => {
    expect(shouldAnnounce({ status: 4 }, NOW)).toBe(false);
    expect(shouldAnnounce({ status: 4, dateUploaded: 'garbage' }, NOW)).toBe(false);
    expect(shouldAnnounce(null, NOW)).toBe(false);
  });
});

describe('eligibleSubs', () => {
  const sub = (email, endpoint = 'https://push.example/x') => ({
    email,
    sub: { endpoint },
  });

  it('keeps only currently-allowed emails', () => {
    const entries = [sub('a@x.com'), sub('removed@x.com'), sub('b@x.com')];
    const result = eligibleSubs(entries, new Set(['a@x.com', 'b@x.com']));
    expect(result.map((e) => e.email)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('matches emails case-insensitively', () => {
    const result = eligibleSubs([sub('A@X.com')], new Set(['a@x.com']));
    expect(result).toHaveLength(1);
  });

  it('drops malformed entries', () => {
    const entries = [null, { email: 'a@x.com' }, { email: 'a@x.com', sub: {} }];
    expect(eligibleSubs(entries, new Set(['a@x.com']))).toEqual([]);
  });
});
