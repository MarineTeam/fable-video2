// Group membership: the whole-list plan, and the capability that guards it.
//
// Two things here were wrong before this suite existed, and both were silent.
// A member list could contain an address that is not an approved viewer —
// setMembersOfGroup wrote the row anyway, so the group looked right and the
// person had no account. And every group's member addresses, plus the whole
// email -> [groupId] map, went to any holder of groups.manage: the approved
// viewer list, from a capability whose label only promises groups.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planMemberList } from '../groups';
import { CAP } from '../capabilities';

describe('planMemberList', () => {
  const approved = new Set(['a@x.com', 'b@x.com', 'c@x.com']);

  it('reports who joined and who left', () => {
    const plan = planMemberList({
      current: ['a@x.com', 'b@x.com'],
      wanted: ['b@x.com', 'c@x.com'],
      approved,
    });
    expect(plan.members).toEqual(['b@x.com', 'c@x.com']);
    expect(plan.added).toEqual(['c@x.com']);
    expect(plan.removed).toEqual(['a@x.com']);
  });

  it('REFUSES an address that is not an approved viewer, and says so', () => {
    // lib/viewerTags.js has always refused to tag a non-viewer. Membership is
    // the same claim about the same person, and writing it anyway leaves a
    // group row for somebody with no account — which nothing cleans, and
    // which becomes real the day that address is approved.
    const plan = planMemberList({ current: [], wanted: ['ghost@x.com'], approved });
    expect(plan.members).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.unknown).toEqual(['ghost@x.com']);
  });

  it('keeps an existing member who is no longer approved, rather than dropping them', () => {
    // Removing somebody is an explicit act. Saving an unrelated scope edit
    // must not quietly evict a member because their approval lapsed.
    const plan = planMemberList({
      current: ['lapsed@x.com'],
      wanted: ['lapsed@x.com'],
      approved,
    });
    expect(plan.members).toEqual(['lapsed@x.com']);
    expect(plan.removed).toEqual([]);
    expect(plan.unknown).toEqual([]);
  });

  it('still removes an unapproved member when they are left OUT of the list', () => {
    const plan = planMemberList({ current: ['lapsed@x.com'], wanted: [], approved });
    expect(plan.removed).toEqual(['lapsed@x.com']);
  });

  it('reports an unusable address separately from an unapproved one', () => {
    const plan = planMemberList({ current: [], wanted: ['not an email', ''], approved });
    expect(plan.invalid).toEqual(['not an email']);
    expect(plan.unknown).toEqual([]);
  });

  it('normalizes, dedupes and sorts', () => {
    const plan = planMemberList({
      current: [],
      wanted: [' B@X.com ', 'b@x.com', 'a@x.com'],
      approved,
    });
    expect(plan.members).toEqual(['a@x.com', 'b@x.com']);
  });

  it('checks nothing when the approved set could not be read', () => {
    // A Redis blip must not empty a group. No set means "could not check",
    // which fails toward today's behaviour.
    const plan = planMemberList({ current: [], wanted: ['ghost@x.com'], approved: null });
    expect(plan.members).toEqual(['ghost@x.com']);
    expect(plan.unknown).toEqual([]);
  });

  it('handles junk input without throwing', () => {
    expect(planMemberList()).toEqual({
      members: [],
      added: [],
      removed: [],
      unknown: [],
      invalid: [],
    });
    expect(planMemberList({ current: 'nope', wanted: null }).members).toEqual([]);
  });
});

// --- the route's capability split ------------------------------------------

let caps = [CAP.GROUPS_MANAGE, CAP.VIEWERS_READ];
let memberships = {};
let groupRecords = {};
let owner = false;

vi.mock('../guard', () => ({
  // requireCapability answers with the EMAIL, exactly as the real one does —
  // a mock that returned a resolved actor instead would hide the fact that
  // the route has to resolve the capabilities itself.
  requireCapability: async (req, res, capability) => {
    if (!caps.includes(capability)) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return 'admin@example.com';
  },
  resolveActor: async (email) => ({ email, owner, capabilities: caps, staff: true }),
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../audit', () => ({ logAction: async () => {} }));
vi.mock('../redis', () => ({
  k: (name) => `fable2:${name}`,
  redis: () => ({
    // Key-aware: the route reads the registry and the membership map from
    // two different hashes, and a mock that answers both with the same object
    // silently produces a library with no groups in it.
    hgetall: async (key) => (key === 'fable2:groups' ? groupRecords : memberships),
    hget: async () => null,
    // Writes back, so a test can assert what a prune or a save actually
    // stored. A no-op here would make any such assertion unfalsifiable.
    hset: async (key, payload) => {
      Object.assign(groupRecords, payload);
      return 1;
    },
    hdel: async () => 1,
    get: async () => null,
    set: async () => 'OK',
    smembers: async () => ['a@x.com', 'b@x.com'],
  }),
}));

const route = (await import('../../pages/api/admin/groups')).default;

async function call({ method = 'GET', body = {}, query = {} } = {}) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader: () => res,
    end() {
      res.headersSent = true;
      return res;
    },
    headersSent: false,
  };
  await route({ method, body, query, headers: {}, url: '/' }, res);
  return out;
}

beforeEach(() => {
  caps = [CAP.GROUPS_MANAGE, CAP.VIEWERS_READ];
  owner = false;
  memberships = { 'a@x.com': ['g1'] };
  groupRecords = { g1: { name: 'Crew', collectionIds: [], videoIds: [] } };
});

describe('who sees the people in a group', () => {
  it('gives addresses to a caller holding viewers.read', async () => {
    const res = await call({ method: 'GET' });
    expect(res.body.groups[0].members).toEqual(['a@x.com']);
    expect(res.body.memberships).toBeDefined();
    expect(res.body.canEditMembers).toBe(true);
  });

  it('gives an OWNER the addresses, whatever their capability list says', async () => {
    // Owners hold the whole catalog by definition. Reading only the stored
    // capability list would lock them out of a member list they are entitled
    // to — the same check requireCapability itself makes.
    caps = [CAP.GROUPS_MANAGE];
    owner = true;
    const res = await call({ method: 'GET' });
    expect(res.body.groups[0].members).toEqual(['a@x.com']);
    expect(res.body.canEditMembers).toBe(true);
  });

  it('gives a groups-only manager the COUNT and no addresses', async () => {
    caps = [CAP.GROUPS_MANAGE];
    const res = await call({ method: 'GET' });
    expect(res.statusCode).toBe(200);
    expect(res.body.groups[0].memberCount).toBe(1);
    expect(res.body.groups[0].members).toBeUndefined();
    // The email -> [groupId] map is the viewer list by another name.
    expect(res.body.memberships).toBeUndefined();
    expect(res.body.canEditMembers).toBe(false);
  });
});

describe('who may change the people in a group', () => {
  it('refuses set-members from a groups-only manager', async () => {
    caps = [CAP.GROUPS_MANAGE];
    const res = await call({
      method: 'PATCH',
      body: { action: 'set-members', groupId: 'g1', emails: ['b@x.com'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses set-groups from a groups-only manager', async () => {
    // The per-user direction names a person just as plainly.
    caps = [CAP.GROUPS_MANAGE];
    const res = await call({
      method: 'PATCH',
      body: { action: 'set-groups', email: 'b@x.com', groupIds: ['g1'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('still lets a groups-only manager set the default access', async () => {
    // Not people data — a groups-only manager keeps every power except
    // naming and changing who is in a group.
    caps = [CAP.GROUPS_MANAGE];
    const res = await call({
      method: 'PATCH',
      body: { action: 'set-default-access', defaultAccess: 'closed' },
    });
    expect(res.statusCode).toBe(200);
  });
});

// --- Collection grants must not outlive the collection ---------------------

describe('pruneCollectionFromGroups', () => {
  // A group scoped to a deleted collection keeps granting it: clutter an
  // admin has to reason around, and a grant a recycled id would inherit. The
  // video half of this has always been handled; the collection half was not.
  it('drops the collection from every group that granted it', async () => {
    const { pruneCollectionFromGroups } = await import('../groups');
    groupRecords = {
      g1: { name: 'Crew', collectionIds: ['c1', 'c2'], videoIds: ['v1'] },
      g2: { name: 'Deck', collectionIds: ['c2'], videoIds: [] },
      g3: { name: 'Galley', collectionIds: [], videoIds: [] },
    };
    expect(await pruneCollectionFromGroups('c2')).toBe(2);
    expect(groupRecords.g1.collectionIds).toEqual(['c1']);
    expect(groupRecords.g2.collectionIds).toEqual([]);
    // Video grants and the rest of the record are untouched.
    expect(groupRecords.g1.videoIds).toEqual(['v1']);
  });

  it('does nothing for an unknown or empty id', async () => {
    const { pruneCollectionFromGroups } = await import('../groups');
    groupRecords = { g1: { name: 'Crew', collectionIds: ['c1'], videoIds: [] } };
    expect(await pruneCollectionFromGroups('nope')).toBe(0);
    expect(await pruneCollectionFromGroups('')).toBe(0);
    expect(groupRecords.g1.collectionIds).toEqual(['c1']);
  });
});
