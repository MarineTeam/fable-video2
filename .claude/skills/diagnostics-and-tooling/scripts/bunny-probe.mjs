#!/usr/bin/env node
// bunny-probe: checks the bunny.net Stream side — API reachability, library
// contents by encoding status, and the structural validity of the app's three
// signing schemes. Read-only against the Bunny API.
//
// Usage:  node .claude/skills/diagnostics-and-tooling/scripts/bunny-probe.mjs
// Needs BUNNY_LIBRARY_ID + BUNNY_API_KEY (+ optionally BUNNY_TOKEN_AUTH_KEY,
// BUNNY_CDN_HOSTNAME) — e.g. `node --env-file=.env.local <this script>`.

import crypto from 'node:crypto';

const env = (name) => (process.env[name] || '').trim(); // same trim as lib/bunny.js
const libraryId = env('BUNNY_LIBRARY_ID');
const apiKey = env('BUNNY_API_KEY');

if (!libraryId || !apiKey) {
  console.error('bunny-probe: BUNNY_LIBRARY_ID and BUNNY_API_KEY are required.');
  console.error('  node --env-file=.env.local .claude/skills/diagnostics-and-tooling/scripts/bunny-probe.mjs');
  process.exit(2);
}

// Status map from lib/bunny.js
const STATUS = {
  0: 'created (no file yet)',
  1: 'uploaded (queued)',
  2: 'processing',
  3: 'transcoding (playable)',
  4: 'finished (playable)',
  5: 'error',
  6: 'upload failed',
};

async function api(path) {
  const res = await fetch(`https://video.bunnycdn.com/library/${libraryId}${path}`, {
    headers: { AccessKey: apiKey, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Bunny GET ${path} → HTTP ${res.status}. 401 = wrong/whitespace-corrupted API key or wrong library id.`);
  }
  return res.json();
}

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

const main = async () => {
  console.log(`bunny-probe — library ${libraryId}\n`);

  // 1. Library contents
  const data = await api('/videos?page=1&itemsPerPage=100&orderBy=date');
  const items = data?.items || [];
  console.log(`Videos (first page)     ${items.length}  (library total: ${data?.totalItems ?? '?'})`);
  if ((data?.totalItems ?? 0) > 100) {
    console.log('  NOTE: library exceeds 100 — the app homepage fetches only page 1 of 100 (see architecture-contract known weak points).');
  }
  const byStatus = {};
  for (const v of items) byStatus[v.status] = (byStatus[v.status] || 0) + 1;
  for (const [code, count] of Object.entries(byStatus)) {
    console.log(`  status ${code} ${STATUS[code] || 'unknown'}: ${count}`);
  }
  const broken = items.filter((v) => v.status === 5 || v.status === 6);
  for (const v of broken) console.log(`  !!!! FAILED video: ${v.guid} "${v.title}" (status ${v.status})`);

  const collections = await api('/collections?page=1&itemsPerPage=100&orderBy=date');
  console.log(`Collections             ${(collections?.items || []).length}`);

  // 2. Signing structural checks (offline — mirrors lib/bunny.js formulas)
  console.log('\nSigning checks (structural, against lib/bunny.js formulas):');
  const tokenKey = env('BUNNY_TOKEN_AUTH_KEY');
  const probeGuid = items[0]?.guid || '00000000-0000-0000-0000-000000000000';
  if (tokenKey) {
    const expires = Math.floor(Date.now() / 1000) + 4 * 3600;
    const token = sha256Hex(`${tokenKey}${probeGuid}${expires}`);
    const url = `https://iframe.mediadelivery.net/embed/${libraryId}/${probeGuid}?token=${token}&expires=${expires}&autoplay=false&preload=false`;
    const ok = /^[0-9a-f]{64}$/.test(token) && expires > Date.now() / 1000;
    console.log(`  embed token          ${ok ? 'OK' : 'BAD'} (64-hex token, future unix-SECONDS expiry)`);
    console.log(`  sample embed URL     ${url.slice(0, 110)}…`);
    console.log('  To verify end-to-end: open the sample URL in a browser — it should play (or show the Bunny player) rather than "Unauthorized".');
  } else {
    console.log('  embed token          SKIPPED — BUNNY_TOKEN_AUTH_KEY not set');
  }
  const cdnHost = env('BUNNY_CDN_HOSTNAME');
  if (cdnHost) {
    const key = env('BUNNY_CDN_TOKEN_KEY') || tokenKey;
    const path = `/${probeGuid}/thumbnail.jpg`;
    if (key) {
      const expires = Math.floor(Date.now() / 1000) + 12 * 3600;
      const token = crypto
        .createHash('sha256')
        .update(`${key}${path}${expires}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      console.log(`  thumbnail token      OK (base64url, no padding): https://${cdnHost}${path}?token=${token.slice(0, 12)}…&expires=${expires}`);
      console.log('  NOTE: fetching that URL directly may 403 — referrer-based hotlink protection. That is expected; test from the app.');
    } else {
      console.log(`  thumbnail URL        unsigned (no token key set): https://${cdnHost}${path}`);
    }
  } else {
    console.log('  thumbnail URL        SKIPPED — BUNNY_CDN_HOSTNAME not set (homepage shows title list)');
  }
  {
    const expire = Math.floor(Date.now() / 1000) + 6 * 3600;
    const sig = sha256Hex(`${libraryId}${apiKey}${expire}${probeGuid}`);
    console.log(`  TUS signature        ${/^[0-9a-f]{64}$/.test(sig) ? 'OK' : 'BAD'} (sha256hex(libraryId+apiKey+expire+videoId))`);
  }

  console.log('\nDone. If formulas here ever disagree with lib/bunny.js, lib/bunny.js wins — update this script.');
};

main().catch((err) => {
  console.error(`bunny-probe failed: ${err?.message || err}`);
  process.exit(1);
});
