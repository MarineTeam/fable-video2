// Group-scoped staff: the pure rules, what resolveActor makes of a stored
// scope, and what a scoped staff member sees in the library.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);

const rules = await import('../staffScopeRules');
const { CAP, ALL_CAPABILITIES } = await import('../capabilities');
const { resolveActor } = await import('../guard');
const { contentScopeFor } = await import('../groups');

const groupsById = {
  youth: { id: 'youth', name: 'Youth', collectionIds: ['sermons'], videoIds: ['v1', 'v3'] },
  deck: { id: 'deck', name: 'Deck', collectionIds: [], videoIds: ['v2', 'v3'] },
};
const scoped = (scope) => ({ staffScope: scope, contentScope: rules.contentOfScope(scope, groupsById) });
const unscoped = { staffScope: null, contentScope: null };

describe('the pure rules', () => {
  it('strips exactly the portal-wide capabilities, even for a scope of no groups', () => {
    expect(rules.GLOBAL_CAPABILITIES).toEqual([CAP.SETTINGS_MANAGE, CAP.ROLES_MANAGE, CAP.AUDIT_READ, CAP.BROADCAST_SEND]);
    expect(rules.capabilitiesUnderScope(ALL_CAPABILITIES, ['youth'])).toHaveLength(ALL_CAPABILITIES.length - 4);
    expect(rules.capabilitiesUnderScope([CAP.SETTINGS_MANAGE, CAP.VIDEOS_MANAGE], [])).toEqual([CAP.VIDEOS_MANAGE]);
    expect(rules.capabilitiesUnderScope(ALL_CAPABILITIES, null)).toHaveLength(ALL_CAPABILITIES.length);
  });

  it('keeps null as null and anything else as a list', () => {
    expect(rules.normalizeScope(null)).toBeNull();
    expect(rules.normalizeScope([])).toEqual([]);
    expect(rules.normalizeScope('youth')).toEqual([]);
    expect(rules.normalizeScope(['youth', 'youth', 'Bad Id!', 'deck'])).toEqual(['deck', 'youth']);
  });

  it('reaches what the scope’s existing groups grant — never "unrestricted"', () => {
    expect(rules.contentOfScope(['youth', 'gone'], groupsById)).toEqual({
      unrestricted: false,
      collectionIds: ['sermons'],
      videoIds: ['v1', 'v3'],
    });
    expect(rules.contentOfScope([], groupsById)).toEqual({ unrestricted: false, collectionIds: [], videoIds: [] });
  });

  it('puts videos in scope by id or by collection', () => {
    const a = scoped(['youth']);
    expect(rules.videoInScope(a, { guid: 'v1' })).toBe(true);
    expect(rules.videoInScope(a, { guid: 'v9', collectionId: 'sermons' })).toBe(true);
    expect(rules.videoInScope(a, { guid: 'v2' })).toBe(false);
    expect(rules.videoInScope(unscoped, { guid: 'anything' })).toBe(true);
  });

  it('puts people in scope by a group they share with it', () => {
    const a = scoped(['youth']);
    expect(rules.personInScope(a, ['youth'], groupsById)).toBe(true);
    expect(rules.personInScope(a, ['deck'], groupsById)).toBe(false);
    expect(rules.personInScope(a, [], groupsById)).toBe(false);
  });

  it('never leaves anyone in no group, and touches only the caller’s groups', () => {
    const a = scoped(['youth']);
    expect(rules.membershipChangeProblem(a, ['youth'], [], groupsById)).toMatch(/whole library/);
    expect(rules.membershipChangeProblem(a, ['youth', 'deck'], ['deck'], groupsById)).toBeNull();
    expect(rules.membershipChangeProblem(a, ['youth'], ['youth', 'deck'], groupsById)).toMatch(/your own groups/);
    expect(rules.membershipChangeProblem(unscoped, ['youth'], [], groupsById)).toBeNull();
  });

  it('removes a person, or deletes a video, only when every group involved is theirs', () => {
    const a = scoped(['youth']);
    expect(rules.mayRemovePerson(a, ['youth'], groupsById)).toBe(true);
    expect(rules.mayRemovePerson(a, ['youth', 'deck'], groupsById)).toBe(false);
    expect(rules.mayDeleteVideo(a, { guid: 'v1' }, groupsById)).toBe(true);
    expect(rules.mayDeleteVideo(a, { guid: 'v3' }, groupsById)).toBe(false);
    expect(rules.mayDeleteVideo(a, { guid: 'v2' }, groupsById)).toBe(false);
  });

  it('places new people in the named groups if all are theirs, else their only one', () => {
    expect(rules.placementGroups(scoped(['youth']), undefined, groupsById)).toEqual(['youth']);
    expect(rules.placementGroups(scoped(['youth', 'deck']), undefined, groupsById)).toBeNull();
    expect(rules.placementGroups(scoped(['youth', 'deck']), ['deck'], groupsById)).toEqual(['deck']);
    expect(rules.placementGroups(scoped(['youth']), ['deck'], groupsById)).toBeNull();
    expect(rules.placementGroups(unscoped, ['deck'], groupsById)).toBeUndefined();
  });
});

function world() {
  const groups = mem.hash('fable2:groups');
  for (const g of Object.values(groupsById)) groups.set(g.id, g);
  mem.hash('fable2:roles').set('staff', {
    id: 'staff',
    name: 'Staff',
    capabilities: ['videos.read', 'videos.manage', 'settings.manage'],
  });
  mem.hash('fable2:user:roles').set('s@x.com', ['staff']);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mem.reset();
  process.env.ADMIN_EMAILS = 'owner@x.com';
  process.env.GROUP_CONTENT_GATING = '1';
  world();
});

describe('resolveActor with a scope', () => {
  it('leaves an unscoped staff member as before', async () => {
    const actor = await resolveActor('s@x.com');
    expect(actor.staffScope).toBeNull();
    expect(actor.capabilities).toContain('settings.manage');
  });

  it('strips portal-wide capabilities and records the content the scope reaches', async () => {
    mem.hash('fable2:user:scope').set('s@x.com', JSON.stringify(['youth']));
    const actor = await resolveActor('s@x.com');
    expect(actor.staffScope).toEqual(['youth']);
    expect(actor.capabilities).toEqual(['videos.manage', 'videos.read']);
    expect(actor.contentScope.videoIds).toEqual(['v1', 'v3']);
  });

  it('gives no capabilities at all when the scope cannot be read', async () => {
    const real = mem.hash.bind(mem);
    vi.spyOn(mem, 'hash').mockImplementation((key) => {
      if (key === 'fable2:user:scope') throw new Error('redis down');
      return real(key);
    });
    const actor = await resolveActor('s@x.com');
    expect(actor.capabilities).toEqual([]);
    expect(actor.staff).toBe(false);
  });

  it('ignores any scope stored for an owner', async () => {
    mem.hash('fable2:user:scope').set('owner@x.com', JSON.stringify(['youth']));
    const actor = await resolveActor('owner@x.com');
    expect(actor.staffScope).toBeNull();
    expect(actor.owner).toBe(true);
  });
});

describe('contentScopeFor a scoped staff member', () => {
  it('is what their groups grant, not the whole library', async () => {
    mem.hash('fable2:user:scope').set('s@x.com', JSON.stringify(['youth']));
    const scope = await contentScopeFor('s@x.com', { staff: true });
    expect(scope).toEqual({ unrestricted: false, collectionIds: ['sermons'], videoIds: ['v1', 'v3'] });
  });

  it('is nothing for a scope whose groups are gone', async () => {
    mem.hash('fable2:user:scope').set('s@x.com', JSON.stringify(['gone']));
    expect((await contentScopeFor('s@x.com', { staff: true })).unrestricted).toBe(false);
  });

  it('is nothing — never everything — when the scope cannot be read', async () => {
    const real = mem.hash.bind(mem);
    vi.spyOn(mem, 'hash').mockImplementation((key) => {
      if (key === 'fable2:user:scope') throw new Error('redis down');
      return real(key);
    });
    expect(await contentScopeFor('s@x.com', { staff: true })).toEqual({ unrestricted: false, collectionIds: [], videoIds: [] });
  });

  it('is the whole library for unscoped staff and owners, as before', async () => {
    expect((await contentScopeFor('s@x.com', { staff: true })).unrestricted).toBe(true);
    mem.hash('fable2:user:scope').set('owner@x.com', JSON.stringify(['youth']));
    expect((await contentScopeFor('owner@x.com', { staff: true })).unrestricted).toBe(true);
  });
});
