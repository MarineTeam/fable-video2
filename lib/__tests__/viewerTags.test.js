import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeTag, distinctTags, emailsForTag, MAX_TAG_LENGTH } from '../viewerTags';

describe('normalizeTag', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeTag('  Team   A  ')).toBe('Team A');
  });

  it('caps length', () => {
    expect(normalizeTag('x'.repeat(100))).toHaveLength(MAX_TAG_LENGTH);
  });

  it('returns null for empty/blank input', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag(undefined)).toBeNull();
  });
});

describe('distinctTags', () => {
  it('unions and sorts tags across viewers', () => {
    expect(
      distinctTags({ 'a@x.com': ['Team B', 'Team A'], 'b@x.com': ['Team A'] })
    ).toEqual(['Team A', 'Team B']);
  });

  it('returns an empty list for no viewers', () => {
    expect(distinctTags({})).toEqual([]);
  });
});

describe('emailsForTag', () => {
  it('returns only emails carrying the given tag, sorted', () => {
    const byEmail = { 'b@x.com': ['Team A'], 'a@x.com': ['Team A', 'Team B'], 'c@x.com': ['Team B'] };
    expect(emailsForTag(byEmail, 'Team A')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('returns nothing for a tag no one has', () => {
    expect(emailsForTag({ 'a@x.com': ['Team A'] }, 'Team Z')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against a fake, in-memory Redis, mirroring the pattern in
// privateList.test.js.
// ---------------------------------------------------------------------------

const { fakeRedis } = vi.hoisted(() => {
  function makeFakeRedis() {
    const store = new Map();
    return {
      __reset() {
        store.clear();
      },
      async sadd(key, ...members) {
        const set = store.get(key) || new Set();
        members.forEach((m) => set.add(m));
        store.set(key, set);
        return members.length;
      },
      async sismember(key, member) {
        const set = store.get(key);
        return set && set.has(member) ? 1 : 0;
      },
      async hset(key, obj) {
        const hash = store.get(key) || new Map();
        Object.entries(obj).forEach(([field, value]) => hash.set(field, value));
        store.set(key, hash);
        return Object.keys(obj).length;
      },
      async hget(key, field) {
        const hash = store.get(key);
        return hash ? hash.get(field) ?? null : null;
      },
      async hgetall(key) {
        const hash = store.get(key);
        return hash ? Object.fromEntries(hash.entries()) : null;
      },
      async hdel(key, ...fields) {
        const hash = store.get(key);
        if (!hash) return 0;
        let n = 0;
        fields.forEach((f) => {
          if (hash.delete(f)) n += 1;
        });
        return n;
      },
    };
  }
  return { fakeRedis: makeFakeRedis() };
});

vi.mock('../redis', () => ({ redis: () => fakeRedis, k: (name) => `fable2:${name}` }));

const {
  addTagToViewers,
  removeTagFromViewers,
  getAllViewerTags,
  clearViewerTags,
} = await import('../viewerTags');

describe('addTagToViewers / removeTagFromViewers (end-to-end)', () => {
  beforeEach(async () => {
    fakeRedis.__reset();
    await fakeRedis.sadd('fable2:viewers', 'a@x.com', 'b@x.com');
  });

  it('tags only currently-approved viewers, reporting the rest as failed', async () => {
    const results = await addTagToViewers(['a@x.com', 'ghost@x.com'], 'Team A');
    expect(results).toEqual([
      { email: 'a@x.com', ok: true },
      { email: 'ghost@x.com', ok: false, error: 'Not an approved viewer' },
    ]);
    expect(await getAllViewerTags()).toEqual({ 'a@x.com': ['Team A'] });
  });

  it('is idempotent — tagging the same viewer twice does not duplicate the tag', async () => {
    await addTagToViewers(['a@x.com'], 'Team A');
    await addTagToViewers(['a@x.com'], 'Team A');
    expect(await getAllViewerTags()).toEqual({ 'a@x.com': ['Team A'] });
  });

  it('one bad email never blocks the rest of the batch', async () => {
    const results = await addTagToViewers(['', 'a@x.com', 'b@x.com'], 'Team A');
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await getAllViewerTags()).toEqual({
      'a@x.com': ['Team A'],
      'b@x.com': ['Team A'],
    });
  });

  it('removeTagFromViewers drops the hash field entirely once a viewer has no tags left', async () => {
    await addTagToViewers(['a@x.com'], 'Team A');
    await removeTagFromViewers(['a@x.com'], 'Team A');
    expect(await getAllViewerTags()).toEqual({});
  });

  it('removeTagFromViewers leaves other tags on the same viewer untouched', async () => {
    await addTagToViewers(['a@x.com'], 'Team A');
    await addTagToViewers(['a@x.com'], 'Team B');
    await removeTagFromViewers(['a@x.com'], 'Team A');
    expect(await getAllViewerTags()).toEqual({ 'a@x.com': ['Team B'] });
  });

  it('clearViewerTags removes all tags for a viewer being deleted outright', async () => {
    await addTagToViewers(['a@x.com'], 'Team A');
    await addTagToViewers(['a@x.com'], 'Team B');
    await clearViewerTags('a@x.com');
    expect(await getAllViewerTags()).toEqual({});
  });
});
