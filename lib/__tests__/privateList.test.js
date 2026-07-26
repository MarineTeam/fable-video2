import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitPrivateListEmails } from '../privateList';

describe('splitPrivateListEmails', () => {
  it('returns every requested email when none are already on the list', () => {
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], [])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('leaves emails already on the list out of the result', () => {
    const active = [{ email: 'a@x.com' }];
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], active)).toEqual(['b@x.com']);
  });

  it('dedupes the requested list against itself', () => {
    expect(splitPrivateListEmails(['a@x.com', 'A@X.com', 'a@x.com'], [])).toEqual(['a@x.com']);
  });

  it('normalizes case and whitespace before comparing against active shares', () => {
    const active = [{ email: 'bob@example.com' }];
    expect(splitPrivateListEmails(['  Bob@Example.com  '], active)).toEqual([]);
  });

  it('drops empty/blank entries', () => {
    expect(splitPrivateListEmails(['', '  ', 'a@x.com'], [])).toEqual(['a@x.com']);
  });

  it('returns nothing new when the whole request is already active', () => {
    const active = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
    expect(splitPrivateListEmails(['a@x.com', 'b@x.com'], active)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end isolation proof against a fake, in-memory Redis. This exercises
// the real lib/share.js + lib/privateList.js code paths (not just the pure
// split helper above) to prove — not merely assert — that a share created
// through the regular Share/Bulk Share flow is invisible to, and unaffected
// by, a video's Private list, and vice versa.
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted above the rest of the file, so the fake
// instance has to be created via vi.hoisted rather than a plain outer
// variable (which would still be in its temporal dead zone when the
// factory runs).
const { fakeRedis } = vi.hoisted(() => {
  function makeFakeRedis() {
    const store = new Map();
    const ttls = new Map();
    return {
      __reset() {
        store.clear();
        ttls.clear();
      },
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
        return 'OK';
      },
      async mget(...keys) {
        return keys.map((key) => (store.has(key) ? store.get(key) : null));
      },
      async sadd(key, ...members) {
        const set = store.get(key) || new Set();
        members.forEach((m) => set.add(m));
        store.set(key, set);
        return members.length;
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
      async ttl(key) {
        return ttls.has(key) ? ttls.get(key) : -1;
      },
      async expire(key, seconds) {
        ttls.set(key, seconds);
        return 1;
      },
    };
  }
  return { fakeRedis: makeFakeRedis() };
});

vi.mock('../redis', () => ({ redis: () => fakeRedis, k: (name) => `fable2:${name}` }));

const { createShare, revokeShare, loadShare } = await import('../share');
const { loadPrivateList, recordPrivateListShare, revokePrivateListEntry } = await import('../privateList');

describe('Private list isolation from regular Share/Bulk Share (end-to-end)', () => {
  beforeEach(() => {
    fakeRedis.__reset();
  });

  it('a share created outside the list never appears on it', async () => {
    const videoId = 'video-1';
    const email = 'person@example.com';

    await createShare({ videoId, email, hours: 72 }); // regular Share/Bulk Share flow

    expect(await loadPrivateList(videoId)).toEqual([]);
  });

  it('adding an email already granted access outside the list still creates its own independent share', async () => {
    const videoId = 'video-2';
    const email = 'person@example.com';

    const { id: regularId } = await createShare({ videoId, email, hours: 72 });
    const { id: listId, share: listShare } = await createShare({ videoId, email, hours: 720 });
    await recordPrivateListShare(videoId, email, listId, listShare);

    expect(listId).not.toBe(regularId);
    const entries = await loadPrivateList(videoId);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(listId);
  });

  it('removing from the list revokes only the list\'s own share, not a separately-created one for the same video/email', async () => {
    const videoId = 'video-3';
    const email = 'person@example.com';

    const { id: regularId } = await createShare({ videoId, email, hours: 72 });
    const { id: listId, share: listShare } = await createShare({ videoId, email, hours: 720 });
    await recordPrivateListShare(videoId, email, listId, listShare);

    await revokePrivateListEntry(videoId, email);

    const regularShare = await loadShare(regularId);
    expect(regularShare.revokedAt).toBeUndefined();
    expect(await loadPrivateList(videoId)).toEqual([]);
  });

  it('revoking a share created outside the list never removes an unrelated tracked entry', async () => {
    const videoId = 'video-4';
    const email = 'person@example.com';

    const { id: regularId } = await createShare({ videoId, email, hours: 72 });
    const { id: listId, share: listShare } = await createShare({ videoId, email, hours: 720 });
    await recordPrivateListShare(videoId, email, listId, listShare);

    await revokeShare(regularId);

    const entries = await loadPrivateList(videoId);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(listId);
  });

  it('a video\'s tracked list is unaffected by a different video\'s list', async () => {
    const email = 'person@example.com';
    const { id: idA, share: shareA } = await createShare({ videoId: 'video-5a', email, hours: 720 });
    await recordPrivateListShare('video-5a', email, idA, shareA);

    expect(await loadPrivateList('video-5b')).toEqual([]);
    await revokePrivateListEntry('video-5b', email); // no-op, nothing tracked there
    expect(await loadPrivateList('video-5a')).toHaveLength(1);
  });

  it('re-inviting after removal is a fresh, independently-tracked share', async () => {
    const videoId = 'video-6';
    const email = 'person@example.com';

    const { id: firstId, share: firstShare } = await createShare({ videoId, email, hours: 720 });
    await recordPrivateListShare(videoId, email, firstId, firstShare);
    await revokePrivateListEntry(videoId, email);
    expect(await loadPrivateList(videoId)).toEqual([]);

    const { id: secondId, share: secondShare } = await createShare({ videoId, email, hours: 720 });
    await recordPrivateListShare(videoId, email, secondId, secondShare);

    expect(secondId).not.toBe(firstId);
    const entries = await loadPrivateList(videoId);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(secondId);
  });
});
