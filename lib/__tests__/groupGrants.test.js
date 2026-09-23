// grantVideoToGroups / pruneVideoFromGroups against an in-memory groups hash:
// they touch exactly the groups they should, keep every other grant, and
// never recreate a deleted group or overfill one (saveGroup sorts and cuts,
// so an overfilled group would silently lose whichever grant sorts last).
import { beforeEach, describe, expect, it, vi } from 'vitest';

let hash = {};

vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({
    hgetall: async () => ({ ...hash }),
    hset: async (_key, obj) => Object.assign(hash, obj),
  }),
}));

const { grantVideoToGroups, pruneVideoFromGroups, MAX_SCOPE_ENTRIES } = await import('../groups');

const group = (id, over = {}) => ({ id, name: id, collectionIds: [], videoIds: [], ...over });

beforeEach(() => {
  hash = {
    'team-aaaaaa': group('team-aaaaaa', { videoIds: ['old'], collectionIds: ['c1'] }),
    'youth-bbbbbb': group('youth-bbbbbb'),
    'other-cccccc': group('other-cccccc'),
  };
});

describe('grantVideoToGroups', () => {
  it('adds the video to exactly the chosen groups, keeping their other grants', async () => {
    expect(await grantVideoToGroups('new', ['team-aaaaaa', 'youth-bbbbbb'])).toEqual({
      granted: ['team-aaaaaa', 'youth-bbbbbb'],
      failed: [],
    });
    expect(hash['team-aaaaaa'].videoIds).toEqual(['new', 'old']);
    expect(hash['team-aaaaaa'].collectionIds).toEqual(['c1']);
    expect(hash['youth-bbbbbb'].videoIds).toEqual(['new']);
    expect(hash['other-cccccc'].videoIds).toEqual([]);
  });

  it('does not recreate a group deleted since the route checked', async () => {
    expect(await grantVideoToGroups('new', ['gone-dddddd'])).toEqual({ granted: [], failed: ['gone-dddddd'] });
    expect(hash['gone-dddddd']).toBeUndefined();
  });

  it('refuses to overfill a group — which would silently drop a sorted-last grant', async () => {
    const full = Array.from({ length: MAX_SCOPE_ENTRIES }, (_, i) => `v${String(i).padStart(3, '0')}`);
    hash['youth-bbbbbb'] = group('youth-bbbbbb', { videoIds: full });
    const result = await grantVideoToGroups('a-new', ['youth-bbbbbb', 'other-cccccc']);
    expect(result).toEqual({ granted: ['other-cccccc'], failed: ['youth-bbbbbb'] });
    expect(hash['youth-bbbbbb'].videoIds).toEqual(full);
  });
});

describe('pruneVideoFromGroups', () => {
  it('removes deleted videos from every group that granted them, and nothing else', async () => {
    hash['other-cccccc'] = group('other-cccccc', { videoIds: ['old', 'keep'] });
    expect(await pruneVideoFromGroups(['old'])).toBe(2);
    expect(hash['team-aaaaaa'].videoIds).toEqual([]);
    expect(hash['team-aaaaaa'].collectionIds).toEqual(['c1']);
    expect(hash['other-cccccc'].videoIds).toEqual(['keep']);
  });

  it('takes a single guid too, and is a no-op for nothing', async () => {
    expect(await pruneVideoFromGroups('old')).toBe(1);
    expect(await pruneVideoFromGroups([])).toBe(0);
  });
});
