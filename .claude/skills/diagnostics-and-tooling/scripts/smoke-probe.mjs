#!/usr/bin/env node
// smoke-probe: unauthenticated black-box probe of a running deployment.
// Proves the guards DENY BY DEFAULT: with no session cookie, every protected
// surface must redirect to login or return 401/403 — never content.
//
// Usage:  node .claude/skills/diagnostics-and-tooling/scripts/smoke-probe.mjs [baseUrl]
//   baseUrl defaults to http://localhost:3000 (BASE_URL env also works).

const base = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// Each check: path, method, statuses that PASS, and what a pass proves.
const CHECKS = [
  { path: '/', expect: [302, 303, 307, 308], proves: 'homepage redirects anonymous users to login' },
  { path: '/admin', expect: [302, 303, 307, 308], proves: 'admin page redirects before sending any UI' },
  { path: '/watch/00000000-0000-0000-0000-000000000000', expect: [302, 303, 307, 308], proves: 'watch page requires login' },
  { path: '/s/abcdefgh1234', expect: [302, 303, 307, 308], proves: 'share page requires login before revealing anything' },
  { path: '/api/videos', expect: [401, 403], proves: 'video list denies anonymous callers' },
  { path: '/api/collections', expect: [401, 403], proves: 'collections deny anonymous callers' },
  { path: '/api/progress', expect: [401, 403], proves: 'watch history denies anonymous callers' },
  { path: '/api/admin/videos', expect: [401, 403], proves: 'admin video API denies non-admins' },
  { path: '/api/admin/viewers', expect: [401, 403], proves: 'viewer management denies non-admins' },
  { path: '/api/admin/shares', expect: [401, 403], proves: 'share management denies non-admins' },
  { path: '/api/admin/settings', expect: [401, 403], proves: 'settings deny non-admins' },
  { path: '/api/admin/audit', expect: [401, 403], proves: 'audit log denies non-admins' },
  { path: '/api/admin/analytics', expect: [401, 403], proves: 'analytics deny non-admins' },
  { path: '/api/admin/upload', method: 'POST', expect: [401, 403], proves: 'upload ticket creation denies non-admins' },
  { path: '/api/admin/share', method: 'POST', expect: [401, 403], proves: 'share creation denies non-admins' },
  { path: '/api/admin/order', method: 'POST', expect: [401, 403], proves: 'reorder denies non-admins' },
  { path: '/api/admin/broadcast', method: 'POST', expect: [401, 403], proves: 'push broadcast denies non-admins' },
  { path: '/api/admin/collections', expect: [401, 403], proves: 'collection management denies non-admins' },
  { path: '/api/push/subscribe', method: 'POST', expect: [400, 401, 403], proves: 'push subscribe denies anonymous (400 = push not configured, also a denial)' },
  { path: '/api/push/unsubscribe', method: 'POST', expect: [401], proves: 'push unsubscribe requires a session' },
  { path: '/api/theme', expect: [200], proves: 'theme GET is deliberately public (colors only)' },
  { path: '/manifest.webmanifest', expect: [200], proves: 'PWA manifest served without auth (by middleware matcher design)' },
  { path: '/sw.js', expect: [200], proves: 'service worker served without auth (by middleware matcher design)' },
  { path: '/robots.txt', expect: [200], proves: 'robots.txt served (should Disallow all)' },
];

const main = async () => {
  console.log(`smoke-probe — ${base} (no credentials sent)\n`);
  let failures = 0;
  for (const c of CHECKS) {
    const method = c.method || 'GET';
    let status, note = '';
    try {
      const res = await fetch(`${base}${c.path}`, {
        method,
        redirect: 'manual',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? '{}' : undefined,
      });
      status = res.status;
      const loc = res.headers.get('location') || '';
      if (loc) note = `→ ${loc.slice(0, 60)}`;
      // A redirect must go to login, not to content.
      if (c.expect.some((s) => s >= 300 && s < 400) && loc && !/\/auth\/login/.test(loc) && !/\/$/.test(loc)) {
        note += '  (WARNING: redirect target is not /auth/login — inspect manually)';
      }
    } catch (err) {
      status = `ERR ${err?.cause?.code || err.message}`;
    }
    const pass = c.expect.includes(status);
    if (!pass) failures += 1;
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${String(status).padEnd(4)} ${method.padEnd(4)} ${c.path.padEnd(46)} ${pass ? c.proves : `expected ${c.expect.join('/')}`} ${note}`
    );
  }
  console.log(
    failures
      ? `\nRESULT: ${failures} FAILING check(s). A FAIL on a protected route means the deny-by-default guarantee may be broken — treat as security-touching (see change-control).`
      : '\nRESULT: all checks pass — anonymous access is denied everywhere it should be.'
  );
  process.exit(failures ? 1 : 0);
};

main();
