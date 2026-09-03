import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deny-by-default, proven in CI instead of only by the runtime smoke-probe.
//
// The strongest invariant this app has is that an anonymous caller gets
// nothing from a guarded route. Until now that was checked only against a live
// deployment, so a deleted guard could reach main with CI fully green.
//
// Design note — why this suite never names which HTTP method a route accepts:
// a hand-maintained route→method table is exactly the kind of thing that drifts
// out of date and quietly stops testing anything. Instead every route is called
// with every method, and the assertion is that an anonymous caller can only
// ever be refused: 401 (not signed in), 403 (forbidden), or 405 (method not
// allowed). A 200 means a guard is missing; a 500 means the handler ran far
// enough to touch something it should never have reached. Both fail.
//
// NEGATIVE CONTROL (run it by hand after changing this file, per
// validation-and-qa): delete the `requireCapability` call from any route below
// and this suite must go red. If it stays green the suite is decorative.

vi.mock('../auth0', () => ({
  auth0: {
    // No session: the anonymous caller every row below is about.
    getSession: vi.fn(async () => null),
  },
}));

// Permissive stub: nothing here should be reached, and if a guard regression
// lets a handler through, the resulting call returns undefined and the handler
// fails loudly rather than quietly answering 200.
const fakeRedis = new Proxy({}, { get: () => async () => null });
vi.mock('../redis', () => ({ redis: () => fakeRedis, k: (name) => `fable2:${name}` }));

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REFUSALS = [401, 403, 405];

function makeReq(method) {
  return { method, query: {}, body: {}, headers: {}, cookies: {} };
}

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
    send(payload) {
      if (out.statusCode === null) out.statusCode = 200;
      out.body = payload;
      return res;
    },
    end() {
      if (out.statusCode === null) out.statusCode = 200;
      return res;
    },
    redirect(code) {
      out.statusCode = typeof code === 'number' ? code : 302;
      return res;
    },
    _out: out,
  };
  return res;
}

async function callRoute(loader, method) {
  const mod = await loader();
  const res = makeRes();
  await mod.default(makeReq(method), res);
  return res._out;
}

// Every route that must refuse an anonymous caller outright. Grouped only for
// readable test output — the assertion is identical for all of them.
const CAPABILITY_ROUTES = {
  'admin/access-requests': () => import('../../pages/api/admin/access-requests'),
  'admin/analytics': () => import('../../pages/api/admin/analytics'),
  'admin/audit': () => import('../../pages/api/admin/audit'),
  'admin/broadcast': () => import('../../pages/api/admin/broadcast'),
  'admin/bulk-share': () => import('../../pages/api/admin/bulk-share'),
  'admin/cleanup': () => import('../../pages/api/admin/cleanup'),
  'admin/collections': () => import('../../pages/api/admin/collections'),
  'admin/groups': () => import('../../pages/api/admin/groups'),
  'admin/order': () => import('../../pages/api/admin/order'),
  'admin/private-list': () => import('../../pages/api/admin/private-list'),
  'admin/roles': () => import('../../pages/api/admin/roles'),
  'admin/schedule': () => import('../../pages/api/admin/schedule'),
  'admin/settings': () => import('../../pages/api/admin/settings'),
  'admin/share': () => import('../../pages/api/admin/share'),
  'admin/shares': () => import('../../pages/api/admin/shares'),
  'admin/shares-bulk': () => import('../../pages/api/admin/shares-bulk'),
  'admin/upload': () => import('../../pages/api/admin/upload'),
  'admin/videos': () => import('../../pages/api/admin/videos'),
  'admin/videos-bulk': () => import('../../pages/api/admin/videos-bulk'),
  'admin/viewer-activity': () => import('../../pages/api/admin/viewer-activity'),
  'admin/viewers': () => import('../../pages/api/admin/viewers'),
  'admin/viewers-bulk': () => import('../../pages/api/admin/viewers-bulk'),
};

const VIEWER_ROUTES = {
  videos: () => import('../../pages/api/videos'),
  collections: () => import('../../pages/api/collections'),
  progress: () => import('../../pages/api/progress'),
  'push/subscribe': () => import('../../pages/api/push/subscribe'),
  'push/unsubscribe': () => import('../../pages/api/push/unsubscribe'),
  'share-event': () => import('../../pages/api/share-event'),
  'request-access': () => import('../../pages/api/request-access'),
};

beforeEach(() => {
  process.env.ADMIN_EMAILS = 'owner@example.com';
  // push/subscribe answers 400 "not configured" BEFORE its guard when VAPID
  // keys are absent — correct inert-until-configured behaviour, but it would
  // mean this suite never actually exercised that route's guard. Configure it
  // so the guard is the thing under test.
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';
});

describe('deny-by-default: /api/admin/* refuses anonymous callers', () => {
  for (const [name, loader] of Object.entries(CAPABILITY_ROUTES)) {
    it(`${name} refuses every method`, async () => {
      for (const method of METHODS) {
        const out = await callRoute(loader, method);
        expect(
          REFUSALS,
          `${name} answered ${out.statusCode} to an anonymous ${method}`
        ).toContain(out.statusCode);
      }
    });

    // Guards against the assertion above going vacuous: a route that answered
    // 405 to everything would "pass" without any guard running at all.
    it(`${name} actually reaches a guard on at least one method`, async () => {
      const codes = [];
      for (const method of METHODS) codes.push((await callRoute(loader, method)).statusCode);
      expect(codes.some((c) => c === 401 || c === 403)).toBe(true);
    });
  }
});

describe('deny-by-default: viewer APIs refuse anonymous callers', () => {
  for (const [name, loader] of Object.entries(VIEWER_ROUTES)) {
    it(`${name} refuses every method`, async () => {
      for (const method of METHODS) {
        const out = await callRoute(loader, method);
        expect(
          REFUSALS,
          `${name} answered ${out.statusCode} to an anonymous ${method}`
        ).toContain(out.statusCode);
      }
    });

    it(`${name} actually reaches a guard on at least one method`, async () => {
      const codes = [];
      for (const method of METHODS) codes.push((await callRoute(loader, method)).statusCode);
      expect(codes.some((c) => c === 401 || c === 403)).toBe(true);
    });
  }
});

// The PWA manifest is the second deliberate public route: it must be fetchable
// pre-login for the app to be installable, and it leaks only branding — the
// same class of exception as the palette below.
describe('/manifest.webmanifest is public and carries the configured site name', () => {
  const loadManifest = () => import('../../pages/api/manifest');

  it('serves a manifest to an anonymous GET', async () => {
    const out = await callRoute(loadManifest, 'GET');
    expect(out.statusCode).toBe(200);
    const parsed = JSON.parse(out.body);
    expect(parsed.name).toBe('Marine Video Portal'); // stubbed Redis → default
    expect(parsed.short_name.length).toBeLessThanOrEqual(12);
    expect(parsed.icons.length).toBeGreaterThan(0);
  });

  it('refuses non-GET methods', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await callRoute(loadManifest, method)).statusCode).toBe(405);
    }
  });
});

// The one documented public exception. Pinned here so that if it is ever made
// non-public the change is deliberate, and so nobody "fixes" it by accident.
describe('/api/theme is public on GET and guarded on POST — a deliberate exception', () => {
  const loadTheme = () => import('../../pages/api/theme');

  it('serves a palette to an anonymous GET', async () => {
    const out = await callRoute(loadTheme, 'GET');
    expect(out.statusCode).toBe(200);
    expect(out.body).toHaveProperty('colors');
  });

  it('refuses an anonymous POST', async () => {
    const out = await callRoute(loadTheme, 'POST');
    expect(out.statusCode).toBe(403);
  });
});
