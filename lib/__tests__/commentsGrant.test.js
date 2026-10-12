// The one-time grant of comment moderation to every role that can manage
// viewers (lib/commentsGrant.js, owner decision 2026-10-11).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

const state = vi.hoisted(() => ({ email: 'owner@x.com' }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({
  auth0: { getSession: async () => (state.email ? { user: { email: state.email, email_verified: true } } : null) },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));

const { grantCommentModeration, rolesNeedingCommentModeration } = await import('../commentsGrant');
const { CAP } = await import('../capabilities');

const roles = () => mem.hash('fable2:roles');
const capsOf = (id) => roles().get(id).capabilities;

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
    end: () => res,
  };
  await handler({ method, query, body, headers: { host: 'portal.example' }, cookies: {} }, res);
  return out;
}

beforeEach(() => {
  mem.reset();
  vi.restoreAllMocks();
  process.env.ADMIN_EMAILS = 'owner@x.com';
  state.email = 'owner@x.com';
  roles().set('people', {
    id: 'people',
    name: 'People',
    capabilities: [CAP.VIEWERS_MANAGE, CAP.VIEWERS_READ],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  roles().set('media', { id: 'media', name: 'Media', capabilities: [CAP.VIDEOS_MANAGE] });
  roles().set('mods', { id: 'mods', name: 'Mods', capabilities: [CAP.VIEWERS_MANAGE, CAP.COMMENTS_MANAGE] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('grantCommentModeration', () => {
  it('gives comment moderation to exactly the roles that can manage viewers and lack it', async () => {
    expect(await grantCommentModeration()).toEqual(['People']);
    expect(capsOf('people')).toContain(CAP.COMMENTS_MANAGE);
    expect(capsOf('media')).not.toContain(CAP.COMMENTS_MANAGE);
    expect(capsOf('mods')).toEqual([CAP.VIEWERS_MANAGE, CAP.COMMENTS_MANAGE]);
    expect(roles().get('people').createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('runs once, so taking the capability back off a role sticks', async () => {
    await grantCommentModeration();
    roles().set('people', { id: 'people', name: 'People', capabilities: [CAP.VIEWERS_MANAGE] });
    expect(await grantCommentModeration()).toEqual([]);
    expect(capsOf('people')).not.toContain(CAP.COMMENTS_MANAGE);
  });

  it('does not record itself as done when it fails, so the next visit retries', async () => {
    // The read works and the role save fails — the marker must not be written.
    const set = vi.spyOn(roles(), 'set').mockImplementation(() => {
      throw new Error('redis down');
    });
    await expect(grantCommentModeration()).rejects.toThrow();
    set.mockRestore();
    expect(await grantCommentModeration()).toEqual(['People']);
  });

  it('reads which roles need it without writing anything', () => {
    const byId = Object.fromEntries(roles());
    expect(rolesNeedingCommentModeration(byId).map((r) => r.id)).toEqual(['people']);
    expect(rolesNeedingCommentModeration(null)).toEqual([]);
  });
});

describe('through the Roles tab', () => {
  it('runs when the tab loads, and logs it', async () => {
    const route = (await import('../../pages/api/admin/roles')).default;
    const res = await call(route);
    expect(res.statusCode).toBe(200);
    expect(capsOf('people')).toContain(CAP.COMMENTS_MANAGE);
    const audit = mem.list('fable2:audit').map((e) => (typeof e === 'string' ? JSON.parse(e) : e));
    expect(audit.some((e) => e.action === 'role.update' && /comments\.manage granted to .*People/.test(e.detail))).toBe(
      true
    );
  });
});
