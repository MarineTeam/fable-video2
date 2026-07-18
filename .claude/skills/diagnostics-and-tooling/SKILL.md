---
name: diagnostics-and-tooling
description: MEASURE instead of eyeball — runnable diagnostic scripts for the Marine Video Portal with interpretation guides. Use when you need to check env-var health (env-doctor), inspect live Redis state or hunt orphaned pvp:* data (redis-inspect), verify Bunny library/signing health (bunny-probe), or prove deny-by-default on a running deployment (smoke-probe). Also use before/after any fix to capture numbers. Not for interpreting a user-reported symptom (see debugging-playbook) or for CI/test evidence (see validation-and-qa).
---

# Diagnostics and tooling

Four read-only scripts live in this skill's `scripts/` directory. They exist so
you never conclude from the UI what a script can measure. Discipline:

1. **Measure before you fix.** Capture the script output that demonstrates the
   problem (a FAIL row, an orphan count, a MISSING var).
2. **Measure after you fix.** The same command must now show the healthy
   reading. "It looks fine now" is not a result; a flipped PASS/FAIL row is.
3. All scripts are **read-only** (redis-inspect issues only read commands;
   bunny-probe only GETs; smoke-probe sends no credentials). None print secret
   values.

All commands run from the repo root. Node ≥ 20.9 (the repo's `engines`
floor). Scripts use only Node builtins plus `@upstash/redis`, which is already
in `package.json` — run `npm install` first if `node_modules/` is missing.

To run against a deployment's configuration, pull the env into a file and use
`--env-file` (never paste secrets into a shell history):

```bash
node --env-file=.env.local .claude/skills/diagnostics-and-tooling/scripts/env-doctor.mjs
```

## Which script when

| You want to know | Script | Needs |
|---|---|---|
| "Is the configuration itself sane?" | `env-doctor.mjs` | env vars only, no network |
| "What state does the app actually have?" | `redis-inspect.mjs` | Redis credentials |
| "Is the video backend healthy? Are our tokens well-formed?" | `bunny-probe.mjs` | Bunny credentials |
| "Does a running deployment deny anonymous access everywhere?" | `smoke-probe.mjs` | a URL, nothing else |

## 1. env-doctor — configuration sanity (offline)

```bash
node .claude/skills/diagnostics-and-tooling/scripts/env-doctor.mjs
```

Checks presence and **shape** of every env var the app reads (catalog and
semantics: see the config-and-env skill). Shape checks encode this project's
real incidents: whitespace/newlines inside `BUNNY_*` values (corrupts TUS
signatures — README "Upload fails with HTTP 401"), a scheme on `AUTH0_DOMAIN`,
a trailing slash on `APP_BASE_URL` (the "Missing state" trap), a short
`AUTH0_SECRET`, unparseable `ADMIN_EMAILS`. It ends with a **feature
switchboard** showing which optional features are enabled vs inert, including
the half-configured-VAPID warning (one key set = push silently inert).

Healthy: every required row `OK`, exit code 0.

| Unhealthy reading | Meaning / next step |
|---|---|
| `MISSING` on a required row | The app cannot run correctly. Set it (config-and-env has the recipe), redeploy. |
| `BAD … whitespace` on BUNNY_* | Re-paste the value cleanly in Vercel. This exact trap cost real time (debugging-playbook §upload-401). |
| Feature shows inert unexpectedly | You set one of a pair (VAPID), or forgot the redeploy/rebuild rule printed at the bottom. |

## 2. redis-inspect — live state report (read-only)

```bash
node --env-file=.env.local .claude/skills/diagnostics-and-tooling/scripts/redis-inspect.mjs
```

Reports, using the app's exact key names (`fable2:` prefix, mirroring
`lib/redis.js`): approved-viewer list and count, last-seen entries, homepage
count, saved order length, theme, audit depth (of the 200 cap) with newest
entry, share index (live vs stale), push subscription and announced counts,
watch-history viewer count, transient rate-limit keys — and, critically, a
scan for **orphaned `pvp:*` keys**, the pre-rename namespace (commit 6dd4351
changed the prefix from `pvp` to `fable2`).

| Reading | Interpretation |
|---|---|
| `Approved viewers 0` but people expect access | Nobody has been added under the current namespace — or the data is sitting under `pvp:*` (check the orphan section). Add viewers from /admin, or migrate. |
| `ORPHANED pvp:* KEYS: N` | This database predates the namespace rename. The app cannot see that data. Decide: migrate (copy each `pvp:x` → `fable2:x` through change-control — there is no script for this yet, deliberately: migration writes data and must be reviewed) or re-enter state manually via /admin. |
| Stale share index entries > 0 | Normal: expired/revoked links linger in the index until an admin opens the Shares tab (self-pruning read). Only investigate if it grows unboundedly. |
| Last-seen entries > viewer count | Leftovers from removed viewers. Harmless. |
| `Videos announced` grows forever | By design — it is the exactly-once announce guard. Entries are tiny. |

## 3. bunny-probe — video backend + signing health

```bash
node --env-file=.env.local .claude/skills/diagnostics-and-tooling/scripts/bunny-probe.mjs
```

Live checks: API reachability (a 401 here means a wrong or
whitespace-corrupted key — the same trap env-doctor catches offline), video
count with per-status breakdown (status map 0–6 from `lib/bunny.js`; 5/6 rows
are flagged), collection count, and a warning when the library exceeds 100
videos (the homepage fetches only page 1 of 100 — a documented weak point, see
architecture-contract). Offline checks: regenerates all three token schemes
(embed, CDN thumbnail, TUS) with the formulas from `lib/bunny.js` and
validates their structure. These formulas were verified equivalent to the
app's actual output on 2026-07-18 by importing `lib/bunny.js` and comparing
tokens for identical inputs — all three matched.

| Reading | Interpretation |
|---|---|
| HTTP 401 from Bunny | Key/library-id wrong or corrupted. Run env-doctor; re-paste values. |
| Videos stuck at status 2/3 | Encoding in progress — the admin panel badges auto-refresh. Persistent = check Bunny dashboard. |
| status 5/6 rows | That upload failed server-side at Bunny. Delete and re-upload from /admin. |
| Sample embed URL shows "Unauthorized" in a browser | Embed View Token Authentication key mismatch: the library's Security tab key ≠ `BUNNY_TOKEN_AUTH_KEY`. |
| Direct thumbnail fetch 403s | Expected — referrer hotlink protection. Judge thumbnails from the app, not curl. |

## 4. smoke-probe — deny-by-default proof (black box)

```bash
node .claude/skills/diagnostics-and-tooling/scripts/smoke-probe.mjs https://your-app.vercel.app
# or against local dev (needs `npm run dev` running):
node .claude/skills/diagnostics-and-tooling/scripts/smoke-probe.mjs
```

Sends **unauthenticated** requests to every page and API route and asserts the
deny-by-default contract: pages redirect to login (30x), viewer APIs return
401/403, all eleven `/api/admin/*` routes return 401/403, and the four
deliberately public surfaces (`/api/theme` GET, manifest, sw.js, robots.txt)
return 200. An anonymous probe cannot prove what an *approved* user can do —
that's the manual checklist in validation-and-qa — but it proves the outer
wall holds, which is the invariant that matters most and the one a refactor
is most likely to silently break.

| Reading | Interpretation |
|---|---|
| All PASS | Anonymous access denied everywhere; public surfaces up. |
| FAIL on a protected route (e.g. 200) | **Stop. Security-touching.** A guard was removed or middleware isn't running (also check: login loop symptoms in debugging-playbook). Follow change-control. |
| ERR rows | Deployment unreachable or URL wrong — fix that before reading anything else. |
| Redirect warning (target not /auth/login) | Inspect manually — the redirect chain changed. |

## When NOT to use this skill

- You have a symptom and want a diagnosis → **debugging-playbook** (it will
  send you back here for the measurement step).
- You want merge evidence (lint/test/build) → **validation-and-qa**.
- You want to understand why a token formula is shaped that way → **reference**.
- You want to change what a script checks → that's a skill-library change;
  follow **change-control** and keep scripts read-only.

## Provenance and maintenance

Written 2026-07-18 by direct inspection of the codebase. Key names mirror
`lib/redis.js`; signing formulas mirror `lib/bunny.js` (equivalence-tested by
importing the module and comparing outputs); route expectations mirror the
guards in `lib/guard.js` and each handler. All four scripts pass
`node --check`; env-doctor/redis-inspect/bunny-probe were dry-run without env
and fail fast with usage messages.

Re-verify when code changes:

```bash
node --check .claude/skills/diagnostics-and-tooling/scripts/env-doctor.mjs   # (repeat per script)
grep -n "fable2" lib/redis.js                    # prefix still fable2: ? update redis-inspect + this file
grep -rn "process.env" lib pages components middleware.js | grep -oP "env\.\w+" | sort -u   # env-doctor coverage
grep -n "sha256\|digest" lib/bunny.js            # signing formulas still match bunny-probe?
ls pages/api pages/api/admin pages/api/push      # smoke-probe route list still complete?
```

If any of these disagree with a script, the app code wins — update the script
in the same change.
