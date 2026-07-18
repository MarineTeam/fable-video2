---
name: debugging-playbook
description: "Symptom-driven triage for Marine Video Portal failures. Use when something is BROKEN: login loops, 404 on /auth/login, callback mismatch, upload HTTP 401, missing thumbnails, thumbnail 403s, resume not working, 'Not approved', 429s, push notifications not arriving, share link 'expired'/'wrong account', empty audit log, ALL data vanished after deploy, build/lint failures. Not for adding features (see change-control), protocol theory (see reference), or running measurement scripts (see diagnostics-and-tooling)."
---

# Debugging Playbook — Marine Video Portal

Symptom → cause → discriminating experiment → fix, for every failure mode this
project has actually hit or documented. All claims verified against the code on
2026-07-18. Line numbers are from that date; re-verify with the grep commands in
Provenance if the file has changed.

**Jargon, defined once:**
- **TUS** — resumable-upload protocol; the browser streams video bytes directly to `https://video.bunnycdn.com/tusupload` with a server-signed signature.
- **VAPID** — keypair identifying this server to browser push services. Both halves must be set for push to exist at all.
- **Discriminating experiment** — the single cheapest check whose outcome tells two candidate causes apart.
- **Fails open / best-effort** — deliberate design: rate limiting allows on error; audit/mail/push/last-seen never block the primary action. Silence from these features is often *by design*, not a bug.

---

## 0. Triage discipline (do this before touching anything)

1. **Reproduce first.** Get the exact URL, account email, and HTTP status/JSON body (browser devtools → Network tab). Every API route here returns a distinct JSON error string — the string identifies the code path (grep for it).
2. **Suspect the environment before the code.** This app has had far more env/config incidents than code bugs. On Vercel: Settings → Environment Variables. **Env changes only apply to NEW deployments — always redeploy after changing one.** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is additionally baked into the client bundle at *build* time.
3. **Identify the failing layer** with the table in §1 before diving into any one service's dashboard.
4. **Measure, don't guess.** For Redis state inspection, signed-URL verification, env sanity checks, and API smoke probes, use the scripts in `.claude/skills/diagnostics-and-tooling/SKILL.md` instead of eyeballing.
5. **Check the archaeology (§3) before "fixing" anything odd-looking.** The ESLint pin, the disabled lint rules, and the `pvp` strings in `lib/theme.js`/`public/sw.js` are all deliberate. Re-fighting a settled battle is the most expensive mistake available here.

## 1. Which layer is failing?

Four services can independently fail. One discriminating check each (run from repo root; export real env values first, e.g. from Vercel or `.env.local`):

| Layer | Symptom shape | Discriminating check | Healthy result |
|---|---|---|---|
| **Auth0** | Can't log in, loops, callback errors, "Missing state" | `curl -sI "$APP_BASE_URL/auth/login" \| head -3` | `30x` redirect whose `location:` points at `https://<AUTH0_DOMAIN>/authorize?...`. A `404` = middleware problem (app-side, §2.1); an Auth0-hosted error page after redirect = Auth0-side. Also check the tenant's Monitoring → Logs. |
| **Bunny** | 502 `{"error":"Video service unavailable"}` from `/api/videos`, uploads fail, embeds won't play | `curl -s -o /dev/null -w '%{http_code}\n' -H "AccessKey: $BUNNY_API_KEY" "https://video.bunnycdn.com/library/$BUNNY_LIBRARY_ID/videos?page=1&itemsPerPage=1"` | `200`. A `401` = wrong/foreign `BUNNY_API_KEY` for that library. (`pages/api/videos.js:48-50` converts any Bunny API throw into that 502.) |
| **Redis (Upstash)** | Everyone "Not approved"; shares/progress/audit/theme silently empty; features vanish without errors | `curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/scard/fable2:viewers"` | `{"result":<n>}` with your expected viewer count. Connection error = Redis down/wrong creds. `{"result":0}` with viewers previously added = data missing → §3.3 (namespace orphaning). |
| **App (Vercel)** | 4xx/5xx JSON from `/api/*`, pages error | Vercel dashboard → Deployments → Functions logs; match the JSON error string to its route with `grep -rn "the error string" pages/` | — |

Key failure-direction facts (verified in code):
- **Approval fails CLOSED**: if Redis errors, `requireViewer` treats the user as not approved (`lib/guard.js:29-35`), and the homepage does the same (`pages/index.js:17-23`). So a Redis outage looks like a mass de-approval, not an error page.
- **Rate limiting fails OPEN** (`lib/ratelimit.js:21-30`): a Redis outage never causes 429s.
- **Audit, mail, push, last-seen are best-effort**: they swallow their own failures (`lib/audit.js`, `lib/mail.js`, `lib/push.js`, `lib/guard.js:40-42`). Their silence is evidence of *their* backend failing, never the cause of a primary-action failure.

## 2. Symptom table

Each entry: likely cause → discriminating experiment → fix. Extends the README "Common issues" list with the code-level detail.

### 2.1 Login loops, or 404 on `/auth/login`

- **Cause:** the Auth0 v4 SDK mounts `/auth/login|logout|callback|profile` **in middleware** (`middleware.js:5-7`) — there are no page/API files for these routes. If `middleware.js` isn't deployed, or its `matcher` (`middleware.js:9-13`) was edited so it no longer covers `/auth/*`, the routes simply don't exist → 404, and protected pages redirect to a 404 → loop.
- **Experiment:** `curl -sI "$APP_BASE_URL/auth/login"`. 404 → middleware not running for that path. Confirm the matcher still starts with `/((?!_next/static|...` and only excludes static/PWA assets: `grep -n "matcher" -A 3 middleware.js`.
- **Fix:** restore `middleware.js` to its committed form and redeploy. Never add paths to the exclusion list that `/auth/*` could match.

### 2.2 Auth0 error: "Callback URL mismatch"

- **Cause:** the Auth0 application's Allowed Callback URLs still list the v3-style `https://your-domain/api/auth/callback`. **v4 dropped the `/api` prefix** — the real callback is `https://your-domain/auth/callback`.
- **Experiment:** read the `redirect_uri` query param in the failing `/authorize` request URL (devtools) and compare it letter-for-letter with the Auth0 app's Allowed Callback URLs.
- **Fix:** Auth0 dashboard → Applications → your app → Allowed Callback URLs = `https://your-domain/auth/callback` (exact domain, no trailing slash). No code change.

### 2.3 "Missing state" on callback

- **Cause:** login was started from a URL different from `APP_BASE_URL` (old Vercel preview link, `www.` vs apex, http vs https). The state cookie is set on one origin, the callback lands on another.
- **Experiment:** compare the address bar's origin at the moment of the error against `APP_BASE_URL` in Vercel env. Any difference is the answer.
- **Fix:** always start from the exact production URL. If preview deployments must log in, they need their own `APP_BASE_URL` + callback URL entries.

### 2.4 Upload fails with HTTP 401 (from `video.bunnycdn.com`)

- **Cause:** the TUS signature is `SHA256_HEX(libraryId + apiKey + expire + videoId)` (`lib/bunny.js:107-118`) — any corruption of `BUNNY_LIBRARY_ID`/`BUNNY_API_KEY` yields a well-formed but wrong signature → Bunny 401. The historical culprit was a stray newline pasted into Vercel. **`lib/bunny.js:9` now `.trim()`s every Bunny env value** (`const env = (name) => (process.env[name] || '').trim();`), so if this recurs, whitespace is no longer the cause — **the value itself is wrong** (key from a different library, rotated key, or wrong library ID). A second cause: the signature expires after 6h (`ttlSeconds = 6 * 3600`); a browser tab left open past that gets 401 on resume.
- **Experiment:** the Bunny-layer curl in §1. 401 there = bad key/ID (fix in Vercel, re-paste from the Bunny dashboard's Stream library → API key, redeploy). 200 there but TUS still 401 = ticket age (retry the upload fresh) or clock skew.
- **Fix:** re-paste both values cleanly in Vercel, redeploy, retry upload from a fresh `/admin` session.

### 2.5 Homepage shows a title list instead of thumbnails

- **Cause:** `thumbnailUrl()` returns `null` whenever `BUNNY_CDN_HOSTNAME` is unset (`lib/bunny.js:88-89`), and the homepage renders the grid only if some video has a thumbnail (`const hasThumbs = videos.some((v) => v.thumbnail)`, `pages/index.js:126`). The list is the designed fallback, not an error.
- **Experiment:** `curl` or devtools on `/api/videos` — are `thumbnail` fields `null`? Then check the env var exists in the *current deployment* (was it added after the last deploy?).
- **Fix:** set `BUNNY_CDN_HOSTNAME` to the library's CDN host (e.g. `vz-xxxx-xxx.b-cdn.net`) and **redeploy**.

### 2.6 Thumbnails 403 when opened directly, but load in the app

- **Not a bug.** Bunny hotlink protection ("Block Direct URL File Access") checks the `Referer` header; the app's `<img>` tags send the site's Referer, a pasted URL sends none. This is also why `@next/next/no-img-element` is disabled (`eslint.config.mjs:8-11`) — `next/image` would proxy server-side, strip the Referer, and break exactly this. Do not "fix" either side.

### 2.7 Resume / continue-watching not working (playback itself fine)

- **Cause chain:** resume rides on the player.js protocol over the Bunny embed iframe. `components/ResumablePlayer.js` degrades gracefully — if the embed doesn't answer the player.js handshake, video still plays but no `timeupdate` events fire, so no progress is ever saved (`/api/progress` POSTs, throttled to one per 5s, `ResumablePlayer.js:25-39`) and nothing resumes. Also note: resume only seeks when saved position > 5s (`initialTime > 5`, line 20).
- **Experiment:** play a video with devtools Network open, filtered to `progress`. POSTs every ~5s → save side works; check the homepage GET `/api/progress` next. No POSTs at all → the embed isn't exposing player.js (Bunny player config/version) — app code is not the problem.
- **Fix:** if POSTs 401/403 → viewer approval issue (§2.8). If no POSTs → verify the Bunny embed still supports player.js (see `.claude/skills/reference/SKILL.md`); playback continuing to work without resume is the designed degradation.

### 2.8 Signed-in user sees "Not approved yet" (page) or APIs return 403 `{"error":"Not approved"}`

- **Cause:** approval = membership of the **normalized** (trimmed, lowercased — `lib/auth.js:5-7`) session email in the Redis SET `fable2:viewers`, checked by `SISMEMBER` in both `lib/guard.js:31` and `pages/index.js:19`. Admins bypass via `ADMIN_EMAILS`. Three distinct causes: (a) email genuinely not added; (b) email added with different casing/whitespace *before* normalization existed at the write site (admin add normalizes, so this is rare); (c) **Redis unreachable — approval fails closed** (§1).
- **Experiment:** `curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/sismember/fable2:viewers/user@example.com"` (lowercase the email). `{"result":1}` but still 403 → the session email differs (check `/auth/profile` for the actual claim). `{"result":0}` → not in the set; `SMEMBERS` it to see near-misses. Connection error → Redis outage.
- **Fix:** add the exact email in `/admin` → Viewers (it normalizes on write), or fix Redis connectivity. If the whole set is empty when it shouldn't be → §3.3.

### 2.9 HTTP 429 "Too many requests"

Exactly **three** endpoints are rate-limited (per normalized email, sliding window):

| Endpoint | Limit | Code |
|---|---|---|
| `GET /api/videos` | 60 / 60s | `pages/api/videos.js:13` |
| `POST /api/admin/upload` | 20 / 3600s (returns "Too many uploads, slow down") | `pages/api/admin/upload.js:13` |
| `POST /api/admin/share` (create **and** resend) | 10 / 60s | `pages/api/admin/share.js:23` |

A 429 from anywhere else means something injected a proxy/CDN limit — it's not this app. Limiter keys live under `fable2:rl:*`. Because the limiter **fails open** (`lib/ratelimit.js:23-30`), Redis problems can never cause 429s — a 429 is always a real over-limit caller. Fix: wait out the window; if legitimate traffic trips `/api/videos`, that's a product decision → `.claude/skills/change-control/SKILL.md`.

### 2.10 Push notifications never arrive

Work down this checklist in order (`lib/push.js` throughout):

1. **Both keys set?** Push is inert unless `NEXT_PUBLIC_VAPID_PUBLIC_KEY` **and** `VAPID_PRIVATE_KEY` are set (`pushEnabled()`, `lib/push.js:5-7`). One key = feature fully hidden, no error anywhere.
2. **Rebuilt after changing the public key?** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is inlined into the client bundle at build time (`components/NotifyButton.js:4`). Changing it requires a redeploy/rebuild; old clients hold subscriptions signed for the old key and every send to them fails.
3. **Is the recipient still allowed?** Sends go only to currently-approved viewers + admins (`eligibleSubs`, `lib/push.js:22-27`); removing a viewer silently stops their pushes even though their device still holds a subscription. Deliberate.
4. **Was the subscription pruned?** Any send that gets HTTP 404/410 from the push service deletes that subscription from `fable2:push:subs` (`lib/push.js:85-88`). The device must re-subscribe via the "Notify me" button.
5. **Announcement rules:** a video is auto-announced only if `status === 4` (finished — status 3 "transcoding" is playable but NOT announced) **and** uploaded within the last 48h (`ANNOUNCE_WINDOW_MS = 48 * 3600 * 1000`, `shouldAnnounce`, `lib/push.js:9-18`), **and** it wins the once-ever `SADD fable2:push:announced` guard (`lib/push.js:102`). Re-testing with an already-announced video will never fire again unless you `SREM` its guid from that set.
6. **Announcement trigger:** announcements fire opportunistically when an admin's library list refreshes (`pages/api/admin/videos.js:23`). If no admin opens `/admin` while a video is inside its 48h window, it may never announce. Known behavior, not a bug.
7. Everything above checks out → test a manual broadcast from `/admin` → Settings; check Vercel function logs for `web-push` errors (wrong `VAPID_SUBJECT` format, etc.).

### 2.11 Share link: "expired or doesn't exist" vs "Wrong account"

Two different screens from `pages/s/[id].js`, and they discriminate for you:

- **"Link unavailable / expired or doesn't exist"** (`state: 'gone'`) — the Redis key `fable2:share:<id>` is gone: TTL elapsed (default 72h, max 720h, set with `EX` at creation — `pages/api/admin/share.js:54,65`), the link was revoked, the id is mangled, or the share data was orphaned by §3.3.
- **"Wrong account"** (`state: 'mismatch'`) — the key exists but the signed-in user's normalized email ≠ the recipient's (`pages/s/[id].js:31-33`). **By design this screen never reveals who the link was for** — do not "improve" the message. The recipient lock is the security model.
- **Experiment:** `/admin` → Shares tab lists every active link with recipient and expiry, or `curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/get/fable2:share:<id>"`. Key present → mismatch problem (user signed in with a different email — often a Google account vs the invited address). Key absent → expired/revoked; create a new link.

### 2.12 Admin actions succeed but the Activity tab shows no entries

- **Cause:** audit logging is **best-effort by design** — `logAction` swallows every failure (`lib/audit.js:7-21`), and `recentActions` returns `[]` on read failure too (`lib/audit.js:23-41`). Missing entries mean the Redis write or read is failing, or the list is under a different prefix (§3.3). The admin actions themselves are unaffected — that's the point.
- **Experiment:** `curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/llen/fable2:audit"`. Nonzero but empty tab → read side / `/api/admin/audit`. Zero after fresh admin actions → write side / Redis reachability (§1).
- **Fix:** fix Redis connectivity. **Do not** make audit logging blocking to "surface" the failure — best-effort is a load-bearing invariant (see `.claude/skills/architecture-contract/SKILL.md`). Note the log is capped at 200 entries (`LTRIM`, `lib/audit.js:3,17`) — old entries rolling off is normal.

### 2.13 FLAGSHIP: after a deploy, EVERYTHING behaves as if Redis is empty

Viewers all "Not approved", shares 404, continue-watching gone, palette reset, audit blank — simultaneously, right after deploying a new code version.

- **Root cause (the one time it happened):** commit `6dd4351` changed the key prefix from `pvp:` to `fable2:` in `lib/redis.js` **only** (`export const k = (name) => \`fable2:${name}\`;`, line 19). Every key the app reads moved; all data written by pre-rename deployments — `pvp:viewers`, `pvp:share:*`, `pvp:progress:*`, `pvp:theme`, `pvp:audit`, `pvp:order`, `pvp:settings:homeCount`, `pvp:push:subs` — became **orphaned**: still in Redis, invisible to the app.
- **Experiment:** `curl -s -H "Authorization: Bearer $KV_REST_API_TOKEN" "$KV_REST_API_URL/keys/pvp:*"` vs `.../keys/fable2:*`. Data under the prefix the code is NOT using = this exact failure. (Confirm the live prefix first: `grep -n "fable2" lib/redis.js`.)
- **Fix:** either re-enter the data via `/admin` (viewers, count, order, palette — shares/progress regenerate naturally), or migrate keys (RENAME each `pvp:*` key to its `fable2:*` twin; the Redis inspector in `.claude/skills/diagnostics-and-tooling/SKILL.md` enumerates them). If you ever change the prefix again, migrate in the same change — this is now a settled battle (§3.3).
- **Do NOT "fix" these** — they legitimately still say `pvp` and are unrelated to Redis: `THEME_STORAGE_KEY = 'pvp:theme'` (browser localStorage, `lib/theme.js:20`) and the service-worker cache name `pvp-static-v1` (`public/sw.js:4`).
- **Docs are stale here:** README line 12 and FEATURES.md line 81 (and the comment at `lib/redis.js:18`) still say `pvp:`. The code (`lib/redis.js:19`) is the truth: **`fable2:`**. See `.claude/skills/docs-and-writing/SKILL.md` for the drift ledger.

### 2.14 `npm run build` fails locally (env-related errors)

- **Cause:** `next build` executes enough of the app to want the required env vars; a fresh clone has none.
- **Fix:** copy the CI dummy-env pattern (`.github/workflows/ci.yml:30-42`). From repo root:

```bash
AUTH0_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
APP_BASE_URL=http://localhost:3000 \
AUTH0_DOMAIN=example.us.auth0.com \
AUTH0_CLIENT_ID=ci-dummy \
AUTH0_CLIENT_SECRET=ci-dummy \
BUNNY_LIBRARY_ID=1 \
BUNNY_API_KEY=ci-dummy \
BUNNY_TOKEN_AUTH_KEY=ci-dummy \
ADMIN_EMAILS=admin@example.com \
KV_REST_API_URL=https://example.upstash.io \
KV_REST_API_TOKEN=ci-dummy \
npm run build
```

Build failures with real values set usually mean a genuinely broken change — run `npm run lint && npm test` first; they need no env.

### 2.15 `eslint .` crashes with a TypeError (mentions `scopeManager.addGlobals`)

- **Cause:** ESLint 10 got installed. `eslint-config-next` 16.2.10's bundled parser does not implement ESLint 10's `scopeManager.addGlobals` API, so linting crashes before checking a single file. That's why `package.json` pins `"eslint": "^9.39.5"` (commit `9e5b086`).
- **Experiment:** `npx eslint --version` — `v10.x` confirms it. Check how it got in: `git diff package.json package-lock.json`.
- **Fix:** restore the 9.x pin and reinstall (`npm install --no-audit --no-fund`). **Do not "upgrade to fix the warning"** — the pin is deliberate and only comes off when eslint-config-next supports ESLint 10 (re-test on a branch, per `.claude/skills/change-control/SKILL.md`).

### 2.16 Lint suddenly reports `react-hooks/set-state-in-effect` (or `no-img-element`) everywhere

- **Cause:** someone re-enabled rules that are deliberately off in `eslint.config.mjs:8-16` (commit `d76a881`). The compiler-powered `set-state-in-effect` rule flags this app's plain fetch-on-mount + `setState` data loading — including `setState` after an `await` — which is the app's universal pattern (e.g. `pages/index.js:70-105`). `no-img-element` is off for the hotlink-protection reason in §2.6.
- **Fix:** restore the two `'off'` entries. Rewriting every data-loading effect to satisfy the rule is a product-wide refactor, not a lint fix — route it through change-control if ever desired.

## 3. Failure archaeology — settled battles, do not re-fight

Complete incident record (the repo has exactly 4 commits; 3 are incident responses).

| # | Incident | Symptom | Root cause | Evidence | Status |
|---|---|---|---|---|---|
| 3.1 | ESLint 10 parser crash | `eslint .` dies with TypeError, zero files linted | eslint-config-next 16.2.10's bundled parser lacks ESLint 10's `scopeManager.addGlobals` | commit `9e5b086` (changed `eslint` `^10.7.0` → `^9.39.5`); `package.json:25` | **Settled.** Pin stays until eslint-config-next supports ESLint 10. §2.15 |
| 3.2 | `set-state-in-effect` vs fetch-on-mount | Lint failures across every page with a data-loading effect | New compiler-powered rule flags plain fetch+setState pattern, even post-`await`; unsatisfiable without app-wide refactor | commit `d76a881`; `eslint.config.mjs:12-15` | **Settled.** Rule off deliberately. §2.16 |
| 3.3 | `pvp:` → `fable2:` namespace change | All Redis-backed state "vanished" for post-rename deployments | commit `6dd4351` edited only the `k()` prefix in `lib/redis.js` — no data migration, comment above it left stale | `lib/redis.js:19` (code truth); stale: `lib/redis.js:18` comment, README:12, FEATURES.md:81 | **Settled code-side; standing ops hazard.** Any `pvp:*` data from a pre-rename deployment stays orphaned until manually migrated. §2.13 |
| 3.4 | v4 callback-URL trap (deploy era) | Auth0 "Callback URL mismatch" at first deploy | Auth0 v4 SDK moved callback from `/api/auth/callback` to `/auth/callback`; tenant config predated it | README:155, README:249 (documented as setup rule + common issue) | **Settled.** Config rule, not code. §2.2 |
| 3.5 | "Missing state" (deploy era) | Callback fails after login from preview/alternate URL | State cookie origin ≠ `APP_BASE_URL` origin | README:250 | **Settled.** Operating rule: start from the production URL. §2.3 |
| 3.6 | Whitespace in Bunny env (deploy era) | Uploads 401 at Bunny despite "correct" key | Newline pasted into Vercel env corrupted the TUS SHA256 input | `lib/bunny.js:3-9` (`.trim()` + explanatory comment); README:251 | **Settled in code.** Recurrence now means the *value* is wrong, not its whitespace. §2.4 |

Rule: if a change would revert any "Settled" row (unpinning ESLint, re-enabling the rules, renaming the prefix without migration, moving auth routes out of middleware), stop and read `.claude/skills/change-control/SKILL.md` first.

## 4. When NOT to use this skill

| You actually want to… | Use instead |
|---|---|
| Add/modify a feature, or fix by changing behavior | `.claude/skills/change-control/SKILL.md` (classification, gates, non-negotiables) |
| Understand Bunny signing math, Auth0 v4 internals, Upstash semantics, player.js, VAPID in depth | `.claude/skills/reference/SKILL.md` |
| Run/interpret the measurement scripts (Redis inspector, signed-URL checker, env sanity, API probe) | `.claude/skills/diagnostics-and-tooling/SKILL.md` |
| Look up what an env var means or add a new one | `.claude/skills/config-and-env/SKILL.md` |
| Deploy, provision Auth0/Bunny/Redis, operate `/admin` day-to-day | `.claude/skills/run-and-operate/SKILL.md` |
| Know which invariants must hold and why (the data model, failure-tolerance idioms) | `.claude/skills/architecture-contract/SKILL.md` |
| Prove a security property rather than fix a breakage | `.claude/skills/security-analysis-toolkit/SKILL.md` |

## Provenance and maintenance

Derived 2026-07-18 by reading every cited file in this repo and the full git
history (4 commits: `741d980` initial, `9e5b086`, `d76a881`, `6dd4351`), and by
cross-checking the README "Common issues" section against the code that produces
each symptom. No behavior was inferred from docs alone; where docs and code
disagree (the `pvp:` prefix) the code is cited as truth and the docs flagged stale.

Re-verify before trusting, if files may have changed:

```bash
grep -n "fable2" lib/redis.js                          # live Redis prefix (§2.13, §3.3)
grep -n "eslint" package.json                          # 9.x pin still in place (§2.15)
grep -n "set-state-in-effect\|no-img-element" eslint.config.mjs   # rules still off (§2.16)
grep -n "matcher" -A 3 middleware.js                   # auth routes still middleware-mounted (§2.1)
grep -n "trim" lib/bunny.js                            # Bunny env trimming still present (§2.4)
grep -rn "allowRequest(" pages/api                     # rate-limited endpoints + limits (§2.9)
grep -n "ANNOUNCE_WINDOW_MS\|status !== 4" lib/push.js # announce window + status rule (§2.10)
grep -n "MAX_ENTRIES" lib/audit.js                     # audit cap (§2.12)
grep -n "MAX_HOURS\|DEFAULT_HOURS" pages/api/admin/share.js  # share TTLs (§2.11)
git log --oneline                                      # archaeology completeness (§3)
```

Line numbers cited throughout are as of 2026-07-18; treat the grep output, not
the line number, as authoritative.
