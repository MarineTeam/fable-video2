---
name: validation-and-qa
description: >-
  What counts as evidence in Marine Video Portal: the evidence hierarchy, the
  certified 30-test inventory and what each file protects, the house pattern
  for adding tests (pure functions in lib/, vitest only runs lib/__tests__),
  manual security-invariant checklists, and acceptance thresholds. Use when
  writing/reviewing tests, deciding whether a change is proven, or verifying
  security invariants by hand. Not for writing the fix itself (see
  debugging-playbook), measuring live state (diagnostics-and-tooling), or
  proof methodology (security-analysis-toolkit).
---

# Validation and QA — what counts as evidence here

This skill defines the acceptance discipline for the Marine Video Portal repo:
what evidence a change needs before it merges, what the existing test suite
certifies, how to add tests the house way, and how to verify the security
invariants no automated test currently covers.

## 1. The evidence hierarchy

Ranked from weakest to strongest claim, all facts verified 2026-07-18:

| Level | Evidence | What it proves | How to get it |
|---|---|---|---|
| 0 | "It looked fine" | Nothing. Not evidence. | — |
| 1 | CI green (lint + test + build) | Code compiles, style holds, certified logic intact. **Minimum bar for ANY merge.** | Push/PR to `main`; `.github/workflows/ci.yml` runs the `verify` job (install → lint → test → build with dummy env) |
| 2 | Unit tests | Pure logic behaves as specified, forever | `npm test` (vitest, `lib/__tests__/` only) |
| 3 | Diagnostics scripts | Live state (Redis contents, signed URLs, env) is what you think | see `.claude/skills/diagnostics-and-tooling/SKILL.md` |
| 4 | Manual browser verification | The integrated system (Auth0 + Redis + Bunny + browser) actually works | Checklists in section 4 below |

**Acceptance discipline:** a change is done when its *specific claim* has a
*specific verification*, and that verification is named in the PR description
or commit message. "Fixed share expiry" must say *how you know* — e.g. "added
test X" or "ran checklist item 5, observed 'Link unavailable'". Higher levels
do not substitute for lower ones: a passing manual check does not excuse a red
CI, and green CI does not prove an integration claim.

## 2. Certified test inventory (as of 2026-07-18)

`npm test` → vitest run → **4 files, 30 tests, all passing, ~0.5s**. Every
test file lives in `lib/__tests__/` and tests a pure module in `lib/`.

These tests are **golden**: they encode load-bearing product invariants. A
change that breaks one is wrong until proven otherwise — fix the change, not
the test, unless you can show the invariant itself was wrong (that is a
change-control decision, see `.claude/skills/change-control/SKILL.md`).

| File | Tests | Module | Invariant it protects | Why it matters |
|---|---|---|---|---|
| `lib/__tests__/auth.test.js` | 10 | `lib/auth.js` | `isAdmin` matches admin emails case-insensitively and whitespace-tolerantly; empty/missing `ADMIN_EMAILS` means *nobody* is admin; `normalizeEmail` lowercases+trims and null-safes; `isValidEmail` rejects garbage | **Access-control bedrock.** Every guard in the app compares normalized emails. A normalization regression silently locks out (or worse, admits) the wrong people. |
| `lib/__tests__/order.test.js` | 6 | `lib/order.js` | `applyOrder`: placed videos follow the saved order; **unplaced videos float to the top, newest first**; entries for deleted videos are ignored; null-safe. `pruneOrder` drops dead guids. | Float-to-top is the product's "new uploads are always visible" promise. Inverting it hides new content behind stale ordering. |
| `lib/__tests__/push.test.js` | 7 | `lib/push.js` | `shouldAnnounce`: only status 4 (finished), only within the 48h `ANNOUNCE_WINDOW_MS`, unparseable dates rejected — **no back-blast** of the old library when push is first enabled. `eligibleSubs`: only currently-allowed emails receive pushes (case-insensitive), malformed entries dropped — **a removed viewer stops getting notifications** even if their device subscription lingers. | Back-blast would spam every subscriber once per historical video. Removed-viewer exclusion is an access-revocation guarantee. |
| `lib/__tests__/theme.test.js` | 7 | `lib/theme.js` | `validateTheme`: only exact 6-digit hex colors accepted (`red`, `#fff` rejected), name capped at 32 chars, non-objects rejected — **injection-safe palette validation** for admin-supplied themes rendered as CSS variables. All 7 shipped presets validate. `themeCssVars` maps every color key and falls back to the default theme. | Theme colors from Redis are written into inline style. Strict hex validation is what makes that safe. |

Re-verify the counts any time: `npm test` must report `Test Files 4 passed (4)`
and `Tests 30 passed (30)` (plus any you have since added).

## 3. How to add tests — the house pattern

### The rule

**Testable logic is extracted into pure functions in `lib/`** — no `req`/`res`,
no Redis client in the function signature where avoidable — and tested in
`lib/__tests__/<module>.test.js` under vitest's node environment.

This is enforced by config, not convention. `vitest.config.js` (verified):

```js
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/__tests__/**/*.test.js'],
  },
});
```

**Tests placed anywhere else WILL NOT RUN.** A test file in `pages/`,
`components/`, or a root `__tests__/` is silently ignored by `npm test` and by
CI — you get a green run that proved nothing. After adding a file, always
confirm the file count in the vitest summary went up by one.

Look at `lib/push.js` for the canonical split: `shouldAnnounce` and
`eligibleSubs` are pure (data in, decision out) and tested; `sendToAll` and
`announceNewVideos` do the Redis/web-push I/O around them and are not. When
you write new behavior, shape it the same way — decide in a pure function,
perform in a thin wrapper.

### End-to-end walkthrough

Say you're adding share-TTL clamping logic. Today it lives inline in
`pages/api/admin/share.js` (`Math.min(Math.max(parseInt(hours, 10) || 72, 1), 720)`)
and is therefore untested.

1. **Extract the pure function** into a `lib/` module (new or existing):

   ```js
   // lib/share.js
   export const DEFAULT_SHARE_HOURS = 72;
   export const MAX_SHARE_HOURS = 720; // 30 days

   // Clamp an untrusted hours value to [1, MAX], defaulting when unparseable.
   export function clampShareHours(hours) {
     const n = parseInt(hours, 10);
     return Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_SHARE_HOURS, 1), MAX_SHARE_HOURS);
   }
   ```

2. **Write the test file** at `lib/__tests__/share.test.js` (the path is the
   contract — nothing else runs):

   ```js
   import { describe, it, expect } from 'vitest';
   import { clampShareHours, DEFAULT_SHARE_HOURS, MAX_SHARE_HOURS } from '../share';

   describe('clampShareHours', () => {
     it('passes through in-range values', () => {
       expect(clampShareHours(48)).toBe(48);
     });
     it('defaults unparseable input', () => {
       expect(clampShareHours('garbage')).toBe(DEFAULT_SHARE_HOURS);
       expect(clampShareHours(undefined)).toBe(DEFAULT_SHARE_HOURS);
     });
     it('clamps to [1, MAX]', () => {
       expect(clampShareHours(0)).toBe(1);
       expect(clampShareHours(99999)).toBe(MAX_SHARE_HOURS);
     });
   });
   ```

3. **Wire the route to the extracted function** (import from `lib/share.js`,
   delete the inline math) — behavior identical, now certified.

4. **Verify the test actually ran:**

   ```bash
   npm test
   ```

   Expect `Test Files 5 passed (5)` (one more than before) and your new test
   names in the output. If the file count did not increase, your file is
   outside the include pattern — fix the path.

5. **Name the evidence** in the commit/PR: "clampShareHours extracted +
   3 tests in lib/__tests__/share.test.js".

House test style (match the existing four files): ESM imports, `describe`/`it`
from vitest, small local factory helpers (`const v = (guid, dateUploaded) => ...`),
`beforeEach` to set `process.env` when a function reads env (see
`auth.test.js`), fixed timestamps instead of `Date.now()` for determinism
(see `push.test.js`'s `const NOW = Date.parse(...)`).

### What is currently untested (as of 2026-07-18)

- **API route handlers** (`pages/api/**`) — guard wiring, method checks,
  status codes.
- **getServerSideProps** (`pages/admin.js`, `pages/s/[id].js`,
  `pages/index.js`, `pages/watch/[id].js`) — redirects, share
  mismatch/gone states.
- **React components** (`components/`, page components).
- **middleware.js** (Auth0 mounting, matcher).

Route-level and component testing is an **open improvement, not a current
convention** — there is no request-mocking or DOM-testing harness installed,
and adding one is a real design decision (see
`.claude/skills/research-frontier/SKILL.md`). Until then, the guard and SSR
behavior above is covered only by the manual checklists in section 4. Do not
invent a route-testing pattern ad hoc inside an unrelated change.

## 4. Manual security-invariant checklist

Runnable against a deployment or `localhost:3000` with real env vars (Auth0 +
Redis + Bunny configured). You need: one **admin** account (in `ADMIN_EMAILS`),
one **approved viewer** account (in the Redis `fable2:viewers` set — add via
/admin), and one **unapproved** account. Run the full list after any change to
`lib/auth.js`, `lib/guard.js`, `lib/bunny.js` signing, `middleware.js`, share
logic, or admin routes — and record which items you ran in the PR.

### 4.1 Non-admin is redirected from /admin

1. Sign in as the approved-viewer (non-admin) account.
2. Navigate to `/admin` directly (type the URL).
3. **Expected:** immediate redirect to `/` (the home page). No admin UI ever
   renders, not even a flash — the gate is server-side in
   `pages/admin.js` `getServerSideProps`.
4. Signed out entirely? **Expected:** redirect to
   `/auth/login?returnTo=/admin` instead.

### 4.2 Non-admin gets 403 from every /api/admin/* route

There are **11 admin API routes** (verified; each independently calls
`requireAdmin` — the page redirect is not the only layer):
`analytics`, `audit`, `broadcast`, `collections`, `order`, `settings`,
`share`, `shares`, `upload`, `videos`, `viewers`.

1. While signed in as the non-admin viewer, run in the browser devtools
   console (uses your session cookie):

   ```js
   for (const r of ['analytics','audit','broadcast','collections','order',
                    'settings','share','shares','upload','videos','viewers']) {
     fetch(`/api/admin/${r}`).then((res) => console.log(r, res.status));
   }
   ```

2. **Expected:** every line logs `403`. Body is `{"error":"Forbidden"}`.
   Any 200 is a security regression — stop and treat it as an incident.

### 4.3 Unapproved user sees "Not approved"

1. Sign in with the unapproved account (valid Auth0 login, email not in
   `ADMIN_EMAILS`, not in the viewers set).
2. **Expected on `/`:** a card headed **"Not approved yet"** naming the
   signed-in email; no video grid, no thumbnails, no titles.
3. In devtools: `fetch('/api/videos').then(r => r.status)` →
   **Expected:** `403` (body `{"error":"Not approved"}`). No video metadata
   reaches an unapproved session.

### 4.4 Share link with the wrong account shows a generic mismatch

1. As admin, create a share (`/admin` → share a video) addressed to the
   viewer account's email. Copy the `/s/<id>` link.
2. Open the link while signed in as a *different* account (e.g. the
   unapproved one).
3. **Expected:** "Wrong account" page with generic text ("created for a
   different account"). It must **never reveal the intended recipient**.
4. **View-source check (mandatory):** Ctrl+U / `curl` the page with that
   session's cookie and search the entire HTML — including the
   `__NEXT_DATA__` JSON blob — for the recipient's email address.
   **Expected:** zero occurrences. (The server returns only
   `{ state: 'mismatch', user }` props — verified in
   `pages/s/[id].js`.) Also confirm no embed URL or video title appears.

### 4.5 Expired share shows "gone"

Waiting out a real TTL (default 72h) is impractical, so force it:

1. Create a share as admin; confirm the `/s/<id>` link works for its
   recipient.
2. Expire the Redis key manually (Upstash console CLI, or redis-cli against
   the REST endpoint's underlying DB):

   ```
   EXPIRE fable2:share:<id> 1
   ```

   Wait ~2 seconds. (Key prefix is `fable2:` — README/FEATURES saying `pvp:`
   are stale; see `lib/redis.js`.)
3. Reload the link as the recipient. **Expected:** "Link unavailable — this
   share link has expired or doesn't exist." No title, no player.
4. Bonus: a malformed id (`/s/x`) must show the same "gone" state without
   touching Redis.

### 4.6 Embed URL expires

The embed token is `SHA256_HEX(BUNNY_TOKEN_AUTH_KEY + videoId + expires)`
with a 4h default TTL (`signedEmbedUrl` in `lib/bunny.js`), so any change to
`expires` invalidates the signature — which gives a fast test:

1. Open a watch page, copy the iframe URL
   (`https://iframe.mediadelivery.net/embed/<lib>/<video>?token=...&expires=...`).
2. Open it in a new tab unmodified — **Expected:** video plays.
3. Edit the `expires` query value (change one digit, or set it to a past
   unix timestamp) and load it. **Expected:** Bunny refuses playback
   (403 / "video unavailable" screen). This proves the token is actually
   being enforced; if the tampered URL plays, **Embed View Token
   Authentication is OFF in the Bunny library's Security tab** — turn it on.
4. Slow variant (real expiry): keep an unmodified embed URL for >4h, then
   load it — same refusal expected.

### 4.7 Direct CDN thumbnail URL fails without a token

Only applies when **Block Direct URL File Access** is enabled on the Bunny
library (README recommends it; thumbnails are signed for exactly this reason).

1. On the home grid, copy a thumbnail URL
   (`https://<BUNNY_CDN_HOSTNAME>/<guid>/thumbnail.jpg?token=...&expires=...`).
2. Load it in a fresh private window with the token intact —
   **Expected:** image loads (token satisfies the block).
3. Strip `?token=...&expires=...` and load the bare URL —
   **Expected:** 403. If the bare URL serves the image, direct file access
   is not blocked — the whole library (playlists, mp4s) is hotlinkable.

## 5. Acceptance thresholds (as of 2026-07-18)

| Gate | Threshold | Notes |
|---|---|---|
| `npm run lint` | **Zero warnings tolerated** — `eslint .` currently exits clean with no output | The config (`eslint.config.mjs`) is already curated: `@next/next/no-img-element` and `react-hooks/set-state-in-effect` are deliberately off with documented reasons, and ESLint is pinned to 9.x. **Do not silence a new rule or touch the pin** without change-control (see `.claude/skills/change-control/SKILL.md`). |
| `npm test` | All tests pass, **deterministic**, suite stays fast (<1s today, ~0.5s) | No wall-clock sleeps, no network, no real `Date.now()` where a fixed timestamp works. A flaky test is a failing test. |
| `npm run build` | Passes **with dummy env** | That is exactly what CI proves: `.github/workflows/ci.yml` supplies dummy `AUTH0_*`, `APP_BASE_URL`, `BUNNY_*`, `ADMIN_EMAILS`, `KV_REST_API_URL/TOKEN`. If your change makes the build require a *real* service at build time, you broke CI's contract — fix the change. Copy the CI env block for local builds. |

## 6. When NOT to use this skill

| You are trying to… | Use instead |
|---|---|
| Diagnose a failure and write the fix | `.claude/skills/debugging-playbook/SKILL.md`, then `.claude/skills/change-control/SKILL.md` for gating the change |
| Measure live state (Redis contents, signed-URL validity, env sanity) | `.claude/skills/diagnostics-and-tooling/SKILL.md` — scripts, not eyeballs |
| Prove a security property from first principles (guard matrices, token math, leak analysis) | `.claude/skills/security-analysis-toolkit/SKILL.md` — this skill *runs* the checks; that one teaches *why they are sufficient* |
| Decide what the architecture must guarantee | `.claude/skills/architecture-contract/SKILL.md` |

## Provenance and maintenance

Derived 2026-07-18 by reading `vitest.config.js`, all four files in
`lib/__tests__/`, their subjects (`lib/auth.js`, `lib/order.js`,
`lib/push.js`, `lib/theme.js`), `lib/guard.js`, `lib/bunny.js`,
`pages/admin.js`, `pages/s/[id].js`, `pages/index.js`,
`pages/api/admin/share.js`, `eslint.config.mjs`, and
`.github/workflows/ci.yml`; and by running `npm test` (4 files / 30 tests /
~0.5s, all green) and `npm run lint` (clean) in this repo.

Re-verification one-liners for facts that may drift:

```bash
npm test                                   # expect: Test Files 4 passed, Tests 30 passed (update this skill if counts change)
grep -n "include" vitest.config.js         # expect: ['lib/__tests__/**/*.test.js']
ls pages/api/admin | wc -l                 # expect: 11 (update checklist 4.2 if routes change)
grep -rln "requireAdmin" pages/api/admin | wc -l   # expect: 11 — every admin route guarded
grep -n "Not approved yet" pages/index.js  # unapproved-user copy for checklist 4.3
grep -n "mismatch" pages/s/[id].js         # generic wrong-account state for checklist 4.4
grep -n "fable2" lib/redis.js              # key prefix used in checklist 4.5
grep -n "ttlSeconds = 4" lib/bunny.js      # embed TTL default (4h) for checklist 4.6
grep -n "set-state-in-effect\|no-img-element" eslint.config.mjs   # deliberately disabled rules
```
