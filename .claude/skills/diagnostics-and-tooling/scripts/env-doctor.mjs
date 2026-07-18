#!/usr/bin/env node
// env-doctor: offline sanity check of every environment variable the Marine
// Video Portal reads. No network calls. Never prints secret values — only
// presence, length, and shape. Exit code 0 = required config healthy.
//
// Usage:  node .claude/skills/diagnostics-and-tooling/scripts/env-doctor.mjs
// (Run with your deployment's env, e.g. `vercel env pull` into .env.local and
//  `node --env-file=.env.local <this script>`.)

const out = [];
let requiredFailures = 0;

function check(name, { required = false, test, hint }) {
  const raw = process.env[name];
  const present = raw !== undefined && raw !== '';
  let status = present ? 'ok' : required ? 'MISSING' : 'unset';
  let note = present ? `set (${raw.length} chars)` : '';
  if (present && test) {
    const problem = test(raw);
    if (problem) {
      status = 'BAD';
      note = problem;
    }
  }
  if (!present && required) requiredFailures += 1;
  if (status === 'BAD') requiredFailures += required ? 1 : 0;
  out.push({ name, status, note: note || hint || '' });
  return present && status === 'ok';
}

const whitespace = (v) =>
  v !== v.trim() || /[\r\n]/.test(v)
    ? 'contains leading/trailing whitespace or a newline — re-paste the value cleanly (corrupts Bunny TUS signatures)'
    : null;

// --- Required ---------------------------------------------------------------
check('AUTH0_SECRET', {
  required: true,
  test: (v) => (v.trim().length < 32 ? 'shorter than 32 chars — generate with `openssl rand -hex 32`' : null),
});
check('APP_BASE_URL', {
  required: true,
  test: (v) => {
    if (!/^https?:\/\//.test(v)) return 'must start with http(s)://';
    if (/\/$/.test(v)) return 'has a trailing slash — remove it (Auth0 "Missing state" trap)';
    return null;
  },
});
check('AUTH0_DOMAIN', {
  required: true,
  test: (v) =>
    /^https?:\/\//.test(v)
      ? 'must NOT include a scheme — v4 SDK wants e.g. tenant.us.auth0.com'
      : null,
});
check('AUTH0_CLIENT_ID', { required: true });
check('AUTH0_CLIENT_SECRET', { required: true });
check('BUNNY_LIBRARY_ID', { required: true, test: whitespace });
check('BUNNY_API_KEY', { required: true, test: whitespace });
check('BUNNY_TOKEN_AUTH_KEY', { required: true, test: whitespace });
check('ADMIN_EMAILS', {
  required: true,
  test: (v) => {
    const emails = v.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!emails.length) return 'no parseable emails';
    const bad = emails.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    return bad.length ? `invalid entries: ${bad.join(', ')}` : null;
  },
});
const kvUrl =
  check('KV_REST_API_URL', { test: (v) => (!/^https:\/\//.test(v) ? 'must be an https:// URL' : null) }) ||
  check('UPSTASH_REDIS_REST_URL', { test: (v) => (!/^https:\/\//.test(v) ? 'must be an https:// URL' : null) });
const kvToken = check('KV_REST_API_TOKEN', {}) || check('UPSTASH_REDIS_REST_TOKEN', {});
if (!kvUrl || !kvToken) {
  requiredFailures += 1;
  out.push({
    name: 'Redis (either pair)',
    status: 'MISSING',
    note: 'need KV_REST_API_URL+TOKEN or UPSTASH_REDIS_REST_URL+TOKEN',
  });
}

// --- Optional / feature toggles --------------------------------------------
const cdnHost = check('BUNNY_CDN_HOSTNAME', {
  test: (v) => (/^https?:\/\//.test(v) ? 'hostname only, no scheme (e.g. vz-xxxx.b-cdn.net)' : whitespace(v)),
});
check('BUNNY_CDN_TOKEN_KEY', { test: whitespace });
const vapidPub = check('NEXT_PUBLIC_VAPID_PUBLIC_KEY', {});
const vapidPriv = check('VAPID_PRIVATE_KEY', {});
check('VAPID_SUBJECT', {
  test: (v) => (!/^(mailto:|https:\/\/)/.test(v) ? 'must be a mailto: address or https URL' : null),
});
const resend = check('RESEND_API_KEY', {});
check('MAIL_FROM', {});
const sentryServer = check('SENTRY_DSN', {});
const sentryClient = check('NEXT_PUBLIC_SENTRY_DSN', {});
check('SENTRY_AUTH_TOKEN', {});
check('SENTRY_ORG', {});
check('SENTRY_PROJECT', {});

// --- Report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('env-doctor — Marine Video Portal configuration check\n');
for (const row of out) {
  const icon = row.status === 'ok' ? ' OK ' : row.status === 'unset' ? ' -- ' : '!!!!';
  console.log(`${icon} ${pad(row.name, 30)} ${pad(row.status, 8)} ${row.note}`);
}

console.log('\nFeature switchboard (derived):');
console.log(`  Thumbnails      ${cdnHost ? 'ENABLED (BUNNY_CDN_HOSTNAME set)' : 'inert — homepage falls back to title list'}`);
console.log(`  Push            ${vapidPub && vapidPriv ? 'ENABLED (both VAPID keys set)' : 'inert — Notify button & broadcasts hidden'}`);
if (vapidPub !== vapidPriv) {
  console.log('                  WARNING: only ONE VAPID key is set — push stays inert; set both or neither.');
}
console.log(`  Share email     ${resend ? 'ENABLED (RESEND_API_KEY set)' : 'inert — email checkbox & resend hidden'}`);
console.log(`  Sentry server   ${sentryServer ? 'ENABLED' : 'inert'}   Sentry client   ${sentryClient ? 'ENABLED' : 'inert'}`);
console.log('\nRemember: env changes need a redeploy; NEXT_PUBLIC_* changes need a REBUILD.');

if (requiredFailures > 0) {
  console.log(`\nRESULT: ${requiredFailures} required problem(s). Fix the !!!! rows above.`);
  process.exit(1);
}
console.log('\nRESULT: required configuration looks healthy.');
