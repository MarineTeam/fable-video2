#!/usr/bin/env node
// redis-inspect: READ-ONLY report of the portal's live Redis state, using the
// exact key names the app uses (prefix `fable2:` — see lib/redis.js).
// Issues only read commands (GET/SMEMBERS/SCARD/HLEN/LLEN/LRANGE/EXISTS/SCAN).
//
// Usage:  node .claude/skills/diagnostics-and-tooling/scripts/redis-inspect.mjs
// Needs KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) in env,
// e.g. `node --env-file=.env.local <this script>`.

import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error(
    'redis-inspect: no Redis credentials. Set KV_REST_API_URL + KV_REST_API_TOKEN\n' +
      '(or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), e.g.:\n' +
      '  node --env-file=.env.local .claude/skills/diagnostics-and-tooling/scripts/redis-inspect.mjs'
  );
  process.exit(2);
}
const r = new Redis({ url, token });
const k = (name) => `fable2:${name}`; // must match lib/redis.js

async function scanAll(pattern) {
  const keys = [];
  let cursor = 0;
  do {
    const [next, batch] = await r.scan(cursor, { match: pattern, count: 100 });
    keys.push(...batch);
    cursor = Number(next);
  } while (cursor !== 0 && keys.length < 5000);
  return keys;
}

const main = async () => {
  console.log('redis-inspect — Marine Video Portal state report (read-only)\n');

  // Viewers
  const viewers = (await r.smembers(k('viewers'))) || [];
  console.log(`Approved viewers        ${viewers.length}`);
  if (viewers.length) console.log(`  ${viewers.sort().join('\n  ')}`);
  const lastseenCount = await r.hlen(k('viewer:lastseen'));
  console.log(`Last-seen entries       ${lastseenCount}  (entries > viewer count = removed viewers' leftovers; harmless)`);

  // Settings
  const homeCount = await r.get(k('settings:homeCount'));
  console.log(`Homepage video count    ${homeCount ?? '(unset — app defaults to 48)'}`);
  const order = await r.get(k('order'));
  console.log(`Saved order entries     ${Array.isArray(order) ? order.length : '(none — newest-first only)'}`);
  const theme = await r.get(k('theme'));
  console.log(`Theme                   ${theme && theme.name ? theme.name : '(unset — app defaults to Ocean)'}`);

  // Audit
  const auditLen = await r.llen(k('audit'));
  const newest = auditLen ? (await r.lrange(k('audit'), 0, 0))[0] : null;
  let newestAt = '';
  if (newest) {
    try {
      const entry = typeof newest === 'string' ? JSON.parse(newest) : newest;
      newestAt = entry?.at ? `  (newest: ${entry.at} ${entry.action || ''})` : '';
    } catch {}
  }
  console.log(`Audit entries           ${auditLen} / 200 cap${newestAt}`);

  // Shares: index vs live keys (index is self-pruning only on admin reads)
  const shareIds = (await r.smembers(k('shares'))) || [];
  let live = 0;
  let stale = 0;
  for (const id of shareIds) {
    const exists = await r.exists(k(`share:${id}`));
    if (exists === 1) live += 1;
    else stale += 1;
  }
  console.log(`Share links             ${live} live, ${stale} stale index entries (stale = expired/revoked; pruned next time an admin opens the Shares tab)`);

  // Push
  const subCount = await r.hlen(k('push:subs'));
  const announced = await r.scard(k('push:announced'));
  console.log(`Push subscriptions      ${subCount} device(s)`);
  console.log(`Videos announced        ${announced}  (announce guard set — grows forever by design; entries are tiny)`);

  // Progress
  const progressKeys = await scanAll(k('progress:*'));
  console.log(`Watch-history viewers   ${progressKeys.length}`);

  // Rate-limit residue (TTL'd, informational)
  const rlKeys = await scanAll(k('rl*'));
  console.log(`Rate-limit keys         ${rlKeys.length}  (short-TTL sliding-window buckets; transient)`);

  // Orphaned pre-rename data (namespace was `pvp:` before commit 6dd4351)
  const orphans = await scanAll('pvp:*');
  if (orphans.length) {
    console.log(`\n!!!! ORPHANED pvp:* KEYS: ${orphans.length}`);
    console.log('  This database contains data written before the fable2: namespace rename.');
    console.log('  The app can no longer see it (viewers/shares/progress/theme written pre-rename).');
    console.log('  Keys:');
    for (const key of orphans.slice(0, 50)) console.log(`    ${key}`);
    if (orphans.length > 50) console.log(`    … and ${orphans.length - 50} more`);
    console.log('  See the debugging-playbook skill ("ALL data vanished after deploy").');
  } else {
    console.log(`Orphaned pvp:* keys     0  (no pre-rename leftovers)`);
  }

  console.log('\nDone. This script wrote nothing.');
};

main().catch((err) => {
  console.error(`redis-inspect failed: ${err?.message || err}`);
  console.error('Check credentials and that the database is reachable (see config-and-env skill).');
  process.exit(1);
});
