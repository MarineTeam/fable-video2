// Group-scoped staff, end to end through the real route handlers.
//
// One staff member holds EVERY capability but is limited to the Youth group.
// Each test asks a route to do something outside Youth and checks that it is
// refused, and asks it to do the same inside Youth and checks that it works —
// so a refusal can never pass by the route simply being broken.
//
// The world (group content gating ON):
//   groups   youth (videos V1, V3)   deck (videos V2, V3)
//   videos   V1 youth only · V2 deck only · V3 both · V4 in no group
//   viewers  y1 [youth] · d1 [deck] · both [youth, deck] · free []
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mem } from './helpers/memoryRedis';

const V1 = 'aaaaaaaaaa01';
const V2 = 'aaaaaaaaaa02';
const V3 = 'aaaaaaaaaa03';
const V4 = 'aaaaaaaaaa04';

const state = vi.hoisted(() => ({ email: null, deleted: [], created: [], updated: [] }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({
  auth0: { getSession: async () => (state.email ? { user: { email: state.email, email_verified: true } } : null) },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));
vi.mock('../push', () => ({ announceNewVideos: async () => {}, pushEnabled: () => false, sendToAll: async () => ({}) }));
vi.mock('../transcriptCollect', () => ({ collectFinishedTranscripts: async () => ({ collected: [] }) }));
vi.mock('../bunny', () => {
  const library = () => [
    { guid: 'aaaaaaaaaa01', title: 'One', collectionId: '', status: 4, views: 5 },
    { guid: 'aaaaaaaaaa02', title: 'Two', collectionId: '', status: 4, views: 7 },
    { guid: 'aaaaaaaaaa03', title: 'Three', collectionId: '', status: 4, views: 1 },
    { guid: 'aaaaaaaaaa04', title: 'Four', collectionId: '', status: 4, views: 9 },
  ];
  return {
    listVideos: async () => ({ items: library(), totalItems: 4 }),
    getVideo: async (id) => {
      const video = library().find((v) => v.guid === id);
      if (!video) throw new Error('404');
      return video;
    },
    updateVideo: async (id, patch) => state.updated.push([id, patch]),
    deleteVideo: async (id) => state.deleted.push(id),
    createVideo: async (title) => (state.created.push(title), { guid: 'bbbbbbbbbb01' }),
    tusAuth: () => ({ endpoint: 'https://tus', headers: {} }),
    thumbnailUrl: () => null,
    listCollections: async () => ({ items: [] }),
    createCollection: async () => ({ guid: 'c1' }),
    deleteCollection: async () => {},
    getStatistics: async () => ({ viewsChart: {}, watchTimeChart: {} }),
    transcribeVideo: async () => {},
    fetchCaptionVtt: async () => null,
    isPlayable: () => true,
  };
});

const route = async (name) => (await import(`../../pages/api/admin/${name}`)).default;
const ADMIN_DIR = path.join(process.cwd(), 'pages/api/admin');

async function call(handler, { method = 'GET', query = {}, body = {} } = {}) {
  const out = { statusCode: 200, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    send(payload) {
      out.body = payload;
      return res;
    },
    end: () => res,
  };
  await handler({ method, query, body, headers: { host: 'portal.example' }, cookies: {} }, res);
  return out;
}

const ALL = [
  'analytics.read', 'audit.read', 'broadcast.send', 'comments.manage', 'groups.manage', 'roles.manage',
  'settings.manage', 'shares.manage', 'shares.read', 'videos.manage', 'videos.read', 'videos.upload',
  'viewers.manage', 'viewers.read',
];

function seed() {
  const groups = mem.hash('fable2:groups');
  groups.set('youth-1', { id: 'youth-1', name: 'Youth', collectionIds: [], videoIds: [V1, V3] });
  groups.set('deck-1', { id: 'deck-1', name: 'Deck', collectionIds: [], videoIds: [V2, V3] });
  const members = mem.hash('fable2:user:groups');
  members.set('y1@x.com', ['youth-1']);
  members.set('d1@x.com', ['deck-1']);
  members.set('both@x.com', ['deck-1', 'youth-1']);
  for (const e of ['y1@x.com', 'd1@x.com', 'both@x.com', 'free@x.com']) mem.set('fable2:viewers').add(e);
  mem.hash('fable2:roles').set('all', { id: 'all', name: 'Everything', capabilities: ALL });
  mem.hash('fable2:user:roles').set('s@x.com', ['all']);
  mem.hash('fable2:user:roles').set('u@x.com', ['all']);
  mem.hash('fable2:user:scope').set('s@x.com', JSON.stringify(['youth-1']));
}

beforeEach(() => {
  mem.reset();
  state.deleted = [];
  state.created = [];
  state.updated = [];
  process.env.ADMIN_EMAILS = 'owner@x.com';
  process.env.GROUP_CONTENT_GATING = '1';
  seed();
  state.email = 's@x.com';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('every admin route is scope-aware (static)', () => {
  // A route either gates only on portal-wide capabilities — which a scoped
  // caller never holds — or handles the scope itself. A new route that does
  // neither fails here, before it can leak.
  const GLOBAL_ONLY = ['app-icon.js', 'audit.js', 'broadcast.js', 'cleanup.js', 'rating-recount.js', 'roles.js', 'settings.js'];
  const files = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.js'));
  it.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, file), 'utf8');
    if (GLOBAL_ONLY.includes(file)) {
      const caps = [...src.matchAll(/CAP\.([A-Z_]+)/g)].map((m) => m[1]);
      expect(caps.every((c) => ['SETTINGS_MANAGE', 'ROLES_MANAGE', 'AUDIT_READ', 'BROADCAST_SEND', 'VIEWERS_MANAGE'].includes(c))).toBe(true);
      return;
    }
    expect(src, `${file} neither is portal-wide nor checks a staff scope`).toMatch(/staffScope(Rules)?'/);
  });
});

describe('portal-wide capabilities are gone under a scope', () => {
  it.each([
    ['settings', 'GET'],
    ['audit', 'GET'],
    ['roles', 'GET'],
    ['broadcast', 'POST'],
    ['cleanup', 'POST'],
    ['app-icon', 'GET'],
    ['rating-recount', 'POST'],
  ])('%s answers 403', async (name, method) => {
    expect((await call(await route(name), { method })).statusCode).toBe(403);
  });

  it('still answers the same routes for the unscoped holder of the same role', async () => {
    state.email = 'u@x.com';
    expect((await call(await route('audit'))).statusCode).toBe(200);
  });
});

describe('videos', () => {
  it('lists only the scope’s videos', async () => {
    const res = await call(await route('videos'));
    expect(res.body.videos.map((v) => v.guid).sort()).toEqual([V1, V3]);
  });

  it('edits in-scope videos and answers 404 for the rest', async () => {
    const videos = await route('videos');
    const rename = (id) => call(videos, { method: 'PUT', body: { id, title: 'New' } });
    expect((await rename(V1)).statusCode).toBe(200);
    expect((await rename(V2)).statusCode).toBe(404);
    expect((await rename(V4)).statusCode).toBe(404);
  });

  it('deletes a video only its own groups can see', async () => {
    const videos = await route('videos');
    expect((await call(videos, { method: 'DELETE', query: { id: V3 } })).statusCode).toBe(403);
    expect((await call(videos, { method: 'DELETE', query: { id: V2 } })).statusCode).toBe(404);
    expect((await call(videos, { method: 'DELETE', query: { id: V1 } })).statusCode).toBe(200);
    expect(state.deleted).toEqual([V1]);
  });

  it('holds bulk delete to the same rule, video by video', async () => {
    const res = await call(await route('videos-bulk'), { method: 'POST', body: { action: 'delete', ids: [V1, V2, V3] } });
    const ok = Object.fromEntries(res.body.results.map((r) => [r.id, r.ok]));
    expect(ok).toEqual({ [V1]: true, [V2]: false, [V3]: false });
    expect(state.deleted).toEqual([V1]);
  });

  it('refuses the library-wide acts: collections, the homepage order, public links', async () => {
    expect((await call(await route('videos'), { method: 'PUT', body: { id: V1, collectionId: 'c' } })).statusCode).toBe(403);
    expect(
      (await call(await route('videos-bulk'), { method: 'POST', body: { action: 'assign-collection', ids: [V1], collectionId: 'c' } }))
        .statusCode
    ).toBe(403);
    expect((await call(await route('order'), { method: 'POST', body: { order: [V1] } })).statusCode).toBe(403);
    expect((await call(await route('collections'), { method: 'POST', body: { name: 'X' } })).statusCode).toBe(403);
    expect((await call(await route('public-video'), { method: 'POST', body: { guid: V1, isPublic: true } })).statusCode).toBe(403);
    expect(state.updated).toEqual([]);
  });

  it('edits chapters, notes and transcripts of in-scope videos only', async () => {
    for (const [name, body] of [
      ['chapters', { text: '0:00 Start' }],
      ['notes', { notes: 'hello' }],
      ['transcribe', {}],
    ]) {
      const handler = await route(name);
      expect((await call(handler, { method: 'POST', body: { ...body, guid: V2 } })).statusCode, name).toBe(404);
      expect((await call(handler, { method: 'POST', body: { ...body, guid: V1 } })).statusCode, name).toBe(200);
    }
  });

  it('sets per-group windows for its own groups only', async () => {
    const schedule = await route('schedule');
    const window = { from: '2026-10-01T00:00:00.000Z' };
    const set = (groups) => call(schedule, { method: 'POST', body: { guid: V1, groups } });
    expect((await set({ 'youth-1': window })).statusCode).toBe(200);
    expect((await set({ 'youth-1': window, 'deck-1': window })).statusCode).toBe(403);
  });
});

describe('uploads', () => {
  it('grants a new upload to the caller’s groups, whether or not they chose', async () => {
    const res = await call(await route('upload'), { method: 'POST', body: { title: 'Talk' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.groups.granted).toEqual(['youth-1']);
  });

  it('refuses another group, or a collection, before the video exists', async () => {
    const upload = await route('upload');
    expect((await call(upload, { method: 'POST', body: { title: 'T', groupIds: ['deck-1'] } })).statusCode).toBe(403);
    expect((await call(upload, { method: 'POST', body: { title: 'T', collectionId: 'c' } })).statusCode).toBe(403);
    expect(state.created).toEqual([]);
  });
});

describe('viewers', () => {
  it('lists only the scope’s people', async () => {
    const res = await call(await route('viewers'));
    expect(res.body.viewers.map((v) => v.email).sort()).toEqual(['both@x.com', 'y1@x.com']);
  });

  it('approves new people into their group, membership first', async () => {
    const res = await call(await route('viewers'), { method: 'POST', body: { emails: 'new@x.com' } });
    expect(res.body.added).toBe(1);
    expect(mem.hash('fable2:user:groups').get('new@x.com')).toEqual(['youth-1']);
    expect(mem.set('fable2:viewers').has('new@x.com')).toBe(true);
  });

  it('refuses to approve into a group that is not theirs, writing nothing', async () => {
    const res = await call(await route('viewers'), { method: 'POST', body: { emails: 'new@x.com', groupIds: ['deck-1'] } });
    expect(res.statusCode).toBe(400);
    expect(mem.set('fable2:viewers').has('new@x.com')).toBe(false);
    expect(mem.hash('fable2:user:groups').has('new@x.com')).toBe(false);
  });

  it('leaves someone who is already a viewer as they are', async () => {
    await call(await route('viewers'), { method: 'POST', body: { emails: 'free@x.com' } });
    expect(mem.hash('fable2:user:groups').has('free@x.com')).toBe(false);
  });

  it('removes only someone wholly inside the scope', async () => {
    const viewers = await route('viewers');
    const del = (email) => call(viewers, { method: 'DELETE', body: { email } });
    expect((await del('both@x.com')).statusCode).toBe(403);
    expect((await del('free@x.com')).statusCode).toBe(404);
    expect((await del('y1@x.com')).statusCode).toBe(200);
  });

  it('labels only their own people', async () => {
    const bulk = await route('viewers-bulk');
    const tag = (emails) => call(bulk, { method: 'POST', body: { action: 'add-tag', emails, tag: 'x' } });
    expect((await tag(['d1@x.com'])).statusCode).toBe(404);
    expect((await tag(['y1@x.com'])).statusCode).toBe(200);
  });

  it('approves an access request into their group', async () => {
    const res = await call(await route('access-requests'), { method: 'POST', body: { email: 'asker@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(mem.hash('fable2:user:groups').get('asker@x.com')).toEqual(['youth-1']);
    expect(mem.set('fable2:viewers').has('asker@x.com')).toBe(true);
  });
});

describe('groups', () => {
  it('shows only their groups, and their people’s memberships in them', async () => {
    const res = await call(await route('groups'));
    expect(res.body.groups.map((g) => g.id)).toEqual(['youth-1']);
    expect(res.body.canEditGroups).toBe(false);
    expect(res.body.memberships).toEqual({ 'both@x.com': ['youth-1'], 'y1@x.com': ['youth-1'] });
  });

  it('refuses to create, re-scope or delete a group, or change default access', async () => {
    const groups = await route('groups');
    expect((await call(groups, { method: 'POST', body: { name: 'New' } })).statusCode).toBe(403);
    expect((await call(groups, { method: 'PUT', body: { id: 'youth-1', name: 'Youth', videoIds: [V2] } })).statusCode).toBe(403);
    expect((await call(groups, { method: 'DELETE', query: { id: 'youth-1' } })).statusCode).toBe(403);
    expect(
      (await call(groups, { method: 'PATCH', body: { action: 'set-default-access', defaultAccess: 'open' } })).statusCode
    ).toBe(403);
    expect(mem.hash('fable2:groups').get('youth-1').videoIds).toEqual([V1, V3]);
  });

  it('adds only people already in scope, and keeps someone whose last group this is', async () => {
    const res = await call(await route('groups'), {
      method: 'PATCH',
      body: { action: 'set-members', groupId: 'youth-1', emails: ['d1@x.com', 'free@x.com'] },
    });
    expect(res.body.unknown).toEqual(['d1@x.com', 'free@x.com']);
    expect(res.body.refused).toEqual(['y1@x.com']);
    const members = mem.hash('fable2:user:groups');
    expect(members.get('y1@x.com')).toEqual(['youth-1']);
    expect(members.get('both@x.com')).toEqual(['deck-1']);
    expect(members.has('free@x.com')).toBe(false);
  });

  it('changes a person’s groups only within their own, never to none', async () => {
    const groups = await route('groups');
    const set = (email, groupIds) => call(groups, { method: 'PATCH', body: { action: 'set-groups', email, groupIds } });
    expect((await set('y1@x.com', [])).statusCode).toBe(403);
    expect((await set('both@x.com', ['youth-1'])).statusCode).toBe(403);
    expect((await set('d1@x.com', ['deck-1', 'youth-1'])).statusCode).toBe(404);
  });

  it('answers 404 for someone else’s group', async () => {
    const res = await call(await route('groups'), {
      method: 'PATCH',
      body: { action: 'set-members', groupId: 'deck-1', emails: [] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('shares and analytics', () => {
  it('shares in-scope videos only', async () => {
    const share = await route('share');
    const make = (videoId) => call(share, { method: 'POST', body: { videoId, emails: ['g@x.com'], sendEmail: false } });
    expect((await make(V2)).statusCode).toBe(404);
    expect((await make(V1)).statusCode).toBe(200);
    const bulk = await route('bulk-share');
    expect((await call(bulk, { method: 'POST', body: { videoIds: [V1, V2], emails: ['g@x.com'], sendEmail: false } })).statusCode).toBe(404);
  });

  it('lists and revokes only links to in-scope videos', async () => {
    const link = (id, videoId) => {
      mem.strings.set(`fable2:share:${id}`, { videoId, email: 'g@x.com', createdAt: '2026-01-01', expiresAt: '2099-01-01' });
      mem.set('fable2:shares').add(id);
    };
    link('s1', V1);
    link('s2', V2);
    const shares = await route('shares');
    expect((await call(shares)).body.shares.map((s) => s.videoId)).toEqual([V1]);
    expect((await call(shares, { method: 'DELETE', query: { id: 's2' } })).statusCode).toBe(404);
    expect(mem.strings.get('fable2:share:s2').revoked).toBeUndefined();
    const bulk = await route('shares-bulk');
    expect((await call(bulk, { method: 'POST', body: { action: 'revoke', ids: ['s1', 's2'] } })).statusCode).toBe(404);
  });

  it('keeps private lists to in-scope videos', async () => {
    const list = await route('private-list');
    expect((await call(list, { query: { videoId: V2 } })).statusCode).toBe(404);
  });

  it('counts only in-scope videos, and leaves out the library-wide figures', async () => {
    const res = await call(await route('analytics'));
    expect(res.body.videoCount).toBe(2);
    expect(res.body.totalViews).toBe(6);
    expect(res.body.libraryWide).toBe(false);
  });

  it('reads another viewer’s activity only for the scope’s people', async () => {
    const activity = await route('viewer-activity');
    expect((await call(activity, { query: { email: 'd1@x.com' } })).statusCode).toBe(404);
    expect((await call(activity, { query: { email: 'y1@x.com' } })).statusCode).toBe(200);
  });
});

describe('the scope itself', () => {
  let roles;
  const assign = (body) => call(roles, { method: 'PATCH', body });
  beforeEach(async () => {
    roles = await route('roles');
    state.email = 'owner@x.com';
  });

  it('is set and lifted through the Roles route, by an owner', async () => {
    expect((await assign({ email: 'u@x.com', roleIds: ['all'], scope: ['deck-1'] })).statusCode).toBe(200);
    expect(JSON.parse(mem.hash('fable2:user:scope').get('u@x.com'))).toEqual(['deck-1']);
    expect((await assign({ email: 'u@x.com', roleIds: ['all'], scope: null })).statusCode).toBe(200);
    expect(mem.hash('fable2:user:scope').has('u@x.com')).toBe(false);
  });

  it('needs group gating, names real groups, and never limits an owner', async () => {
    expect((await assign({ email: 'u@x.com', roleIds: ['all'], scope: ['nope-1'] })).statusCode).toBe(400);
    expect((await assign({ email: 'owner@x.com', roleIds: [], scope: ['deck-1'] })).statusCode).toBe(400);
    process.env.GROUP_CONTENT_GATING = '';
    expect((await assign({ email: 'u@x.com', roleIds: ['all'], scope: ['deck-1'] })).statusCode).toBe(400);
  });

  it('goes with the last role', async () => {
    await assign({ email: 's@x.com', roleIds: [] });
    expect(mem.hash('fable2:user:scope').has('s@x.com')).toBe(false);
  });

  it('is out of reach of the scoped person themselves', async () => {
    state.email = 's@x.com';
    expect((await assign({ email: 's@x.com', roleIds: ['all'], scope: null })).statusCode).toBe(403);
  });
});
