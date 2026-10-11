// Removing a viewer deletes what was recorded about them (lib/viewerData.js),
// through the real route: their votes come back out of the totals, their
// progress and saved list go, and so do their comments on every video —
// nobody else's. The data goes BEFORE their access, so a failure leaves them
// listed and the removal can simply be tried again.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mem } from './helpers/memoryRedis';

const state = vi.hoisted(() => ({ email: 'owner@x.com' }));

vi.mock('../redis', async () => (await import('./helpers/memoryRedis')).redisModule);
vi.mock('../auth0', () => ({
  auth0: { getSession: async () => (state.email ? { user: { email: state.email, email_verified: true } } : null) },
}));
vi.mock('../ratelimit', () => ({ allowRequest: async () => true }));
vi.mock('../geo', () => ({ isGeoAllowed: async () => true }));

const route = (await import('../../pages/api/admin/viewers')).default;

async function remove(email) {
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
  await route({ method: 'DELETE', query: {}, body: { email }, headers: { host: 'portal.example' }, cookies: {} }, res);
  return out;
}

const comment = (videoId, id, email) =>
  mem.hash(`fable2:comments:${videoId}`).set(id, { id, email, name: 'N', text: 'hi', at: 1 });
const counts = () => Object.fromEntries(mem.hash('fable2:rating_counts'));

function seed(email) {
  mem.set('fable2:viewers').add(email);
  mem.hash(`fable2:progress:${email}`).set('v1', { seconds: 30 });
  mem.hash(`fable2:mylist:${email}`).set('v1', 1);
  mem.hash(`fable2:ratings:${email}`).set('v1', 'up');
  mem.hash(`fable2:ratings:${email}`).set('v2', 'down');
}

beforeEach(() => {
  mem.reset();
  process.env.ADMIN_EMAILS = 'owner@x.com';
  state.email = 'owner@x.com';
  seed('gone@x.com');
  seed('stays@x.com');
  mem.hash('fable2:rating_counts').set('v1:up', 2);
  mem.hash('fable2:rating_counts').set('v2:down', 2);
  comment('v1', 'caaaaaaa1', 'gone@x.com');
  comment('v1', 'caaaaaaa2', 'stays@x.com');
  comment('v2', 'caaaaaaa3', 'Gone@X.com');
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('removing a viewer', () => {
  it('deletes their votes from the totals, their progress, saved list and comments', async () => {
    const res = await remove('gone@x.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toEqual({ votes: 2, comments: 2 });
    expect(counts()).toEqual({ 'v1:up': 1, 'v2:down': 1 });
    for (const family of ['progress', 'mylist', 'ratings']) {
      expect(mem.hashes.has(`fable2:${family}:gone@x.com`), family).toBe(false);
    }
    expect([...mem.hash('fable2:comments:v1').keys()]).toEqual(['caaaaaaa2']);
    expect(mem.hash('fable2:comments:v2').size).toBe(0);
    expect(mem.set('fable2:viewers').has('gone@x.com')).toBe(false);
  });

  it('leaves everyone else’s data alone', async () => {
    await remove('gone@x.com');
    expect(mem.hash('fable2:progress:stays@x.com').size).toBe(1);
    expect(mem.hash('fable2:mylist:stays@x.com').size).toBe(1);
    expect(mem.hash('fable2:ratings:stays@x.com').size).toBe(2);
  });

  it('keeps them listed when their data cannot be deleted, so it can be retried', async () => {
    const realHash = mem.hash.bind(mem);
    vi.spyOn(mem, 'hash').mockImplementation((key) => {
      if (key.startsWith('fable2:comments:')) throw new Error('redis down');
      return realHash(key);
    });
    const res = await remove('gone@x.com');
    expect(res.statusCode).toBe(500);
    vi.restoreAllMocks();
    expect(mem.set('fable2:viewers').has('gone@x.com')).toBe(true);
    expect((await remove('gone@x.com')).statusCode).toBe(200);
    expect(mem.hash('fable2:comments:v1').has('caaaaaaa1')).toBe(false);
  });

  it('never deletes an owner’s data, since removing them does not remove their access', async () => {
    state.email = 'u@x.com';
    mem.hash('fable2:roles').set('people', { id: 'people', name: 'People', capabilities: ['viewers.manage', 'viewers.read'] });
    mem.hash('fable2:user:roles').set('u@x.com', ['people']);
    seed('owner@x.com');
    const res = await remove('owner@x.com');
    expect(res.statusCode).toBe(200);
    expect(res.body.forgotten).toBeNull();
    expect(mem.hash('fable2:progress:owner@x.com').size).toBe(1);
  });
});
