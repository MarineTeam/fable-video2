import { describe, it, expect } from 'vitest';
import { rollupSharesByVideo } from '../videoAnalytics';

const s = (overrides) => ({ videoId: 'v1', email: 'a@example.com', ...overrides });

describe('rollupSharesByVideo', () => {
  it('handles empty/missing input', () => {
    expect(rollupSharesByVideo(null)).toEqual({});
    expect(rollupSharesByVideo([])).toEqual({});
  });

  it('ignores records with no videoId', () => {
    expect(rollupSharesByVideo([{ email: 'a@example.com' }])).toEqual({});
  });

  it('counts shares and unique recipients separately', () => {
    const out = rollupSharesByVideo([
      s({ email: 'a@example.com' }),
      s({ email: 'a@example.com' }),
      s({ email: 'b@example.com' }),
    ]);
    expect(out.v1.shares).toBe(3);
    expect(out.v1.uniqueRecipients).toBe(2);
  });

  it('sums views, counts started (plays>0) and completed', () => {
    const out = rollupSharesByVideo([
      s({ views: 3, plays: 2, completedAt: '2026-01-01T00:00:00Z' }),
      s({ views: 1, plays: 0 }),
      s({}),
    ]);
    expect(out.v1.views).toBe(4);
    expect(out.v1.started).toBe(1);
    expect(out.v1.completed).toBe(1);
  });

  it('computes completion rate against started, not total shares', () => {
    const out = rollupSharesByVideo([
      s({ plays: 1, completedAt: 'x' }),
      s({ plays: 1 }),
      s({}), // never started — excluded from the rate's denominator
    ]);
    expect(out.v1.started).toBe(2);
    expect(out.v1.completed).toBe(1);
    expect(out.v1.completionRate).toBe(0.5);
  });

  it('rate and avg progress are 0 with no data, never NaN or divide-by-zero', () => {
    const out = rollupSharesByVideo([s({})]);
    expect(out.v1.completionRate).toBe(0);
    expect(out.v1.avgProgress).toBe(0);
  });

  it('averages furthestPercent only over shares that reported it', () => {
    const out = rollupSharesByVideo([
      s({ furthestPercent: 50 }),
      s({ furthestPercent: 100 }),
      s({}),
    ]);
    expect(out.v1.avgProgress).toBe(75);
  });

  it('rolls up multiple videos independently', () => {
    const out = rollupSharesByVideo([s({ videoId: 'v1' }), s({ videoId: 'v2', views: 5 })]);
    expect(Object.keys(out).sort()).toEqual(['v1', 'v2']);
    expect(out.v2.views).toBe(5);
  });
});
