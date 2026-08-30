import { describe, it, expect } from 'vitest';
import {
  normalizeGroupName,
  groupIdFromName,
  isValidGroupId,
  resolveContentScope,
  isVideoVisible,
  filterVideosByScope,
  isCollectionVisible,
  filterCollectionsByScope,
  groupsForMember,
  membersOfGroup,
  DENY_SCOPE,
  MAX_GROUP_NAME_LENGTH,
} from '../groups';

const deck = { id: 'deck', name: 'Deck', collectionIds: ['col-a'], videoIds: ['vid-1'] };
const engine = { id: 'engine', name: 'Engine', collectionIds: ['col-b'], videoIds: [] };
const empty = { id: 'empty', name: 'Empty', collectionIds: [], videoIds: [] };

describe('group names and ids', () => {
  it('trims, collapses whitespace and caps length', () => {
    expect(normalizeGroupName('  Deck   crew ')).toBe('Deck crew');
    expect(normalizeGroupName('x'.repeat(200))).toHaveLength(MAX_GROUP_NAME_LENGTH);
    expect(normalizeGroupName('')).toBeNull();
  });

  it('slugs with a collision-proof suffix and validates strictly', () => {
    expect(groupIdFromName('Deck Crew', () => 'zz9')).toBe('deck-crew-zz9');
    expect(isValidGroupId('deck-crew-zz9')).toBe(true);
    expect(isValidGroupId('Deck Crew')).toBe(false);
  });
});

describe('resolveContentScope', () => {
  it('is unrestricted while gating is off, whatever the groups say', () => {
    const scope = resolveContentScope({ gatingOn: false, staff: false, groups: [deck], defaultAccess: 'closed' });
    expect(scope.unrestricted).toBe(true);
  });

  it('is unrestricted for staff even when gating is on', () => {
    const scope = resolveContentScope({ gatingOn: true, staff: true, groups: [empty], defaultAccess: 'closed' });
    expect(scope.unrestricted).toBe(true);
  });

  it('gives an ungrouped viewer the whole library under the open default', () => {
    const scope = resolveContentScope({ gatingOn: true, staff: false, groups: [], defaultAccess: 'open' });
    expect(scope.unrestricted).toBe(true);
  });

  it('gives an ungrouped viewer nothing under the closed default', () => {
    const scope = resolveContentScope({ gatingOn: true, staff: false, groups: [], defaultAccess: 'closed' });
    expect(scope).toEqual({ unrestricted: false, collectionIds: [], videoIds: [] });
  });

  it('unions the scopes of every group the viewer belongs to', () => {
    const scope = resolveContentScope({
      gatingOn: true,
      staff: false,
      groups: [deck, engine],
      defaultAccess: 'open',
    });
    expect(scope.unrestricted).toBe(false);
    expect(scope.collectionIds).toEqual(['col-a', 'col-b']);
    expect(scope.videoIds).toEqual(['vid-1']);
  });

  // "Groups restrict" — belonging to a group that names no content is not a
  // route back to the whole library.
  it('grants nothing for a group scoped to nothing', () => {
    const scope = resolveContentScope({
      gatingOn: true,
      staff: false,
      groups: [empty],
      defaultAccess: 'open',
    });
    expect(scope).toEqual({ unrestricted: false, collectionIds: [], videoIds: [] });
    expect(isVideoVisible(scope, { guid: 'vid-1', collectionId: 'col-a' })).toBe(false);
  });
});

describe('isVideoVisible', () => {
  const scope = { unrestricted: false, collectionIds: ['col-a'], videoIds: ['vid-9'] };

  it('passes everything for an unrestricted scope', () => {
    expect(isVideoVisible({ unrestricted: true }, { guid: 'anything' })).toBe(true);
  });

  it('admits a video named directly', () => {
    expect(isVideoVisible(scope, { guid: 'vid-9', collectionId: 'col-z' })).toBe(true);
  });

  it('admits a video via its collection', () => {
    expect(isVideoVisible(scope, { guid: 'vid-2', collectionId: 'col-a' })).toBe(true);
  });

  it('refuses a video in neither', () => {
    expect(isVideoVisible(scope, { guid: 'vid-2', collectionId: 'col-z' })).toBe(false);
  });

  it('refuses a video with no ids rather than letting a blank match', () => {
    expect(isVideoVisible({ unrestricted: false, collectionIds: [''], videoIds: [''] }, {})).toBe(false);
  });

  it('denies everything under the fail-closed scope', () => {
    expect(isVideoVisible(DENY_SCOPE, { guid: 'vid-9', collectionId: 'col-a' })).toBe(false);
  });

  it('filters a list', () => {
    const videos = [
      { guid: 'vid-9', collectionId: '' },
      { guid: 'vid-2', collectionId: 'col-a' },
      { guid: 'vid-3', collectionId: 'col-z' },
    ];
    expect(filterVideosByScope(videos, scope).map((v) => v.guid)).toEqual(['vid-9', 'vid-2']);
    expect(filterVideosByScope(videos, { unrestricted: true })).toHaveLength(3);
  });
});

describe('collection visibility', () => {
  const scope = { unrestricted: false, collectionIds: ['col-a'], videoIds: ['vid-9'] };

  it('shows only collections the scope names', () => {
    expect(isCollectionVisible(scope, 'col-a')).toBe(true);
    expect(isCollectionVisible(scope, 'col-b')).toBe(false);
    expect(isCollectionVisible({ unrestricted: true }, 'col-b')).toBe(true);
  });

  it('filters a collection list', () => {
    const cols = [{ guid: 'col-a' }, { guid: 'col-b' }];
    expect(filterCollectionsByScope(cols, scope).map((c) => c.guid)).toEqual(['col-a']);
  });
});

describe('membership helpers', () => {
  const groupsById = { deck, engine };

  it('resolves a member’s group records, skipping ids with no record', () => {
    expect(groupsForMember('A@X.com', ['deck', 'gone'], groupsById)).toEqual([deck]);
  });

  it('returns nothing for an unusable email', () => {
    expect(groupsForMember('  ', ['deck'], groupsById)).toEqual([]);
  });

  it('inverts the membership hash into a sorted member list', () => {
    const memberships = { 'b@x.com': ['deck'], 'a@x.com': ['deck', 'engine'], 'c@x.com': ['engine'] };
    expect(membersOfGroup(memberships, 'deck')).toEqual(['a@x.com', 'b@x.com']);
    expect(membersOfGroup(memberships, 'nobody')).toEqual([]);
  });
});
