import { describe, it, expect } from 'vitest';
import {
  clampHours,
  DEFAULT_HOURS,
  MAX_HOURS,
  GRACE_SECONDS,
  ttlSecondsFor,
  isShareActive,
  shareStatus,
  planPurge,
} from '../share';

describe('clampHours', () => {
  it('uses the default when missing or non-numeric', () => {
    expect(clampHours(undefined)).toBe(DEFAULT_HOURS);
    expect(clampHours('')).toBe(DEFAULT_HOURS);
    expect(clampHours('nope')).toBe(DEFAULT_HOURS);
  });

  it('floors negative values up to 1', () => {
    // 0 is falsy, so it hits the same default-value branch as missing input.
    expect(clampHours(0)).toBe(DEFAULT_HOURS);
    expect(clampHours(-5)).toBe(1);
  });

  it('caps above the max down to the max', () => {
    expect(clampHours(MAX_HOURS + 100)).toBe(MAX_HOURS);
  });

  it('passes through valid integer values', () => {
    expect(clampHours(24)).toBe(24);
    expect(clampHours('48')).toBe(48);
  });
});

describe('ttlSecondsFor', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('adds the grace window on top of time remaining until expiry', () => {
    const expiresAt = new Date(now + 3600 * 1000).toISOString(); // 1h out
    expect(ttlSecondsFor(expiresAt, now)).toBe(3600 + GRACE_SECONDS);
  });

  it('still returns a positive TTL for an already-past expiresAt (grace only)', () => {
    const expiresAt = new Date(now - 3600 * 1000).toISOString(); // 1h ago
    expect(ttlSecondsFor(expiresAt, now)).toBe(1 + GRACE_SECONDS);
  });
});

describe('isShareActive / shareStatus', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const future = new Date(now + 3600 * 1000).toISOString();
  const past = new Date(now - 3600 * 1000).toISOString();

  it('is active only when not revoked and not past expiry', () => {
    expect(isShareActive({ expiresAt: future }, now)).toBe(true);
    expect(shareStatus({ expiresAt: future }, now)).toBe('active');
  });

  it('is inactive once past its logical expiry, even if the record still exists', () => {
    expect(isShareActive({ expiresAt: past }, now)).toBe(false);
    expect(shareStatus({ expiresAt: past }, now)).toBe('expired');
  });

  it('revoked wins over an otherwise-active expiry', () => {
    const share = { expiresAt: future, revokedAt: new Date(now).toISOString() };
    expect(isShareActive(share, now)).toBe(false);
    expect(shareStatus(share, now)).toBe('revoked');
  });

  it('treats a missing record as inactive/gone', () => {
    expect(isShareActive(null, now)).toBe(false);
    expect(shareStatus(null, now)).toBe('gone');
  });
});

describe('planPurge', () => {
  it('only marks a revoked share eligible for the real delete', () => {
    const ids = ['a', 'b', 'c'];
    const shares = [
      { revokedAt: '2026-01-01T00:00:00Z' }, // a: revoked, eligible
      null, // b: gone
      { expiresAt: '2026-01-01T00:00:00Z' }, // c: exists, never revoked
    ];
    const { results, eligibleIds } = planPurge(ids, shares);
    expect(eligibleIds).toEqual(['a']);
    expect(results).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: false, error: 'Link does not exist' },
      { id: 'c', ok: false, error: 'Only a revoked link can be permanently deleted' },
    ]);
  });

  it('is eligible-empty when nothing in the selection is revoked', () => {
    const { eligibleIds } = planPurge(['x'], [{ expiresAt: '2026-01-01T00:00:00Z' }]);
    expect(eligibleIds).toEqual([]);
  });

  it('preserves input order in the results list', () => {
    const ids = ['x', 'y'];
    const shares = [null, { revokedAt: '2026-01-01T00:00:00Z' }];
    const { results } = planPurge(ids, shares);
    expect(results.map((r) => r.id)).toEqual(['x', 'y']);
  });
});
