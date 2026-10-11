// pages/api/admin/upload.js — choosing groups at upload time.
//
// videos.upload and groups.manage are separate capabilities, so an uploader
// without groups.manage must not gain it by ticking a box. requireCapability
// returns only an EMAIL in this repo, so the route resolves the actor itself
// — and an OWNER holds everything, which the second test pins (a check that
// only looked at capabilities would refuse the owner, who has none listed).
import { beforeEach, describe, expect, it, vi } from 'vitest';

let actor = null;
let groupsById = {};
let groupsThrow = false;
let created = [];
let audit = [];
let grant = null;

vi.mock('../guard', () => ({
  requireCapability: async () => 'uploader@example.com',
  resolveActor: async () => actor,
  requireActor: async () => ({ ...actor, email: 'uploader@example.com', staffScope: null }),
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../bunny', () => ({
  createVideo: async (title) => {
    created.push(title);
    return { guid: 'vid-new' };
  },
  tusAuth: () => ({ endpoint: 'https://tus', headers: { sig: 1 } }),
}));
vi.mock('../audit', () => ({ logAction: async (...a) => audit.push(a) }));
vi.mock('../groups', () => ({
  MAX_SCOPE_ENTRIES: 500,
  loadGroups: async () => {
    if (groupsThrow) throw new Error('redis down');
    return groupsById;
  },
  grantVideoToGroups: (...a) => grant(...a),
}));

const route = (await import('../../pages/api/admin/upload')).default;
const { CAP } = await import('../capabilities');

async function post(body) {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => res;
  res.end = () => res;
  await route({ method: 'POST', body, query: {}, headers: {} }, res);
  return res;
}

beforeEach(() => {
  actor = { email: 'uploader@example.com', owner: false, capabilities: [CAP.VIDEOS_UPLOAD, CAP.GROUPS_MANAGE] };
  groupsById = { 'team-aaaaaa': { id: 'team-aaaaaa', name: 'Team', videoIds: [] } };
  groupsThrow = false;
  created = [];
  audit = [];
  grant = vi.fn(async (_id, ids) => ({ granted: ids, failed: [] }));
});

describe('upload with groups', () => {
  it('grants the new video to the chosen groups and records it', async () => {
    const res = await post({ title: 'Sunday', groupIds: ['team-aaaaaa'] });
    expect(res.statusCode).toBe(200);
    expect(grant).toHaveBeenCalledWith('vid-new', ['team-aaaaaa']);
    expect(res.body.groups).toEqual({ granted: ['team-aaaaaa'], failed: [] });
    expect(audit.some(([who, action]) => who === 'uploader@example.com' && action === 'group.grant')).toBe(true);
  });

  it('lets an OWNER grant, though no capability is listed for them', async () => {
    actor = { email: 'owner@example.com', owner: true, capabilities: [] };
    expect((await post({ title: 'Sunday', groupIds: ['team-aaaaaa'] })).statusCode).toBe(200);
  });

  it('refuses an uploader WITHOUT groups.manage, before creating the video', async () => {
    actor = { email: 'u@example.com', owner: false, capabilities: [CAP.VIDEOS_UPLOAD] };
    const res = await post({ title: 'Sunday', groupIds: ['team-aaaaaa'] });
    expect(res.statusCode).toBe(403);
    expect(created).toEqual([]);
  });

  it('refuses an unknown group before creating the video', async () => {
    const res = await post({ title: 'Sunday', groupIds: ['gone-zzzzzz'] });
    expect(res.statusCode).toBe(400);
    expect(created).toEqual([]);
  });

  it('502s without creating the video when groups cannot be read', async () => {
    groupsThrow = true;
    const res = await post({ title: 'Sunday', groupIds: ['team-aaaaaa'] });
    expect(res.statusCode).toBe(502);
    expect(created).toEqual([]);
  });

  it('still starts the upload when a grant fails afterwards, and says which', async () => {
    grant = vi.fn(async () => ({ granted: [], failed: ['team-aaaaaa'] }));
    const res = await post({ title: 'Sunday', groupIds: ['team-aaaaaa'] });
    expect(res.statusCode).toBe(200);
    expect(res.body.endpoint).toBe('https://tus');
    expect(res.body.groups.failed).toEqual(['team-aaaaaa']);
  });
});

describe('upload with no groups', () => {
  it('is the request it always was — no actor lookup, no group read', async () => {
    groupsThrow = true;
    actor = null;
    const res = await post({ title: 'Sunday' });
    expect(res.statusCode).toBe(200);
    expect(created).toEqual(['Sunday']);
    expect(grant).not.toHaveBeenCalled();
  });
});
