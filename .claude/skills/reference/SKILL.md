---
name: reference
description: "Domain-theory pack for this repo's external contracts: bunny.net Stream API + all three token-signing schemes (embed, CDN thumbnail, TUS upload), Auth0 v4 SDK specifics, Upstash Redis REST semantics, Web Push/VAPID, player.js postMessage protocol, PWA/service-worker scope, Next.js Pages Router concepts. Use when you need to understand WHY code in lib/ or pages/ is shaped the way it is, verify a signature formula, or understand the protocol behind a 403/401 AFTER debugging-playbook's triage points here — this skill is theory only, with no symptom→fix flow. Not for step-by-step operations (see run-and-operate), live triage (see debugging-playbook), or env setup (see config-and-env)."
---

# Reference: the external contracts this app is built on

Theory and contract knowledge only — what bunny.net, Auth0, Upstash, the Push API,
player.js, and Next.js Pages Router each promise, and exactly how THIS repo uses
those promises. Facts marked **[repo]** are verified against this repo's code as of
2026-07-18. Facts marked **[vendor]** are vendor-documented conventions the code
relies on but which cannot be proven from the repo alone.

**When NOT to use this skill:**

| You want to… | Go to |
|---|---|
| Run, deploy, provision, or operate anything | `.claude/skills/run-and-operate/SKILL.md` |
| Triage a live failure symptom | `.claude/skills/debugging-playbook/SKILL.md` |
| The authoritative Redis data-model inventory | `.claude/skills/architecture-contract/SKILL.md` |
| Env var setup, values, and traps | `.claude/skills/config-and-env/SKILL.md` |
| Inspect live state with scripts | `.claude/skills/diagnostics-and-tooling/SKILL.md` |
| Prove a security property | `.claude/skills/security-analysis-toolkit/SKILL.md` |

## Glossary (each term defined once, used throughout)

| Term | Meaning |
|---|---|
| **TUS** | An open resumable-upload protocol over HTTP (tus.io). Bunny's `tusupload` endpoint speaks it; the browser uses `tus-js-client` to stream files in resumable chunks. |
| **VAPID** | Voluntary Application Server Identification — a public/private ECDSA keypair that identifies YOUR server to browser push services, so only you can push to subscriptions created against your public key. |
| **GSSP** | `getServerSideProps` — a Next.js Pages Router function exported from a page file; runs on the server per request, its return value becomes the page's props. |
| **SSR** | Server-side rendering — HTML produced on the server per request (what GSSP pages do). |
| **JWT / claim** | JSON Web Token / a named field inside it (e.g. `email`, `email_verified`). Auth0's ID token claims end up on `session.user`. |
| **base64url** | Base64 with `+`→`-`, `/`→`_`, and padding `=` stripped — safe to put in URLs without percent-encoding. |
| **unix seconds** | Seconds since 1970-01-01 UTC: `Math.floor(Date.now() / 1000)`. `Date.now()` alone is MILLIseconds — a classic off-by-1000x bug source (see §1.4). |
| **CDN** | Content delivery network — here, Bunny's edge servers at `BUNNY_CDN_HOSTNAME` serving thumbnails. |
| **PWA** | Progressive Web App — a website installable like an app (needs a manifest + a service worker). |
| **Service worker (SW)** | A background script the browser runs per origin; can intercept fetches, cache, and receive push events. |

---

## 1. bunny.net Stream

### 1.1 API surface this app uses — [repo] `lib/bunny.js`

All management calls go to `https://video.bunnycdn.com/library/{BUNNY_LIBRARY_ID}{path}`
with header `AccessKey: BUNNY_API_KEY` (`lib/bunny.js` lines 7–28). Server-side
only; the key never reaches the client. Env values are `.trim()`ed because a stray
newline pasted into Vercel corrupts TUS signatures (see change-control skill).

| Function (`lib/bunny.js`) | Method + path | Notes |
|---|---|---|
| `listVideos({page, perPage, search, collection})` | GET `/videos?page=&itemsPerPage=&orderBy=date[&search=&collection=]` | Max 100/page used by the app |
| `getVideo(id)` | GET `/videos/{id}` | |
| `createVideo(title, collectionId)` | POST `/videos` body `{title[, collectionId]}` | Returns `{guid, ...}` |
| `updateVideo(id, fields)` | POST `/videos/{id}` | Bunny uses POST, not PATCH, for updates |
| `deleteVideo(id)` | DELETE `/videos/{id}` | |
| `listCollections()` | GET `/collections?page=1&itemsPerPage=100&orderBy=date` | |
| `createCollection(name)` / `deleteCollection(id)` | POST `/collections` / DELETE `/collections/{id}` | |
| `getStatistics({dateFrom, dateTo})` | GET `/statistics?dateFrom=&dateTo=` | Used by `/api/admin/analytics` |

Non-2xx responses throw `Bunny {method} {path} → {status} {first 200 chars}` —
that string in a log means the Bunny management API, not a signing problem.

### 1.2 Video status lifecycle — [repo] comment + helpers in `lib/bunny.js`; meanings are [vendor]

| Status | Meaning | `isPlayable` | `isFailed` | `isEncoding` |
|---|---|---|---|---|
| 0 | created (no file yet) | no | no | yes |
| 1 | uploaded | no | no | yes |
| 2 | processing | no | no | yes |
| 3 | transcoding (first rendition ready — already watchable) | **yes** | no | yes |
| 4 | finished | **yes** | no | no |
| 5 | encoding error | no | **yes** | no |
| 6 | upload failed | no | **yes** | no |

Repo-verified predicates: `isPlayable = status 3|4`, `isFailed = 5|6`,
`isEncoding = 0..3` (`lib/bunny.js` lines 122–124). Note status 3 is deliberately
in BOTH `isPlayable` and `isEncoding` — a transcoding video plays and is still
being worked on. `/api/videos` filters the homepage to `isPlayable`; push
announcements (`lib/push.js shouldAnnounce`) require exactly status 4 plus upload
within 48h.

### 1.3 The THREE signing schemes — do not mix them up

Three independent HMAC-less signature schemes, all `SHA256` over a plain string
concatenation, all expiring in **unix seconds** — but different inputs, different
input ORDER, different output encodings, different keys, different endpoints.
Formulas are [repo] (this code produces them); that Bunny accepts them is [vendor].

| # | Purpose | Function | Formula (concatenation order matters) | Output encoding | Key | Default TTL | Goes to |
|---|---|---|---|---|---|---|---|
| a | Embed playback | `signedEmbedUrl(videoId)` | `SHA256(BUNNY_TOKEN_AUTH_KEY + videoId + expires)` | **hex** | Token Auth key | 4 h | `https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}?token=…&expires=…&autoplay=false&preload=false` |
| b | Thumbnail CDN | `thumbnailUrl(video)` | `SHA256(key + path + expires)` where `path = /{guid}/{thumbnailFileName \|\| 'thumbnail.jpg'}` | **raw digest → base64url** (`+`→`-`, `/`→`_`, strip `=`) | `BUNNY_CDN_TOKEN_KEY`, falling back to `BUNNY_TOKEN_AUTH_KEY` | 12 h | `https://{BUNNY_CDN_HOSTNAME}{path}?token=…&expires=…` |
| c | TUS upload | `tusAuth(videoId)` | `SHA256(libraryId + apiKey + expire + videoId)` | **hex** | the API key itself | 6 h | headers `AuthorizationSignature`, `AuthorizationExpire`, `VideoId`, `LibraryId` against `https://video.bunnycdn.com/tusupload` |

Degradation rules in `thumbnailUrl` [repo]: returns `null` if `BUNNY_CDN_HOSTNAME`
or `video.guid` is missing; returns an **unsigned** URL if no token key is set
(only safe when "Block Direct URL File Access" is off in Bunny).

Upload flow [repo]: `pages/api/admin/upload.js` calls `createVideo` then `tusAuth`
and returns `{videoId, endpoint, headers}`; `pages/admin.js` feeds those directly
to `new tus.Upload(file, { endpoint, headers, retryDelays, metadata })`. Video
bytes go browser→Bunny; the server only mints the ticket, and the API key never
leaves it (only its SHA256-derived signature does).

### 1.4 Why signing bugs all look like the same 403

Bunny's verifier recomputes the hash from ITS copy of the inputs and string-compares.
Any mismatch — wrong concatenation order, wrong key, hex vs base64url, `expires`
in milliseconds, a trailing newline in the key, a `+`/`/` left unconverted, padding
`=` kept — produces the same opaque rejection (embed: black player / "not
authorized"; CDN: 403; TUS: 401). There is no "which byte differed" feedback.
Consequences:

- **Never guess; diff the recipe.** Compare the exact concatenation order and
  encoding against the table above. Order swaps (e.g. `videoId + key + expires`)
  are the most common silent mistake.
- **Unix seconds, not milliseconds.** `Date.now()` is ms. Passing ms as `expires`
  makes the token "valid" for ~55,000 years but the hash still verifies only if
  BOTH sides used the same number — Bunny compares the literal query/header value,
  so a self-consistent ms token may work until Bunny bounds-checks, and a mixed
  s/ms computation never works. This repo always uses `Math.floor(Date.now() / 1000)`.
- **Trailing whitespace in keys** is invisible in the Vercel UI; `lib/bunny.js`
  defensively `.trim()`s every Bunny env var for exactly this reason.
- Scheme (b) hashes the **path with a leading slash and no query string**; adding
  the query or omitting the slash breaks it.
- Scheme (b) is the only one that base64url-encodes the RAW digest. Hex-encoding
  it, or base64url-encoding the hex string, both fail identically.
- [vendor] Bunny's CDN token auth also supports IP-locking and directory tokens;
  this app uses only the simple `key + path + expires` form.

`signedEmbedUrl` is minted fresh in every GSSP render of `/watch/[id]` and
`/s/[id]` — there is never a stored/permanent playback URL [repo].

---

## 2. Auth0 v4 SDK (`@auth0/nextjs-auth0` ^4.25.0)

Version is [repo] (`package.json`). The v3→v4 differences below are [vendor]
(SDK migration guide) but their v4 side is visible in this repo's code.

### 2.1 What changed from v3 that bites people

| v3 (old tutorials/StackOverflow) | v4 (this repo) |
|---|---|
| Routes auto-mounted at `/api/auth/login` etc. via a catch-all API route you create | Routes live at **`/auth/login`, `/auth/logout`, `/auth/callback`, `/auth/profile`** and exist ONLY because `middleware.js` calls `auth0.middleware(request)` — there is no `pages/api/auth/` file at all [repo] |
| `AUTH0_BASE_URL` | **`APP_BASE_URL`** (exact site URL, no trailing slash) |
| `AUTH0_ISSUER_BASE_URL` (with `https://`) | **`AUTH0_DOMAIN`** (bare host, **no scheme** — `your-tenant.us.auth0.com`) |
| `handleAuth()` / `withPageAuthRequired` helpers | Bare `new Auth0Client()` (`lib/auth0.js`), guards hand-rolled in `lib/guard.js` |

If you see a 404 on `/api/auth/login`, or login loops, you are following v3 docs.
The links the app renders are `/auth/login?returnTo=…` [repo: `pages/index.js`,
`pages/watch/[id].js`, `pages/s/[id].js`].

### 2.2 How this repo consumes the session — [repo]

- `lib/auth0.js` exports `auth0 = new Auth0Client()` — zero-argument, fully
  env-driven (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`,
  `AUTH0_SECRET`, `APP_BASE_URL`), kept minimal to stay edge-runtime-compatible
  for middleware.
- **Pages Router read pattern:** `await auth0.getSession(req, res)` — both args,
  in GSSP and in API routes (via `lib/guard.js getSessionEmail`). `session` is
  `null`/undefined when not signed in; GSSP pages redirect to
  `/auth/login?returnTo=…`, API guards return 401/403 JSON.
- The session lives in an **encrypted cookie** keyed by `AUTH0_SECRET` [vendor:
  encryption; repo: README "Random 32-byte hex string encrypting the session
  cookie"]. Changing `AUTH0_SECRET` invalidates every live session. The middleware
  call also **rolls** (refreshes) the session cookie on every matched request
  [repo comment in `middleware.js`; rolling behavior itself is vendor-documented].
- **Claims:** identity claims from the ID token surface on `session.user`. This
  code reads exactly `session.user.email` (then `normalizeEmail`s it — trim +
  lowercase, `lib/auth.js`) and `session.user.name` (fallback to email,
  `pages/watch/[id].js`). **`email_verified` is present on `session.user` for
  standard Auth0 connections [vendor] but is NOT checked anywhere in this repo —
  `grep -rn email_verified pages lib` returns nothing [repo].** This is a
  documented open gap (FEATURES.md "Known gaps"); the mitigation today is that
  Auth0 sign-ups are disabled tenant-wide. Enforcement is the subject of
  `.claude/skills/campaign-email-verified/SKILL.md` — do not claim it is enforced.

### 2.3 Middleware matcher — [repo] `middleware.js`

The matcher runs `auth0.middleware` on **everything except** `_next/static`,
`_next/image`, `favicon.ico`, `robots.txt`, `sitemap.xml`,
`manifest.webmanifest`, `sw.js`, and the four icon files. Rationale: PWA assets
must be fetchable by an unauthenticated installer/browser and must not receive
rolled-session Set-Cookie responses. If you add a public static asset, you must
add it to this matcher or it will be intercepted.

---

## 3. Upstash Redis REST client (`@upstash/redis` ^1.38.0)

### 3.1 Transport model — [vendor], relied on throughout

Each command is one HTTPS request to `KV_REST_API_URL` authenticated by
`KV_REST_API_TOKEN` (fallback names `UPSTASH_REDIS_REST_URL/TOKEN` — [repo]
`lib/redis.js`). No TCP connection, no pooling, no connect/disconnect lifecycle —
which is exactly why it is safe in serverless functions that freeze between
invocations. Corollary: every command is a full HTTP round-trip, so N commands =
N requests; this app keeps per-request command counts small (e.g. `Promise.all`
of two GETs in `/api/videos`).

The client is constructed lazily on first use (`lib/redis.js`) so importing the
module never requires env vars at build time [repo].

### 3.2 Automatic JSON (de)serialization and the defensive-parse idiom — [repo]

The client JSON-serializes non-string values on write and *attempts* to
JSON-parse values on read [vendor]. Consequence: **a read may return an object OR
a string** depending on how/when the value was written (other clients, older
data, double-stringified writes). This codebase therefore writes objects directly
(`redis().set(k('theme'), theme)`, `hset` with object values) and ALWAYS reads
through a both-shapes guard. The canonical pattern (`pages/api/progress.js`,
same shape in `lib/audit.js`, `lib/push.js`, `pages/watch/[id].js`):

```js
const entry = typeof value === 'string' ? safeParse(value) : value; // safeParse = try JSON.parse, else null
```

Never write a new reader that assumes one shape. Note `lib/audit.js` writes
pre-stringified JSON (`lpush(k('audit'), JSON.stringify(...))`) and its reader
still handles both — that asymmetry is deliberate belt-and-braces.

### 3.3 Command subset actually used — [repo]

Every key goes through `k(name)` → **`fable2:` prefix** (`lib/redis.js` line 19 —
the comment above it still says `pvp:` and is stale; the code is authoritative).
Authoritative key inventory: architecture-contract skill. This table is
command-semantics-oriented:

| Command | Semantics | Used for (file) |
|---|---|---|
| `get` / `set` | Whole-value read/write; `set(key, obj, { ex: seconds })` sets TTL atomically with the value | `settings:homeCount`, `order` (JSON array), `theme`; `share:<id>` with `{ ex: ttl }` (`pages/api/admin/share.js`, `pages/s/[id].js`) |
| `ttl` | Remaining TTL in seconds (-1 no expiry, -2 no key) | Preserving share expiry when stamping `viewedAt`: read `ttl`, re-`set` with `{ ex: ttl }` (`pages/s/[id].js`) |
| `sadd` / `srem` / `sismember` / `smembers` | Unordered unique set. `sadd` returns the number of NEWLY added members — `added === 1` is the atomic once-only guard in `lib/push.js announceNewVideos` | `viewers` allowlist (`lib/guard.js` `sismember === 1`), `shares` index, `push:announced` |
| `hset` / `hget` / `hgetall` / `hdel` | Hash field ops; `hset` takes `{ field: value }` objects | `viewer:lastseen` (email→ISO), `progress:<email>` (videoId→JSON), `push:subs` (endpoint→JSON) |
| `lpush` / `ltrim` / `lrange` | List as capped log: `lpush` newest-first then `ltrim 0..199` caps at 200 | `audit` (`lib/audit.js`) |
| `del` | Delete key | Revoking a share (`pages/api/admin/shares.js`) |

### 3.4 `@upstash/ratelimit` sliding window — [repo] `lib/ratelimit.js`; algorithm [vendor]

`Ratelimit.slidingWindow(limit, "60 s")` approximates a rolling window by
weighting the previous fixed window's count against the current one — smoother
than fixed windows (no burst-at-boundary), cheaper than a true log. State lives
under prefix `fable2:rl`. This repo memoizes one `Ratelimit` per
`(limit, window)` pair and identifies callers as `` `${name}:${id}` `` (id =
normalized email). **`allowRequest` fails OPEN** — any thrown error returns
`true`. Never invert this (see change-control skill). Endpoints and budgets:
`/api/videos` 60/min/email, `/api/admin/upload` 20/hour, `/api/admin/share`
10/min [repo] (canonical inventory: architecture-contract).

---

## 4. Web Push / VAPID

### 4.1 The model — [vendor], shape visible in [repo]

A push **subscription** is per-browser-per-device: the browser's push service
(FCM, Mozilla autopush, Apple) mints a unique HTTPS **endpoint** URL plus
encryption keys. Your server POSTs an encrypted payload to that endpoint (the
`web-push` npm package does the VAPID JWT + payload encryption); the push service
wakes the device's service worker with a `push` event. One user with three
browsers = three subscriptions. That is why `push:subs` is a HASH keyed by
**endpoint** (not email), with the value carrying `{ sub, email, addedAt }`
[repo: `pages/api/push/subscribe.js`].

**VAPID keys:** the private key (`VAPID_PRIVATE_KEY`) signs each push request;
the public key is given to the browser at subscribe time as
`applicationServerKey`, binding the subscription to this server. Rotating the
keypair silently orphans every existing subscription — they must re-subscribe.

### 4.2 Why the public key is `NEXT_PUBLIC_` — [repo]

`components/NotifyButton.js` reads `process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY` in
client code. Next.js string-replaces `NEXT_PUBLIC_*` values into the JS bundle
**at build time** (§7.4). So changing the key requires a redeploy/rebuild, not a
restart, and the server-side `pushEnabled()` check (`lib/push.js`) requiring BOTH
keys guards against a half-configured state. The button converts the base64url
key to a `Uint8Array` before `pushManager.subscribe` — a browser API requirement
[vendor].

### 4.3 `userVisibleOnly: true` — [vendor], set in [repo]

`NotifyButton.js` subscribes with `userVisibleOnly: true`: a promise to the
browser that every push shows a visible notification (no silent data pushes).
Chrome REQUIRES it — subscribe rejects without it. The SW honors the promise:
its `push` handler always calls `showNotification` (`public/sw.js`).

### 4.4 The 404/410 dead-endpoint convention — [repo] `lib/push.js`

When a user revokes permission or the subscription expires, the push service
answers `404` or `410 Gone` [vendor convention]. `sendToAll` treats exactly those
two status codes as "dead" and prunes the entry (`hdel` by endpoint,
best-effort). All other errors are swallowed WITHOUT pruning — a transient 5xx
must not delete a live subscription. Additional repo-verified send-side rules:
recipients are filtered to currently-allowed emails at send time (removing a
viewer stops their pushes even with a lingering device subscription —
`eligibleSubs`), and announcements fire only for status-4 videos uploaded within
48h, gated once-ever per guid by the atomic `sadd(k('push:announced'))`.

---

## 5. player.js — the embed control protocol

`player.js` (^0.1.0, [repo] `package.json`) is a vendor-neutral **postMessage
protocol**: the parent page and the iframe exchange JSON messages
(`window.postMessage`), so the parent can control a cross-origin player it cannot
script directly. Bunny's `iframe.mediadelivery.net` embed speaks it [vendor].

What this repo uses — [repo] `components/ResumablePlayer.js`:

| Protocol feature | Use here |
|---|---|
| `new playerjs.Player(iframeEl)` | Handshake with the Bunny embed iframe |
| `ready` event | Gate: nothing is sent before the embed answers the handshake |
| `setCurrentTime(seconds)` | Resume — called once on `ready`, only when saved position > 5 s |
| `timeupdate` event `{seconds, duration}` | Progress reporting — throttled client-side to one POST `/api/progress` per 5 s; events with no `duration` are ignored |

**Graceful-degradation contract (load-bearing):** the iframe `src` is the signed
embed URL; playback needs nothing from player.js. The dynamic
`import('player.js')` and handshake sit in try/catch, `setCurrentTime` is
wrapped, and progress POSTs `.catch(() => {})`. If the embed stops speaking the
protocol (Bunny change, CSP, blocked script), video still plays — only
resume/history silently stop. Keep any change to this component inside that
posture. The interop shim `mod.default && mod.default.Player ? mod.default : mod`
handles the package's CJS/ESM ambiguity — don't "simplify" it away.

---

## 6. PWA essentials as used here

- **Manifest** (`public/manifest.webmanifest`, [repo]): name, `start_url: "/"`,
  `display: "standalone"`, theme/background `#0b1120`, icons 192/512/SVG +
  maskable. Linked from `pages/_document.js`. This + a registered SW is what
  makes the browser offer "install".
- **Registration & scope** ([repo] `pages/_app.js`): `navigator.serviceWorker.register('/sw.js')`.
  A SW's scope defaults to its URL's directory [vendor] — served from `/sw.js`,
  it controls the whole origin. That is why it MUST live in `public/` (root),
  and why `sw.js` (and the manifest + icons) are excluded from the auth
  middleware matcher (§2.3).
- **Why the SW caches ONLY icons + manifest** ([repo] `public/sw.js`): the asset
  list is exactly the manifest + 4 icons; every other request "goes straight to
  the network" (its fetch handler simply doesn't respond for them). Rationale:
  every meaningful page here is authed and per-user, embed/thumbnail URLs are
  short-lived signed tokens, and caching any of that would serve stale/leaky
  content or dead tokens. Cache name `pvp-static-v1` is a client-side artifact
  name — legitimately still `pvp` despite the Redis `fable2:` rename; bump the
  suffix to invalidate installed clients' caches.
- **Push wiring** ([repo] `public/sw.js`): `push` → `showNotification` with
  `data.url`; `notificationclick` → focus an existing window and navigate, else
  `openWindow(url)`.

---

## 7. Next.js Pages Router specifics (v16, [repo])

This is the **Pages** Router (`pages/` directory) — most current Next.js docs
describe the App Router (`app/`); their APIs do not apply here.

1. **GSSP vs API routes.** A page exporting `getServerSideProps` runs it
   server-side per request; return `{ props }`, `{ redirect }`, or
   `{ notFound: true }`. Files under `pages/api/**` are plain
   `(req, res) =>` HTTP handlers returning JSON. Same-origin cookies (the Auth0
   session) are available to both. This repo's split: pages do auth-redirects +
   initial data (`/`, `/watch/[id]`, `/s/[id]`, `/admin`); API routes do
   everything the client fetches afterwards. Admin gating is deliberately
   two-layer: the `/admin` GSSP redirect AND an independent `requireAdmin` 403 in
   every `/api/admin/*` route — never rely on only one.
2. **Middleware** (`middleware.js` at repo root) runs on the edge runtime before
   routing, for every URL its `config.matcher` matches (§2.3). Here it exists
   solely to mount Auth0 (§2.1) and roll sessions.
3. **`_app.js`** wraps every page render: global CSS import, theme fetch/apply,
   SW registration, idle-timeout mount. **`_document.js`** is the HTML shell,
   rendered server-side only: manifest/icon links, fonts, and the inline
   pre-paint theme script (no event handlers or browser APIs belong there).
4. **`NEXT_PUBLIC_*` build-time inlining.** At `next build`, references to
   `process.env.NEXT_PUBLIC_X` in client code are replaced with the literal
   value. Changing such a var in Vercel does nothing until the next build; there
   is exactly one in this repo (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, §4.2).
   Server-only vars (all the rest) are read at request time, so a redeploy with
   the same build would pick those up.
5. **Dynamic routes**: `pages/watch/[id].js` → `params.id`; both dynamic pages
   regex-validate `id` before using it [repo].

---

## Provenance and maintenance

Derived 2026-07-18 by reading the code: `lib/bunny.js`, `lib/auth0.js`,
`lib/auth.js`, `lib/guard.js`, `lib/redis.js`, `lib/audit.js`, `lib/ratelimit.js`,
`lib/push.js`, `middleware.js`, `components/ResumablePlayer.js`,
`components/NotifyButton.js`, `pages/_app.js`, `pages/_document.js`,
`pages/watch/[id].js`, `pages/s/[id].js`, `pages/admin.js`,
`pages/api/videos.js`, `pages/api/progress.js`, `pages/api/push/subscribe.js`,
`pages/api/admin/upload.js`, `public/sw.js`, `public/manifest.webmanifest`,
`package.json`, README.md. Everything marked [vendor] is external-API convention
consistent with, but not provable from, this repo.

Re-verify before trusting, if code may have drifted:

```bash
grep -n "sha256Hex\|base64\|expires\|expire" lib/bunny.js        # all three signing formulas + TTLs
grep -n "status === " lib/bunny.js lib/push.js                    # lifecycle predicates
grep -n "auth0.middleware\|matcher" middleware.js                  # v4 mounting + matcher exclusions
grep -rn "getSession" lib pages                                    # session read sites
grep -rn "email_verified" pages lib components                     # still expected: NO matches
grep -n "fable2" lib/redis.js                                      # key prefix (comment above is stale)
grep -n "typeof .* === 'string'" lib/audit.js lib/push.js pages/api/progress.js  # defensive-parse idiom
grep -n "slidingWindow\|return true" lib/ratelimit.js              # fail-open rate limiting
grep -n "404\|410" lib/push.js                                     # dead-endpoint pruning
grep -n "userVisibleOnly\|NEXT_PUBLIC_VAPID" components/NotifyButton.js
grep -n "ASSETS\|CACHE" public/sw.js                               # SW cache scope
grep -n "auth0\|bunny\|upstash\|player.js\|tus" package.json       # dependency versions
```
