import { describe, it, expect, vi, beforeEach } from 'vitest';

// The two acceptance criteria for access-request notification:
//   1. a re-ask while one is already pending must NOT notify, or a refresh
//      loop becomes a notification flood;
//   2. the request must still succeed when notification throws — the
//      requester's ask is the product, the notification is a convenience.
//
// Mocked at the module boundary: no network, no Redis. The route handler
// itself is exercised, so this tests the real wiring rather than a
// reimplementation of it.

const notifySpy = vi.fn(async () => ({ notified: 1 }));
const recordSpy = vi.fn(async () => ({ ok: true, duplicate: false }));

vi.mock('../accessRequestNotify', () => ({
  notifyNewAccessRequest: (...args) => notifySpy(...args),
}));
vi.mock('../accessRequests', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordAccessRequest: (...args) => recordSpy(...args),
  };
});
vi.mock('../auth0', () => ({
  auth0: {
    getSession: vi.fn(async () => ({ user: { email: 'asker@example.com', email_verified: true } })),
  },
}));
// Unapproved: the whole point of this route is that it is reachable by someone
// who does not yet have access.
vi.mock('../guard', () => ({
  viewerAccessFor: vi.fn(async () => ({ approved: false, owner: false, staff: false, capabilities: [] })),
}));
vi.mock('../ratelimit', () => ({ allowRequest: vi.fn(async () => true) }));
vi.mock('../audit', () => ({ logAction: vi.fn(async () => {}) }));

function makeRes() {
  const out = { statusCode: null, body: undefined };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    json(payload) {
      if (out.statusCode === null) out.statusCode = 200;
      out.body = payload;
      return res;
    },
    setHeader: () => res,
    _out: out,
  };
  return res;
}

async function post(body = {}) {
  const mod = await import('../../pages/api/request-access');
  const res = makeRes();
  await mod.default({ method: 'POST', body, query: {}, headers: {}, cookies: {} }, res);
  return res._out;
}

beforeEach(() => {
  notifySpy.mockClear();
  recordSpy.mockClear();
  recordSpy.mockImplementation(async () => ({ ok: true, duplicate: false }));
  notifySpy.mockImplementation(async () => ({ notified: 1 }));
});

describe('access-request notification', () => {
  it('notifies once on a genuinely new request', async () => {
    const out = await post({ note: 'I am new here' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ok: true, duplicate: false });
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy).toHaveBeenCalledWith({ email: 'asker@example.com', note: 'I am new here' });
  });

  // Criterion 1.
  it('does not notify when the same person re-asks while pending', async () => {
    recordSpy.mockImplementation(async () => ({ ok: true, duplicate: true }));
    const out = await post({ note: 'asking again' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ok: true, duplicate: true });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  // Criterion 2, both shapes of failure: a rejected promise...
  it('still succeeds when the notifier rejects', async () => {
    notifySpy.mockImplementation(async () => {
      throw new Error('resend is down');
    });
    const out = await post({ note: 'let me in' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ok: true });
  });

  // ...and one that throws synchronously before returning a promise at all.
  it('still succeeds when the notifier throws synchronously', async () => {
    notifySpy.mockImplementation(() => {
      throw new Error('exploded on call');
    });
    const out = await post({ note: 'let me in' });
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({ ok: true });
  });
});
