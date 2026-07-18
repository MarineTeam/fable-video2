---
name: architecture-contract
description: "The load-bearing design decisions of Marine Video Portal, WHY each was made, the invariants that must stay true (with enforcement points), the authoritative Redis data-model inventory, and the honest list of known weak points. Use when changing auth/guards, signing, Redis keys, adding an API route or page, or judging whether a change breaks a security/availability guarantee. Not for how-to-run (see run-and-operate), env vars (see config-and-env), debugging symptoms (see debugging-playbook), or vendor API theory (see reference)."
---

# Architecture Contract — Marine Video Portal

This is the contract a change must not break. Every claim below was verified
against the code on 2026-07-18 (file:line given). If a cited line has moved,
re-verify with the commands in "Provenance and maintenance" before trusting it.

Vocabulary (used throughout, defined once):

- **Viewer** — an email address in the Redis SET `fable2:viewers`, added by an admin.
- **Admin** — an email address in the `ADMIN_EMAILS` env var (comma-separated).
- **Guard** — one of `requireAdmin` / `requireViewer` in `lib/guard.js`; an API
  route calls it first and returns immediately if it yields null.
- **Bunny** — bunny.net Stream, the video storage/encoding/CDN vendor.
- **Signed URL / ticket** — a URL or header set containing a SHA-256 token
  computed server-side from a secret key + an expiry timestamp.
- **TUS** — a resumable-upload HTTP protocol; the browser speaks it directly
  to Bunny.

---

## 1. Load-bearing design decisions and WHY

Do not "improve away" any of these without reading its WHY. Each one trades
something (generality, features, strictness) for something this project values
more (simplicity, key custody, availability).

### 1.1 Access control is normalized-email identity, not roles or user IDs

- There is no user table and no role system. Identity IS the lowercased,
  trimmed email from the Auth0 session (`lib/auth.js:5-7` `normalizeEmail`).
  Admins = membership in `ADMIN_EMAILS` (`lib/auth.js:9-20`); viewers =
  membership in the Redis SET `fable2:viewers` (`lib/guard.js:31`).
- WHY: a private portal for a small invited audience needs exactly one
  question answered — "is this email on the list?" — and email is the unit
  admins actually think in (they invite people by email, share links by email).
  No schema, no migrations, no ID↔email mapping to drift.
- LOAD-BEARING DEPENDENCY: this is only safe while **Auth0 open sign-ups stay
  disabled** tenant-wide (README.md:155, README.md:232). Anyone who can create
  an Auth0 account with an arbitrary email would inherit that email's access,
  because `email_verified` is NOT checked (weak point 4.1). Never re-enable
  sign-ups without first completing the email_verified campaign
  (see `.claude/skills/campaign-email-verified/SKILL.md`).

### 1.2 No video bytes ever touch this server

- Upload: `pages/api/admin/upload.js:20-25` creates the Bunny video record and
  returns a server-signed TUS ticket (`lib/bunny.js:107-118`,
  `SHA256_HEX(libraryId + apiKey + expire + videoId)`, 6h TTL). The browser
  then streams the file straight to `https://video.bunnycdn.com/tusupload`
  with tus-js-client. Playback is a Bunny iframe embed; the server only mints
  the URL.
- WHY: (a) key custody — `BUNNY_API_KEY` is read in exactly one file,
  server-side (`lib/bunny.js:11`), and only the derived signature ships to the
  browser; (b) Vercel serverless functions have request-size and duration
  limits that make proxying multi-GB video impossible anyway. This decision is
  both a security stance and a platform necessity.

### 1.3 Embed URLs are signed per request, never stored

- Every playback page computes a fresh signed embed URL inside
  `getServerSideProps`: `pages/watch/[id].js:62` and `pages/s/[id].js:56`,
  via `signedEmbedUrl` (`lib/bunny.js:78-82`,
  `SHA256_HEX(BUNNY_TOKEN_AUTH_KEY + videoId + expires)`, default 4h TTL,
  expiry in unix seconds).
- WHY: a stored or public URL would be a permanent bearer credential —
  copyable into chat, indexable, unrevocable. A per-request 4h URL means a
  leaked link dies on its own and access is always re-checked against the
  current viewer list before a new one is minted. Thumbnails follow the same
  idea with CDN token auth, 12h TTL (`lib/bunny.js:87-102`).

### 1.4 All mutable state lives in Upstash Redis over REST

- The single Redis client is constructed lazily in `lib/redis.js:8-16`
  (`@upstash/redis`, REST transport) and every key goes through
  `k(name)` → `fable2:${name}` (`lib/redis.js:19`).
- WHY: Vercel serverless has no filesystem persistence and no long-lived TCP
  connections; a REST-based Redis works from any function invocation with zero
  connection pooling. Putting viewers, ordering, shares, settings, theme,
  progress, and audit in Redis makes every one of them **live-editable from
  /admin without a redeploy** — the operator story depends on this.
- STALENESS WARNING: the comment above `k()` (`lib/redis.js:18`) and both
  README.md:12 and FEATURES.md:81 still say the prefix is `pvp:`. The code is
  authoritative: commit 6dd4351 renamed it to `fable2:` and touched only
  `lib/redis.js`. Any Redis data written under `pvp:*` by a pre-rename deploy
  is orphaned until manually migrated.

### 1.5 Pages Router + getServerSideProps gating

- Every page that shows protected content decides access **on the server,
  before any UI is sent**: `pages/index.js:10-12` (redirect to login),
  `pages/admin.js:19-27` (redirect non-admins to `/`),
  `pages/watch/[id].js:14-31` (login redirect + viewer check),
  `pages/s/[id].js:14-33` (login redirect + recipient match).
- WHY: with server-side rendering the unauthorized case never receives the
  page bundle or props — there is no client-side flash of protected content
  and no "hidden but present" admin UI. This is deliberately boring Next.js
  Pages Router; there is no App Router, no RSC, no client-side auth state
  machine to get wrong.

### 1.6 Auth0 v4 with middleware-mounted auth routes

- `lib/auth0.js:6` is a bare `new Auth0Client()` — entirely env-driven, kept
  minimal to stay edge-compatible. `middleware.js:5-7` delegates every
  matched request to `auth0.middleware`, which mounts `/auth/login`,
  `/auth/logout`, `/auth/callback`, `/auth/profile` and **rolls the session
  cookie on every other request**. The matcher (`middleware.js:10-12`)
  excludes static/PWA assets so `sw.js`, icons, and the manifest are served
  without auth (required for installability).
- WHY: the v4 SDK's supported pattern. Note the route prefix is `/auth/*`,
  NOT `/api/auth/*` (v3 style) — Auth0 callback URLs are configured
  accordingly (README.md:155).

### 1.7 Failure tolerance is an architectural stance, not an accident

The recurring idiom: **availability of the core viewing path beats
completeness of auxiliary features.** Never invert these:

| Idiom | Where | Consequence if inverted |
|---|---|---|
| Rate limiting fails OPEN | `lib/ratelimit.js:23-30` (catch → `return true`) | A Redis outage would lock every user out of `/api/videos` instead of merely disabling throttling |
| Audit logging is best-effort | `lib/audit.js:18-20` (swallow) | A logging failure would block the admin action being logged |
| Last-seen stamping is fire-and-forget | `lib/guard.js:40-42` (`.catch(() => {})`) | A Redis hiccup would fail otherwise-authorized requests |
| Share email is best-effort | `pages/api/admin/share.js:79-86` | A Resend outage would block link creation (the link is still valid without the email) |
| Push announce is best-effort | `lib/push.js:110-112`, `pages/api/admin/videos.js:23` | A push failure would break the admin video list |
| Optional features are inert until configured | `lib/push.js:5-7` (needs BOTH VAPID keys), `lib/mail.js:4-6` (needs RESEND_API_KEY) | Half-configured features would throw at runtime instead of hiding |

The one deliberate exception: `requireViewer` fails CLOSED on Redis errors
(`lib/guard.js:32-34`, catch → `approved = false`) — an authorization check
must never fail open. Same pattern in `pages/index.js:20-22` and
`pages/watch/[id].js:26-28`. Availability yields to security exactly here.

---

## 2. Invariants — must remain true after every change

Check this table before merging anything that touches auth, APIs, signing, or
Redis. "Enforcement" is where the invariant lives today; "If violated" is what
actually breaks.

| # | Invariant | Enforcement (verified 2026-07-18) | If violated |
|---|---|---|---|
| I1 | Every email comparison goes through `normalizeEmail` | `lib/auth.js:5-7`; used at every check site: `lib/guard.js:7`, `lib/auth.js:12,17`, `pages/index.js:14`, `pages/watch/[id].js:20`, `pages/admin.js:24`, `pages/s/[id].js:20,31`, `pages/api/admin/viewers.js:36,58`, `pages/api/admin/share.js:52`, `lib/push.js:23-25,54` | Case/whitespace variants of one email become distinct identities: viewers stored as `Bob@X` never match session `bob@x`; share links unusable by their own recipient |
| I2 | Every `/api/admin/*` route calls `requireAdmin` first and returns on null | All 10 routes: analytics.js:9, audit.js:6, broadcast.js:7, collections.js:6, order.js:7, settings.js:8, share.js:21, shares.js:7, upload.js:11, videos.js:14 (each followed by `if (!admin) return`) | Any signed-in (or with a broken session check, anonymous) user can upload, delete videos, mint share links, edit the viewer list |
| I3 | Every viewer-data API calls `requireViewer` (or an explicit documented weaker guard) | `/api/videos` → videos.js:11; `/api/collections` → collections.js:6; `/api/progress` → progress.js:8; `/api/push/subscribe` → subscribe.js:8. Deliberate exceptions: `/api/theme` GET is public (theme.js:6-17 — colors only, POST is requireAdmin at theme.js:20); `/api/push/unsubscribe` needs only a session (unsubscribe.js:8-9 — a de-listed viewer must still be able to silence their device) | Unapproved accounts enumerate the library, read/write watch history, register push devices |
| I4 | `BUNNY_API_KEY` is read server-side only, in one place | `lib/bunny.js:11` is the sole reference in the repo; only the derived TUS signature reaches the browser (`pages/api/admin/upload.js:23-25`) | Full read/write control of the Bunny library leaks to any page viewer |
| I5 | Embed URLs are generated per request and never persisted | Only two call sites, both inside `getServerSideProps`: `pages/watch/[id].js:62`, `pages/s/[id].js:56`; nothing writes an embed URL to Redis or returns one from an API list endpoint (`/api/videos` returns guid/title/length/thumbnail only, videos.js:35-41) | A stored URL becomes an unrevocable bearer credential outliving viewer removal |
| I6 | All Redis access goes through `redis()` and all keys through `k()` | `new Redis` exists only in `lib/redis.js:10`; no literal `fable2:`/`pvp:` key string exists outside `lib/redis.js` (the two remaining `pvp` strings are client-side names, not Redis keys: `lib/theme.js:20`, `public/sw.js:4`) | Split-brain state across prefixes; a second client with different env fallbacks silently targets another database |
| I7 | Share-mismatch responses never reveal the intended recipient | `pages/s/[id].js:31-33` returns only `state: 'mismatch'`; the rendered copy (`pages/s/[id].js:99-110`) names no address | A share link becomes an oracle for harvesting who was invited to what |
| I8 | The service worker caches only the 5 public static assets — never authed pages, API responses, or video | `public/sw.js:5-11` (allowlist) and `public/sw.js:31-38` (fetch handler responds only for allowlisted same-origin paths; everything else goes to network) | Protected content persists in cache storage on shared machines after logout; stale API data served offline |
| I9 | Guards fail CLOSED; the rate limiter fails OPEN — never swap these | Closed: `lib/guard.js:32-34`; open: `lib/ratelimit.js:27-29` | Swapped one way: Redis outage grants access to everyone. Swapped the other: Redis outage takes the whole portal down |
| I10 | Share IDs are unguessable and expire server-side | `pages/api/admin/share.js:56` (18 random bytes, base64url ≈ 144 bits) and share.js:65 (`EX ttlHours*3600`, clamped 1–720h at share.js:54) | Guessable/eternal links defeat recipient-locking |

Rate-limited endpoints (for completeness; all via `allowRequest`):
`/api/videos` 60/min per email (videos.js:13), `/api/admin/upload` 20/hour
(upload.js:13), `/api/admin/share` 10/min (share.js:23).

When adding **any new API route or page**: pick the guard first (I2/I3), keep
it as the first statement, and add the route to the mapping above. The
entry-point×guard matrix method for re-proving I2/I3 exhaustively lives in
`.claude/skills/security-analysis-toolkit/SKILL.md`.

---

## 3. Redis data model — authoritative inventory

This table is the single home of the key inventory. All keys are created via
`k()` and therefore live under the **`fable2:`** prefix (`lib/redis.js:19` —
ignore the stale `pvp:` claims in README.md:12 / FEATURES.md:81). The Upstash
client auto-serializes objects to JSON on write and parses on read; readers
still defensively handle string values.

| Key (after `fable2:`) | Type | Shape | Writer(s) | Reader(s) | TTL / cap |
|---|---|---|---|---|---|
| `viewers` | SET | normalized emails | SADD admin/viewers.js:49; SREM admin/viewers.js:61 | guard.js:31; index.js:19; watch/[id].js:25; push.js:50; admin/viewers.js:14 | none (the access-control list — never expires) |
| `viewer:lastseen` | HASH | email → ISO timestamp | HSET guard.js:40-42, index.js:25-27, watch/[id].js:52-54; HDEL admin/viewers.js:62 | HGETALL admin/viewers.js:15 | none |
| `settings:homeCount` | string | integer as string | SET admin/settings.js:26 | admin/settings.js:14; api/videos.js:23 | none; clamped 1–200 on every read (videos.js:26, settings.js:15) |
| `order` | string (JSON array) | array of video guids | SET admin/order.js:19; pruned on video delete admin/videos.js:66-72 | api/videos.js:24; admin/videos.js:24 | none; capped 500 entries at write (order.js:11-15) |
| `theme` | string (JSON object) | `{name, colors:{bg,panel,text,muted,accent,accent2}}` | SET api/theme.js:26 (validated, theme.js:25-39) | api/theme.js:11 (public GET) | none |
| `audit` | LIST | JSON `{actor, action, detail≤300, at}` | LPUSH+LTRIM audit.js:16-17 | LRANGE audit.js:25 (via admin/audit.js, top 100) | LTRIM-capped at 200 entries; best-effort writes |
| `share:<id>` | string (JSON object) | `{videoId, email, createdAt, expiresAt[, viewedAt]}` | SET EX admin/share.js:65; rewritten preserving TTL on first view s/[id].js:36-44; DEL admin/shares.js:52 | s/[id].js:26; admin/shares.js:17; admin/share.js:31 (resend) | `EX` = ttlHours×3600, default 72h, clamped 1–720h (share.js:10-11,54) |
| `shares` | SET | share ids (index over `share:<id>`) | SADD share.js:66; SREM shares.js:20 (self-prune), shares.js:53 (revoke) | SMEMBERS shares.js:13 | none — see weak point 4.7 |
| `progress:<email>` | HASH | videoId → JSON `{seconds, duration, title≤200, updatedAt}` | HSET api/progress.js:42-49 | HGETALL progress.js:15; HGET watch/[id].js:45 | none; GET response sliced to newest 30 (progress.js:4,24) but the hash itself is unbounded (bounded in practice by library size) |
| `push:subs` | HASH | endpoint → JSON `{sub, email, addedAt}` | HSET push/subscribe.js:21-23; HDEL push/unsubscribe.js:16 and push.js:86 (auto-prune on 404/410) | HGETALL push.js:60 | none |
| `push:announced` | SET | video guids already announced | SADD push.js:102 (its return value IS the once-only guard) | (SADD return only) | none; grows one guid per announced video |
| `rl:*` | (managed) | @upstash/ratelimit sliding-window internals | ratelimit.js:11-15 (prefix `k('rl')`) | same | managed by the library |

Rules when touching this model:

- New key → route it through `k()`, add a row here, and note it in
  `.claude/skills/config-and-env/SKILL.md` if operator-tunable.
- Never write a raw `fable2:` literal in app code (I6).
- Access-control data (`viewers`) and its consumers must keep identical
  normalization (I1) — the SET stores what `normalizeEmail` produced.

---

## 4. Known weak points — open, by design or by deferral

State these honestly to anyone inheriting the system. None is currently fixed;
do not describe any of them as mitigated-in-code.

1. **`email_verified` is not checked** (OPEN — the active campaign).
   `lib/guard.js:5-8` trusts `session.user.email` without checking the
   `email_verified` claim. Sole mitigation is operational: Auth0 sign-ups
   disabled tenant-wide (README.md:155). Documented as a known gap in
   FEATURES.md:95. Fix path: `.claude/skills/campaign-email-verified/SKILL.md`.
2. **Fail-open rate limiter** (OPEN, deliberate). A Redis outage disables rate
   limiting entirely (`lib/ratelimit.js:27-29`). Accepted trade: see §1.7.
3. **Audit log is not a forensic record** (OPEN, deliberate). Best-effort
   writes, capped at 200 entries (`lib/audit.js:3,16-20`) — entries can be
   silently dropped, and history beyond 200 actions is gone. Treat it as an
   operator convenience, never as evidence.
4. **Admin list is env-frozen.** Admins come from `ADMIN_EMAILS`
   (`lib/auth.js:9-14`); changing admins requires a Vercel env edit + redeploy,
   unlike viewers (live in Redis).
5. **Homepage silently truncates libraries >100 videos.** `/api/videos`
   fetches only page 1 of `min(homeCount, 100)` from Bunny
   (`pages/api/videos.js:30`) while `homeCount` may be set up to 200
   (videos.js:26). With >100 playable videos, items beyond Bunny's first 100
   never appear regardless of the setting — and any `order`/cap logic
   (videos.js:32) operates on that truncated page.
6. **Search/collection filtering is Bunny-side, page 1 only.** `listVideos`
   passes `search`/`collection` to Bunny (`lib/bunny.js:32-41`) but only page 1
   is ever requested (videos.js:30), so results are whatever Bunny ranks into
   the first ≤100 items.
7. **The `shares` SET self-prunes only on admin reads.** Expired `share:<id>`
   values vanish via `EX`, but their ids stay in the index until an admin
   opens the Shares tab (`pages/api/admin/shares.js:18-21`). Between reads the
   index over-counts; harmless but surprising.
8. **Idle timeout is client-side only.** 30-minute inactivity logout runs in
   the browser (`components/IdleTimeout.js:3,12-14`, mounted in
   `pages/_app.js:34`); meanwhile middleware rolls the session cookie on every
   request (`middleware.js:3-7`). Anything that blocks the redirect (devtools,
   a frozen tab) defeats it; the session itself does not expire at 30 min.
9. **Legacy `pvp` names in client storage** (cosmetic). localStorage theme key
   `pvp:theme` (`lib/theme.js:20`) and service-worker cache `pvp-static-v1`
   (`public/sw.js:4`). Renaming them invalidates users' cached theme/assets
   for zero benefit — leave them unless doing a coordinated migration. These
   are NOT Redis keys and do not conflict with §1.4's rename note.

---

## 5. When NOT to use this skill

| You need | Go to |
|---|---|
| Run locally, deploy, provision Auth0/Bunny/Redis, use /admin | `.claude/skills/run-and-operate/SKILL.md` |
| Env var list, add-a-config checklist, build-time vs runtime | `.claude/skills/config-and-env/SKILL.md` |
| A symptom→cause triage ("uploads 401", "everyone locked out") | `.claude/skills/debugging-playbook/SKILL.md` |
| Vendor theory: Bunny signing schemes in general, Auth0 v4 SDK, Upstash semantics, VAPID | `.claude/skills/reference/SKILL.md` |
| Whether a change is allowed and how it's gated/reviewed | `.claude/skills/change-control/SKILL.md` |
| Proving the guard matrix / token math from first principles | `.claude/skills/security-analysis-toolkit/SKILL.md` |
| Executing the email_verified fix | `.claude/skills/campaign-email-verified/SKILL.md` |

This skill answers "what must stay true and why"; the siblings answer
"how do I do X".

---

## Provenance and maintenance

Derived 2026-07-18 by reading every file in `lib/`, `pages/`, `components/`,
`middleware.js`, and `public/sw.js` of this repo (all 4 commits of history
reviewed), then cross-checking README.md and FEATURES.md and flagging their
stale `pvp:` prefix claims against `lib/redis.js`. Every file:line above was
confirmed against the working tree on that date.

Re-verification one-liners (run from repo root; expect the stated result):

```bash
# I6 / §1.4 — prefix is fable2:, single client, no stray key literals
grep -n "fable2" lib/redis.js                     # expect: line 19 only
grep -rn "new Redis" --include="*.js" lib pages components   # expect: lib/redis.js only
grep -rn "pvp:" --include="*.js" lib pages components | grep -v theme.js   # expect: lib/redis.js:18 stale comment only

# I2 — every admin route guarded
grep -rLn "requireAdmin" pages/api/admin/*.js     # expect: no output

# I3 — viewer APIs guarded (theme GET + push/unsubscribe are documented exceptions)
grep -rn "requireViewer\|requireAdmin\|getSessionEmail" pages/api/*.js pages/api/push/*.js

# I4 — API key custody
grep -rn "BUNNY_API_KEY" --include="*.js" . | grep -v node_modules   # expect: lib/bunny.js only

# I5 — embed URLs only in the two getServerSideProps call sites
grep -rn "signedEmbedUrl" --include="*.js" pages lib   # expect: lib/bunny.js + watch/[id].js + s/[id].js

# I8 — service worker cache allowlist unchanged
grep -n "ASSETS\|CACHE" public/sw.js

# I9 — limiter fails open, guard fails closed
grep -n "return true" lib/ratelimit.js && grep -n "approved = false" lib/guard.js

# §4.5 — the 100-item truncation
grep -n "Math.min(homeCount, 100)" pages/api/videos.js
```

If any command's output deviates, the code has drifted from this contract:
re-read the touched file, fix either the code or this document, and record
the change (see `.claude/skills/docs-and-writing/SKILL.md`).
