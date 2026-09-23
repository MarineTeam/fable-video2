// pages/api/admin/rating-recount.js — who may run it, and what it answers.
//
// The recount itself (the Lua) is proved against a real redis-server in
// ratingScripts.test.js. What this pins is the route around it: it rewrites
// stored data, so it must be behind SETTINGS_MANAGE, POST-only, audited, and
// it must answer with counts and never with anything identifying a voter.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let access = null;
let askedFor = null;
let recountThrows = false;
const logAction = vi.fn(async () => {});
const recountRatings = vi.fn(async () => {
  if (recountThrows) throw new Error('redis down at fable2:ratings:someone@example.com');
  return { viewers: 3, votes: 5, fields: 4 };
});

vi.mock('../guard', () => ({
  requireCapability: async (req, res, cap) => {
    askedFor = cap;
    if (!access) {
      res.status(403).json({ error: 'Forbidden' });
      return null;
    }
    return access.email;
  },
}));
vi.mock('../ratingsStore', () => ({ recountRatings: (...a) => recountRatings(...a) }));
vi.mock('../audit', () => ({ logAction: (...a) => logAction(...a) }));

const route = (await import('../../pages/api/admin/rating-recount')).default;

async function callRoute(handler, { method = 'GET' } = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
      return res;
    },
    end() {
      res.headersSent = true;
      return res;
    },
  };
  await handler({ method, body: {}, query: {}, headers: {}, url: '/' }, res);
  return res;
}
const { CAP } = await import('../capabilities');

beforeEach(() => {
  access = { email: 'admin@example.com' };
  askedFor = null;
  recountThrows = false;
  logAction.mockClear();
  recountRatings.mockClear();
});

describe('rating recount route', () => {
  it('requires SETTINGS_MANAGE and runs nothing without it', async () => {
    access = null;
    const res = await callRoute(route, { method: 'POST' });
    expect(askedFor).toBe(CAP.SETTINGS_MANAGE);
    expect(res.statusCode).toBe(403);
    expect(recountRatings).not.toHaveBeenCalled();
  });

  it('is POST only', async () => {
    const res = await callRoute(route, { method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(recountRatings).not.toHaveBeenCalled();
  });

  it('answers with counts, and records who ran it', async () => {
    const res = await callRoute(route, { method: 'POST' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ viewers: 3, votes: 5, fields: 4 });
    expect(logAction).toHaveBeenCalledWith(
      'admin@example.com',
      'ratings.recount',
      expect.stringContaining('5 vote(s)')
    );
  });

  it('502s on failure without echoing the error, which can name a voter\'s key', async () => {
    recountThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await callRoute(route, { method: 'POST' });
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('someone@example.com');
    expect(logAction).not.toHaveBeenCalled();
  });
});
