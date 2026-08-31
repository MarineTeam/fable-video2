import { describe, it, expect } from 'vitest';
import { normalizeNote, sortRequests, MAX_NOTE_LENGTH } from '../accessRequests';

describe('normalizeNote', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeNote('  please   let me in  ')).toBe('please let me in');
  });
  it('caps length', () => {
    expect(normalizeNote('x'.repeat(500))).toHaveLength(MAX_NOTE_LENGTH);
  });
  it('returns an empty string for missing input rather than null', () => {
    expect(normalizeNote(undefined)).toBe('');
    expect(normalizeNote(null)).toBe('');
    expect(normalizeNote('   ')).toBe('');
  });
});

describe('sortRequests', () => {
  it('puts the oldest request first so the queue is worked front to back', () => {
    const rows = [
      { email: 'c@x.com', at: '2026-06-03T00:00:00Z' },
      { email: 'a@x.com', at: '2026-06-01T00:00:00Z' },
      { email: 'b@x.com', at: '2026-06-02T00:00:00Z' },
    ];
    expect(sortRequests(rows).map((r) => r.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('does not mutate its input', () => {
    const rows = [{ email: 'b@x.com', at: '2026-06-02T00:00:00Z' }, { email: 'a@x.com', at: '2026-06-01T00:00:00Z' }];
    sortRequests(rows);
    expect(rows[0].email).toBe('b@x.com');
  });

  it('tolerates a missing timestamp', () => {
    const rows = [{ email: 'b@x.com', at: null }, { email: 'a@x.com', at: '2026-06-01T00:00:00Z' }];
    expect(sortRequests(rows)).toHaveLength(2);
  });
});
