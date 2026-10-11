---
name: architecture-contract
description: "The load-bearing design decisions of Marine Video Portal, WHY each was made, the invariants that must stay true (with enforcement points), the authoritative Redis data-model inventory, and the honest list of known weak points. Use when changing auth/guards, signing, Redis keys, adding an API route or page, or judging whether a change breaks a security/availability guarantee. PAIRS WITH security-analysis-toolkit — this skill states the invariants; that one holds the proof methods. Load BOTH when adding or changing a route. Not for how-to-run (see run-and-operate), env vars (see config-and-env), debugging symptoms (see debugging-playbook), or vendor API theory (see reference)."
---

# Architecture Contract — Marine Video Portal

This is the contract a change must not break. Every claim below was verified
against the code on 2026-07-18 (file:line given). If a cited line has moved,
re-verify with the commands in "Provenance and maintenance" before trusting it.

Vocabulary (used throughout, defined once):

- **Viewer** — an email address in the Redis SET `fable2:viewers`, added by an admin.
- **Owner** (was "Admin") — an email address in the `ADMIN_EMAILS` env var
  (comma-separated). Holds every capability, always, resolved without Redis.
- **Capability** — one of the 13 strings in `lib/capabilities.js`'s catalog
  (e.g. `videos.upload`, `shares.manage`); each names a real enforcement point.
- **Role** — an admin-defined, Redis-stored named set of capabilities, assigned
  per email. **Staff** = an owner or anyone holding ≥ 1 capability.
- **Guard** — one of `requireCapability` / `requireViewer` in `lib/guard.js`; an
  API route calls it first and returns immediately if it yields null.
  (`requireAdmin` was removed 2026-08-30 — every admin route names a capability.)
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

### 1.1 Access control is normalized-email identity; roles layer on top of it

- There is still no user table. Identity IS the lowercased, trimmed email from
  the Auth0 session (`lib/auth.js:5-7` `normalizeEmail`), and every stored
  record — viewers, roles, groups — is keyed by that string. **Updated
  2026-08-30**: a capability layer now sits on top of it. Owners = membership in
  `ADMIN_EMAILS` (`lib/auth.js:9-20`), who hold the entire capability catalog
  by definition and are resolved from the env var with **no Redis read**;
  role-holders = emails with entries in `fable2:user:roles`, whose capabilities
  are the union of their roles and **fail closed to none**; viewers =
  membership in the Redis SET `fable2:viewers`. The catalog itself
  (`lib/capabilities.js`) is defined in code, never in Redis — each string
  names a real enforcement point, so a hand-written capability grants nothing.
- WHY: a private portal for a small invited audience needs exactly one
  question answered — "is this email on the list?" — and email is the unit
  admins actually think in (they invite people by email, share links by email).
  No schema, no migrations, no ID↔email mapping to drift. The role layer keeps
  that property: it answers "which capabilities does this email have", never
  "which user id is this", so nothing about identity resolution changed.
- WHY the owner set stays in the env var: an admin-writable owner list is a
  bigger prize than an env var, and self-lockout (removing the last admin) is
  unrecoverable from inside the UI. Keeping owners env-only makes both failures
  structurally impossible rather than merely guarded. Redis can only ADD
  privilege; the **no-escalation rule** (`canDelegate`, `lib/capabilities.js`)
  caps how far a delegated `roles.manage` can spread it — an actor may only
  create, edit, delete or assign a role whose capabilities are a subset of
  their own.
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
  `pages/s/[id].js` (login redirect + recipient match + active-share check),
  `pages/b/[id].js` (same pattern, one level up: recipient match against a
  bundle's `email` field — **new 2026-07-21**).
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
| I1b | Every site that reads the session email claim goes through `trustedEmail`, never `session.user.email` directly (**new 2026-08-31**) | `lib/auth.js` `trustedEmail` (`email_verified !== true` → `''`); the 8 call sites: `lib/guard.js:14`, `pages/index.js`, `pages/admin.js`, `pages/watch/[id].js`, `pages/activity.js`, `pages/s/[id].js`, `pages/b/[id].js`, `pages/api/share-event.js`. Verify: `grep -rnE "user\??\.email" pages lib \| grep -v __tests__ \| grep -v trustedEmail` → display-only hits | A new surface reading the raw claim silently opts out of verification enforcement while looking correct |
| I1 | Every email comparison goes through `normalizeEmail` | `lib/auth.js:5-7`; used at every check site: `lib/guard.js:7`, `lib/auth.js:12,17`, `pages/index.js:14`, `pages/watch/[id].js:20`, `pages/admin.js:24`, `pages/s/[id].js:20,31`, `pages/api/admin/viewers.js:36,58`, `pages/api/admin/share.js:52`, `lib/push.js:23-25,54` | Case/whitespace variants of one email become distinct identities: viewers stored as `Bob@X` never match session `bob@x`; share links unusable by their own recipient |
| I2 | Every `/api/admin/*` route calls `requireCapability` **first**, naming the capability it needs, and returns on null | All 20 routes (**updated 2026-08-30**, was 18 on `requireAdmin`): analytics + viewer-activity → `analytics.read`; audit → `audit.read`; broadcast → `broadcast.send`; share, shares-bulk, bulk-share, private-list → `shares.manage`; shares → `shares.read`/`shares.manage` by method; cleanup, settings → `settings.manage`; order, videos-bulk → `videos.manage`; upload → `videos.upload`; videos, collections → `videos.read`/`videos.manage` by method; viewers → `viewers.read`/`viewers.manage` by method; viewers-bulk → `viewers.manage`; groups → `groups.manage`; roles → `roles.manage`. Plus `POST /api/theme` → `settings.manage`. Verify: `grep -rL "requireCapability" pages/api/admin/*.js` (expect no output) | Any signed-in (or with a broken session check, anonymous) user can upload, delete videos, mint/resend/extend/revoke share links, edit the viewer list — or a staff member with one narrow capability reaches every other admin action |
| I2b | Owners are decided from `ADMIN_EMAILS` alone, with no Redis read; role capabilities fail closed | `lib/guard.js` `resolveActor` → `lib/roles.js` `resolveCapabilities` (owner short-circuits before any Redis call; the non-owner path's `catch` returns `[]`) | A Redis outage or a hand-edited record could demote a bootstrap admin (locking everyone out of /admin permanently) or widen a role-holder's access |
| I2c | An actor may only create, edit, delete or assign a role whose capabilities are a **subset of their own** | `lib/capabilities.js` `canDelegate` / `undelegatableCapabilities`, enforced on every mutating branch of `pages/api/admin/roles.js` (PUT checks the current AND the new set, PATCH checks the union of roles added and removed) | A delegated `roles.manage` becomes a path to every other capability — the privilege-escalation surface that kept in-app admin management off the roadmap |
| I3 | Every viewer-data API calls `requireViewer` (or an explicit documented weaker guard) | `/api/videos` → videos.js:11; `/api/collections` → collections.js:6; `/api/progress` → progress.js:8; `/api/push/subscribe` → subscribe.js:8. Deliberate exceptions: `/api/theme` GET is public (theme.js:6-17 — colors only, POST is requireAdmin at theme.js:20); `/api/push/unsubscribe` needs only a session (unsubscribe.js:8-9 — a de-listed viewer must still be able to silence their device); `/api/share-event` needs only a session, then does its own email-match check against the share record (share-event.js:10-36) — the same non-`requireViewer` pattern as `pages/s/[id].js` and `pages/b/[id].js` themselves, since recipients aren't necessarily approved viewers | Unapproved accounts enumerate the library, read/write watch history, register push devices |
| I3b | Group content gating, when on, is enforced at **all three** viewer content paths — never just the list | `pages/api/videos.js` (`filterVideosByScope`), `pages/api/collections.js` (`filterCollectionsByScope`), `pages/watch/[id].js` GSSP (`isVideoVisible`, after the video is fetched). All read the same `contentScopeFor`, which returns `DENY_SCOPE` on error | Filtering the homepage while leaving `/watch/<guid>` open is not a gate at all — a member reads any guid straight from a URL |
| I3c | A video's publish window is enforced at the list AND at the direct URL, or it is not enforced | `pages/api/videos.js` (`filterVideosBySchedule`, passed the viewer's group ids) and `pages/watch/[id].js` GSSP (`isVideoInWindowFor`), staff bypassing both; the same helper guards transcripts, My List, ratings and feed artwork | Filtering the homepage while `/watch/<guid>` still plays is theatre — and worse, it looks like it works |
| I3d | The THREE UNAUTHENTICATED surfaces deny by default and leak nothing about the library (scheduled jobs are also sessionless, but serve nothing and answer only to a secret — I3f) | `lib/publicWatch.js` (public flag required, store fails closed, publish window applies, identical `notFound` for every refusal), `pages/api/feed/[token].js` (token resolves to one viewer, that viewer's CURRENT access re-checked per fetch, items through the same scope+window pipeline, identical bare 404 for every refusal, `no-store`), and — **added 2026-09-23** — `pages/api/feed/[token]/[file].js`, episode artwork (the same token → approval → playable → scope → window checks per fetch, the same bare 404, a thumbnail file name validated before it becomes a CDN path, and only then a 15-minute signed 302; `npm test -- feedArtwork feedRoute`). A stable route rather than a signed URL in the feed because apps cache art keyed on the URL, and a signed one changes on every refresh. **Verified signed out 2026-09-13**: both return 404 from their own code while `/`, `/admin`, `/watch/<guid>` and `/activity` 307 to `/auth/login` — so no `middleware.js` matcher change was needed | An anonymous visitor could enumerate the library, or a revoked viewer keep a working feed |
| I3e | Per-group windows only ever ADD visibility, and the weekly repeat narrows the DEFAULT window only (**2026-09-24**) | `lib/schedule.js`: `isWithinWindowFor` is the default window (dates AND the repeat, both inside `isWithinWindow`) OR any of the viewer's groups' windows; `lib/scheduleStore.js` `isVideoInWindowFor` reads membership only when the default says no and the video has group windows, and an unreadable membership reads as none; `pages/api/admin/schedule.js` refuses a malformed repeat and a window for a group that does not exist; `DELETE /api/admin/groups` prunes the group's windows (`pruneGroupFromSchedules`). `npm test -- scheduleWindows scheduleStoreWindows scheduleAdminRoute videosScheduleGroups` | Each enforcement point must be handed the viewer's groups and one will be missed; additive windows make that slip withhold an early preview instead of leaking one. A window that could DELAY a video for a group would turn the same slip into a leak — group scopes are the way to hold a video back. Keeping the repeat inside `isWithinWindow` means there is no new call site to forget |
| I3f | A scheduled-job route has no session; `CRON_SECRET` is its whole gate, and it is inert without one (**2026-09-24**) | `pages/api/cron/*` are excluded from `middleware.js`'s matcher (the caller is Vercel's cron runner, with no session to roll), so nothing upstream guards them. `lib/cronAuth.js`: no `CRON_SECRET`, or one under 16 characters → 404 as if the route did not exist; anything but `Authorization: Bearer <CRON_SECRET>` → 401, compared in constant time over digests; GET only. `/api/cron/transcripts` runs the existing collector with a larger per-run cap, audits each video as `scheduled job`, and answers counts only. A Redis lock (`transcribe_collecting`) makes overlapping runs skip. `npm test -- cronTranscriptsRoute collectLock transcriptCollect routeGuards` | A cron route is on the public internet like any other: one that skipped the secret would let anyone trigger bunny calls and audit writes; one that ran when no secret was configured would be open on every deployment that has not set it. Why the pending limit moved from 24h to 3 days: on Hobby the job runs once a day, up to 59 minutes late, so a 24-hour limit could drop a job before any scheduled attempt |
| I3g | Comments are gated like watching, and the author's email never reaches another viewer (**2026-09-24**, owner's decisions) | `pages/api/comments.js`: `requireViewer` → the video must exist → `contentScopeFor`/`isVideoVisible` on every method → the publish window (`isVideoInWindowFor`, staff exempt) on reading and writing, not on deleting your own; every refusal the same 404. The author is the SESSION; no request field names a person. `commentView` (`lib/comments.js`) sends a DISPLAY NAME only (an email-shaped profile name is cut to its local part); the email is added only for an owner or a `viewers.read` holder. Deleting someone else's comment needs ownership or `comments.manage` and is audited (`comment.delete`). Text is refused past 1,000 characters and stripped of control, zero-width and bidi-override characters. `npm test -- comments commentsRoute commentsStore routeGuards` | Comments are the first thing one viewer writes that another reads. Without the scope and window checks the route would be a way to talk about — and probe for — videos a viewer cannot see; showing the email would publish the approved viewer list to every viewer, one comment at a time |
| I3h | A list that means "the library" reads all of it, not bunny's first page (**2026-09-24**) | `listAllVideos()` (`lib/videoLibrary.js`) reads every page — in parallel after the first, de-duplicated by guid — up to 10 pages (1,000 videos) and returns `truncated` past that; a failed page throws rather than answer short. Used by `/api/videos` (plain view, Browse by book, passage title scan), `/api/admin/videos` (the tab shows a notice when truncated), `/api/admin/analytics` and `/api/feed/[token]`. Filters (scope, windows, collection) and the custom order apply BEFORE `homeCount` cuts the list. `/api/admin/order` accepts up to the same 1,000. Title search stays at bunny and reports `truncated` when bunny matched more than one page. `npm test -- videoLibrary wholeLibraryRoutes` | Each of these used to ask for page 1 and stop: the Videos tab had no row for the 101st video, Analytics counted 100, a group granted an older collection saw an empty homepage and feed, and a homepage count above 100 was never honoured. None of it said so |
| I3i | Per-viewer progress is bounded, and a deleted video leaves nothing behind (**2026-09-24**) | `POST /api/progress` is rate-limited (`allowRequest('progress', …, 300, 600)`), accepts only `isProgressVideoId` ids (`lib/progress.js`), and saves through `saveProgress` (`lib/progressStore.js`): one Lua script writes an update or an entry that fits under `MAX_PROGRESS_ENTRIES` (1,000), and only a NEW video at the cap takes the slow path that drops the least recently watched (`progressToEvict`). `forgetVideo` (`lib/videoCleanup.js`) clears the watermark override and the private-list index along with the other per-video rows. `npm test -- progress progressRoute progressStore.redis videoCleanup` | Before, any string up to 100 characters was a valid id with no limit, so one signed-in viewer could grow their own hash without bound; and the watermark row and private-list index were the per-video records a delete did not remove |
| I4 | `BUNNY_API_KEY` is read server-side only, in one place | `lib/bunny.js:11` is the sole reference in the repo; only the derived TUS signature reaches the browser (`pages/api/admin/upload.js:23-25`) | Full read/write control of the Bunny library leaks to any page viewer |
| I5 | Embed URLs are generated per request and never persisted | Call sites (**3 as of 2026-09-13**), all server-side per request: `pages/watch/[id].js`, `pages/s/[id].js`, and `lib/publicWatch.js` (the public route — 'public' means no login, NOT an unsigned or permanent URL); nothing writes an embed URL to Redis or returns one from an API list endpoint (`/api/videos` returns guid/title/length/thumbnail only, videos.js:35-41) | A stored URL becomes an unrevocable bearer credential outliving viewer removal |
| I6 | All Redis access goes through `redis()` and all keys through `k()` | `new Redis` exists only in `lib/redis.js:10`; no literal `fable2:`/`pvp:` key string exists outside `lib/redis.js` (the two remaining `pvp` strings are client-side names, not Redis keys: `lib/theme.js:20`, `public/sw.js:7`) | Split-brain state across prefixes; a second client with different env fallbacks silently targets another database |
| I7 | Share-mismatch responses never reveal the intended recipient | `pages/s/[id].js` returns only `state: 'mismatch'`, no address in the rendered copy; `pages/b/[id].js` follows the identical pattern for bundles. A dead link — revoked, expired, or never existed — always renders the same "gone" state too, so it never leaks *which* kind of dead it is (`lib/share.js` `isShareActive`) | A share link or bundle page becomes an oracle for harvesting who was invited to what, or whether a specific link was revoked vs merely expired |
| I8 | The service worker touches only the 5 public static asset URLs — never authed pages, API responses carrying user data, or video. (**Updated 2026-09-03**: two strategies now, not one. `PRECACHE_ASSETS` — the 4 icons — stay cache-first, being immutable per deploy. `NETWORK_FIRST_ASSETS` — `/manifest.webmanifest`, generated by `pages/api/manifest.js` behind a rewrite so the URL is unchanged — is network-first with the cached copy as offline fallback, because it carries the admin-set site name and cache-first pinned installed apps to their install-time name. `CACHE` bumped to `pvp-static-v2` so the activate handler evicts manifests stored under the old rule.) | `public/sw.js:10,17,19` (the two allowlists) and `public/sw.js:39-67` (fetch handler responds only for allowlisted same-origin paths; everything else goes to network) | Protected content persists in cache storage on shared machines after logout; stale API data served offline |
| I9 | Guards fail CLOSED; the rate limiter fails OPEN — never swap these | Closed: `lib/guard.js:32-34`; open: `lib/ratelimit.js:27-29` | Swapped one way: Redis outage grants access to everyone. Swapped the other: Redis outage takes the whole portal down |
| I10 | Share IDs are unguessable and expire server-side | `lib/share.js` `createShare` (18 random bytes, base64url ≈ 144 bits), clamped 1–720h. **Updated 2026-07-21**: expiry is now decided by the stored `expiresAt` field, not by Redis TTL absence — the Redis record deliberately outlives `expiresAt` by a 60-day grace window (`GRACE_SECONDS`) so an expired-but-not-revoked link can still be **extended**. Every read path (`isShareActive`, used by `pages/s/[id].js`, `pages/api/share-event.js`, `pages/b/[id].js`) checks `expiresAt`/`revokedAt` explicitly instead of treating "record exists" as "usable" | Guessable/eternal links defeat recipient-locking; if a read path skipped the explicit check it would serve an already-expired link during its grace window |
| I16 | A staff group limit only ever NARROWS — and never leaves a viewer in no group (**2026-09-25**) | `lib/guard.js` `resolveActor` reads `fable2:user:scope` for any non-owner holding a capability: a limit strips `GLOBAL_CAPABILITIES` (settings, roles, audit, broadcast) and sets `contentScope` to what the limit's existing groups grant (`contentOfScope`, never `unrestricted`); a failure reading it leaves NO capabilities. `lib/groups.js` `contentScopeFor` gives a limited staff member that content on the viewer side (`DENY_SCOPE` on error). Every non-portal-wide admin route resolves the caller with `requireActor` and checks the video, person, share or group it touches (`lib/staffScopeRules.js`, `lib/staffScope.js`). Rules: never edit a group, collections, the order or a public flag; approve only INTO one's groups, membership written BEFORE the SADD; never remove anyone's last group; removing a person or deleting a video needs every group involved in scope; only unlimited `roles.manage` holders set limits, owners never limited; a limit needs `GROUP_CONTENT_GATING=1` to be set. A static test fails CI for a new admin route that neither is portal-wide nor checks the limit. `npm test -- staffScope scopedStaffRoutes` | A limit the limited person could escape, or one that failed toward "unlimited", reads as a boundary while not being one — worse than no limit |
| I14 | A route that reveals or edits PEOPLE requires the people capability, whatever else it manages (**new 2026-09-20**) | `/api/admin/groups` is gated on `groups.manage`, but the member addresses and the `email → [groupId]` map in GET, and the `set-members`/`set-groups` actions on PATCH, additionally require `viewers.read` (owners bypass, as everywhere). A groups-only manager gets `memberCount` and no addresses. `requireCapability` returns the EMAIL, not the actor, so the route re-resolves via `resolveActor` — reading only `capabilities` would also lock an owner out. Writing needs nothing beyond `groups.manage`: that holder can already change what members see by editing the scope or deleting the group; what membership adds is visibility of people. Verify: `npm test -- groupMembership` | Until this check existed, a delegated `groups.manage` received every group's member addresses and the whole membership map — the approved viewer list, from a capability whose label only promises groups. The per-address refusal ("not an approved viewer") is that same list, one address at a time |
| I15 | An admin-uploaded file served to everyone is a PNG, checked by its bytes (**new 2026-09-24**) | The admin-set app icon is the one piece of admin-uploaded content served from this origin to anyone, pre-login (`/api/app-icon/<size>`, excluded from the middleware matcher with the other PWA assets). `lib/appIcon.js` accepts only a PNG — by signature and IHDR header, never a declared type — of EXACTLY the size it is filed under, under a byte cap; it is served as `image/png` with `nosniff` and `default-src 'none'`. The browser resizes; the server trusts none of it. In `k('app_icon')` the version is written LAST and cleared FIRST, and letter-prefixed because Upstash JSON-parses all-digit strings. Verify: `npm test -- appIcon appIconRoutes manifest feedRoute` | "It is only an icon" is how an SVG carrying a script ends up executing on the site's own origin. Do not widen the accepted types to SVG, and never let the declared type decide |
| I13 | Per-viewer data is keyed by the VIEWER, and aggregates derived from it hold no identity and EQUAL it (**new 2026-09-19**, totals made exact **2026-09-23**) | `progress:{email}`, `mylist:{email}`, `ratings:{email}` — anything recorded about a person carries their email in the KEY, never as a field under the thing it is about, so deleting a person's data is one key per feature. **That deletion does not run today** — viewer removal clears tags, roles, groups and the feed token only (FEATURES.md known gaps); do not describe removal as deleting their data until it does. `rating_counts` holds `guid:up`/`guid:down` integers and no address, and is written in the SAME Redis script as the vote (`VOTE_SCRIPT`, `lib/ratingScripts.js`), which reads the previous vote inside itself — so a total cannot drift from the votes and two racing clicks cannot both count. `lib/ratings.js` `voteDelta` is the specification the script is tested against. Drift from before is corrected by `RECOUNT_SCRIPT` via *Recount ratings* (`/api/admin/rating-recount`, `SETTINGS_MANAGE`). Do NOT reintroduce a separate counter write. `clearVideoRatingCounts` on video delete. Verify: `npm test -- ratings ratingRoute ratingScripts ratingsStore.redis ratingRecountRoute` (`ratingScripts` and `ratingsStore.redis` need `redis-server`: skipped locally without one, FAILS under CI without one) | A hash keyed by video with the email as a field reads better and makes totals one HGETALL — and scatters a person's address across a row per video that nothing cleans |
| I12 | A GENERATED suggestion is never a stored value — the AI proposes, a person accepts (**new 2026-09-19**) | bunny's Transcribe AI has `generateTitle`/`generateDescription`/`generateMoments` hard-off at the call site and `generateChapters` opt-in (`lib/bunny.js` `transcribeVideo`); what it generates lands on bunny's video object and is read back READ-ONLY by `lib/aiChapters.js` (pure, imports only `lib/chapters.js`). The `suggestions` branch of `pages/api/admin/transcribe.js` writes nothing — not the `chapters` hash, not the transcript, not the audit log, since nothing changed — and `pages/admin.js` loads the proposal into the textarea, confirming before it replaces text already typed. Verify: `npm test -- aiChapters`; `grep -n "^import" lib/aiChapters.js` (expect exactly one line, `./chapters`, which itself imports nothing — a mention of chaptersStore in a comment is not an import) | Two writers for one field. An admin who typed `24:15 Sermon` would have no way to notice a transcription job had overwritten it, and no way to get it back |
| I11 | Revoke is a soft-delete; extend is refused on a revoked item | `lib/share.js` `revokeShare` sets `revokedAt` (no `DEL`); `extendShare` returns an error if `share.revokedAt` is set, before touching `expiresAt` | Without this, "extend" could double as a silent un-revoke, or a revoked link would vanish from the admin list instead of staying auditable |

Rate-limited endpoints (for completeness; all via `allowRequest`, updated
2026-07-26): `/api/videos` 60/min per email (videos.js:13), `/api/admin/upload`
20/hour (upload.js:13), `/api/admin/share` 10/min — covers create/resend/extend
(share.js:13), `/api/admin/bulk-share` 5/min (bulk-share.js:21),
`/api/admin/shares-bulk` 10/min — covers bulk resend/revoke/extend
(shares-bulk.js:16), `/api/admin/viewers-bulk` 20/min — covers add-tag/remove-tag
(viewers-bulk.js:17), `/api/share-event` 60/min per email (share-event.js:14).

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
| `viewer:tags` | HASH | email → array of tag strings (**new 2026-07-26**) | HSET `lib/viewerTags.js` `addTagToViewers`/`removeTagFromViewers` (via `pages/api/admin/viewers-bulk.js`, actions `add-tag`/`remove-tag`, doubles as the single-viewer editor when called with a one-email selection); HDEL when a viewer's last tag is removed, or outright via `clearViewerTags` when the viewer itself is removed (`pages/api/admin/viewers.js` DELETE) | HGETALL `lib/viewerTags.js` `getAllViewerTags`, via `pages/api/admin/viewers.js` GET (returned per-viewer plus the distinct tag list) and the share forms' by-tag recipient picker in `pages/admin.js` | none. Tag strings capped 40 chars, whitespace-collapsed (`normalizeTag`); capped 20 tags/viewer at write. Purely a grouping label — not itself consulted by any access-control check; only currently-approved viewers (members of `viewers`) can be tagged |
| `roles` | HASH | roleId → `{id, name, capabilities[], createdAt, updatedAt}` (**new 2026-08-30**) | HSET `lib/roles.js` `saveRole`; HDEL `deleteRole` (both via `pages/api/admin/roles.js`) | HGETALL `lib/roles.js` `loadRoles`, reached from `resolveCapabilities` on every staff request and from the Roles tab | none. Capped at 50 roles; role names 60 chars, whitespace-collapsed. Capability strings outside `lib/capabilities.js`'s catalog are dropped on write AND ignored on read, so a hand-edited record cannot widen the catalog |
| `user:roles` | HASH | email → array of roleIds (**new 2026-08-30**) | HSET/HDEL `lib/roles.js` `setRolesForEmail`; swept by `deleteRole` for every holder; HDEL via `clearRolesForEmail` when the viewer itself is removed (`pages/api/admin/viewers.js` DELETE) | HGET `rolesForEmail` (the hot path, via `resolveCapabilities`); HGETALL `loadRoleAssignments` for the Roles tab | none; capped 10 roles/user. Ids with no live role record are dropped at write and contribute nothing at read. **Never consulted for owners** — `ADMIN_EMAILS` resolves to the full catalog without touching this key |
| `groups` | HASH | groupId → `{id, name, collectionIds[], videoIds[], createdAt, updatedAt}` (**new 2026-08-30**) | HSET `lib/groups.js` `saveGroup`; HDEL `deleteGroup` (via `pages/api/admin/groups.js`) | HGETALL `loadGroups`, from the Groups tab and from `contentScopeFor` when gating is on | none; capped 100 groups, 500 scope entries per list, names 60 chars **Upload-time grants (2026-09-23):** `/api/admin/upload` adds a new video to the ticked groups' `videoIds`, gated on `groups.manage` (owner, or the capability, resolved with `resolveActor` because `requireCapability` returns only an email) on top of `videos.upload`. Every refusal happens before `createVideo`, so none leaves an orphan; `grantVideoToGroups` never recreates a deleted group or overfills one (`saveGroup` sorts then cuts at 500, so overfilling silently drops the sorted-last grant). Video delete (single and bulk) calls `pruneVideoFromGroups`. No stored default group. Verify: `npm test -- uploadRoute uploadGrants groupGrants videoDeleteGroups` |
| `user:groups` | HASH | email → array of groupIds (**new 2026-08-30**) | HSET/HDEL `lib/groups.js` `setGroupsForEmail` (per-user) and `setMembersOfGroup` (per-group, diffs and touches only changed emails); swept by `deleteGroup`; HDEL via `clearGroupsForEmail` on viewer removal | HGET `groupIdsForEmail` (only when gating is on); HGETALL `loadGroupMemberships` for the Groups tab and for inverting into a member list | none; capped 20 groups/user. Unlike `viewer:tags`, this key CAN affect access — but only while `GROUP_CONTENT_GATING=1` |
| `user:scope` | HASH | email → JSON array of groupIds (**new 2026-09-25**) | HSET/HDEL `lib/staffScopeStore.js` `setScopeForEmail` (via `pages/api/admin/roles.js` PATCH `scope`); HDEL by `clearRolesForEmail` | HGET `scopeForEmail` (`resolveActor` for any non-owner holding a capability; `contentScopeFor` for staff when gating is on) | none; ≤20 groups. **Absent = the whole portal; `[]` = no groups** — a present but unreadable value reads as `[]`. Deleted groups simply contribute nothing. Never consulted for owners |
| `settings:groupDefaultAccess` | string | `'open'` \| `'closed'` (**new 2026-08-30**) | SET `pages/api/admin/groups.js` PATCH `set-default-access` | GET `lib/groups.js` `groupDefaultAccess` | none; anything but `'closed'` reads as `'open'`, the non-destructive default, so enabling gating never silently blanks an audience |
| `access-requests` | HASH | email → `{email, note≤200, at}` (**new 2026-08-31**) | HSET `lib/accessRequests.js` `recordAccessRequest` (via `pages/api/request-access.js`); HDEL `removeAccessRequest` on approve/dismiss | HGETALL `loadAccessRequests` via `pages/api/admin/access-requests.js` GET | none; capped at 200 pending entries, and keyed BY EMAIL so a repeat request overwrites rather than queues — the per-email rate limit (3/hour) is the first line, this cap the second |
| `schedule` | HASH | videoGuid → `{from, until, repeat?, groups?}` — dates either nullable (**new 2026-08-31**); `repeat` `{days, start, end, timeZone}` and `groups` `{<groupId>: {from, until}}` (**2026-09-24**, see I3e) | HSET/HDEL `lib/scheduleStore.js` `setVideoWindow` (via `pages/api/admin/schedule.js`); HDEL `clearVideoWindow` when the video is deleted | HGETALL `loadSchedule` (`/api/videos`, `/api/admin/videos`), HGET `getVideoWindow` (`/watch/[id]`) | none. Reads fail **OPEN** — unlike every other gate here. Scheduling is a publishing convenience, not an access boundary: hiding the library on a Redis blip is the availability failure §1.7 rules out, and the video sits behind the viewer gate regardless. An unparseable bound is ignored, never treated as "hide" |
| `chapters` | HASH | videoGuid → `[{at, label}]` (**new 2026-09-13**) | HSET/HDEL `lib/chaptersStore.js` `setVideoChapters` via `pages/api/admin/chapters.js`; HDEL `clearVideoChapters` on video delete | HGETALL `loadAllChapters` (admin list), HGET `getVideoChapters` (`/watch/[id]`, `lib/publicWatch.js`) | none; ≤100 chapters, labels ≤80 chars. Reads fail back to "no chapters" — navigation sugar over a video that plays without it |
| `transcripts` | HASH | videoGuid → `[{start, end, text}]` (**new 2026-09-19**) | HSET `lib/captionsStore.js` `setVideoTranscript` via `pages/api/admin/transcribe.js` (`ingest`); HDEL `clearVideoTranscript` on video delete | HGET `getVideoTranscript` (`/api/transcript/[id]`) | none. Capped at `MAX_CUES` (10,000). Reads fail back to "no transcript" — sugar over a video that plays without it |
| `transcripts_alt` | HASH | `{guid}:{lang}` → cue array (**new 2026-09-20**) | HSET `setTranscriptLanguage` for every non-default track the collector finds | HGET `getVideoTranscript(guid, lang)` when the language is not the default | cleared with the transcript, using the index below for the field names. A SEPARATE hash because `loadTranscribedGuids()` reads `transcripts` field names with `hkeys` — a `guid:lang` field there would be reported as a transcribed video that does not exist |
| `transcript_text_alt` | HASH | `{guid}:{lang}` → that translation's words, ALREADY normalised (`normalizeSpokenText`) (**new 2026-09-24**) | HSET `setTranscriptLanguage` beside the cue row | `matchingTranslatedGuids` only — a Lua script walks the hash INSIDE Redis and returns just the matching guids, which join `/api/videos`' note/transcript union and its scope + window pipeline. Stored pre-normalised because Lua's `lower()` is not Unicode-aware | cleared with the transcript (`clearVideoTranscript`, which the video delete calls). Never loaded into the app, so it can grow with the number of languages without growing what a search reads |
| `transcript_langs` | HASH | videoGuid → `{default, all[]}` (**new 2026-09-20**) | HSET `setTranscriptLanguages` after a collection | `getTranscriptLanguages()` — the panel's picker, and how a read knows which language the default track is | cleared with the transcript, and read BEFORE deletion since it is the only record of which `transcripts_alt` fields exist |
| `transcribe_pending` | HASH | videoGuid → epoch ms queued (**new 2026-09-20**) | HSET `markTranscribePending` on a successful queue (`pages/api/admin/transcribe.js`) | HGETALL → `planCollection` (`lib/transcribeQueue.js`), read by the admin video list and the scheduled job (`/api/cron/transcripts`) | cleared on ingest (manual or automatic) and when older than `PENDING_MAX_AGE_MS` (3 days — two daily scheduled runs at least). A MARKER, not a job — the admin list and the scheduled job do the collecting (I3f) |
| `transcribe_collecting` | STRING | a random `lock-…` token (**new 2026-09-24**) | SET NX EX 300 `acquireCollectLock` (`lib/captionsStore.js`) at the start of a collection run | the release script only, which deletes it if it still holds the caller's token | EXPIRES after 5 minutes. One collection run at a time — an admin page load and the scheduled job (or a doubly-delivered run) skip rather than collect the same video twice |
| `comments:{guid}` | HASH | comment id (`c` + base-36 time + random) → JSON `{id, email, name, text, at}` (**new 2026-09-24**) | `addComment` (`lib/commentsStore.js`) via `POST /api/comments` — a Lua script that refuses once the hash holds 500, so the cap cannot be raced; HDEL per comment on delete | `listComments` / `getComment`; the email decides "mine" and is shown only to owners and `viewers.read` holders (I3g) | removed whole with the video by `forgetVideo` (`lib/videoCleanup.js`), which BOTH delete paths call — before it, the bulk delete cleared no per-video rows at all. NOT removed with a viewer |
| `ratings:{email}` | HASH | videoGuid → `'up'` / `'down'` (**new 2026-09-19**) | `recordRating` (`lib/ratingsStore.js`, via `pages/api/rating.js`) — `VOTE_SCRIPT`, which writes the vote AND moves the counters in one script | HGETALL `getRatings` → `ratingOf` (`lib/ratings.js`) — the watch page's 👍/👎, server-rendered; `recountRatings` reads every one | none today. Per-viewer, keyed by email like `progress:`/`mylist:` (I13) — **viewer removal does not delete it yet** |
| `rating_counts` | HASH | `{guid}:up` / `{guid}:down` → integer (**new 2026-09-19**) | `recordRating`, in the same script as the vote; `recountRatings` (`RECOUNT_SCRIPT`, *Recount ratings* on the Settings tab) rebuilds and replaces it | HGETALL `getRatingCounts` → `countsByVideo` — the admin Videos tab badge, **staff only** | `clearVideoRatingCounts` on delete, so a recycled guid cannot inherit a score. Holds **no identities**. A negative (only possible from before the vote script) reads as 0 until a recount |
| `transcript_text` | HASH | videoGuid → the same words as one string (**new 2026-09-19**) | written together with `transcripts` by `setVideoTranscript` | HGETALL `loadAllTranscriptText` (`/api/videos` search union) | none. Split from `transcripts` on purpose: search needs one HGETALL and **none of the timings**, and cue arrays are bulky (~1,500 per 90-minute service) |
| `mylist:<email>` | HASH | videoGuid → epoch ms when saved (**new 2026-09-19**) | HSET `lib/mylistStore.js` `saveToMyList` / HDEL `removeFromMyList`, via `pages/api/mylist.js` | HGETALL `getMyList` (`/watch/[id]` toggle, server-rendered) and `/api/mylist` GET, which returns **ids only** | none. Capped at `MAX_ITEMS` (200) by `lib/mylist.js`, refused at the cap on write. Keyed by email exactly like `progress:<email>`, and deliberately a separate key: progress is written on a timer, this only by a click |
| `notes` | HASH | videoGuid → string (**new 2026-09-13**) | HSET/HDEL `lib/notesStore.js` `setVideoNotes` via `pages/api/admin/notes.js`; HDEL on video delete | HGETALL `loadAllNotes` (admin list, `/api/videos` search widening, feed item descriptions), HGET `getVideoNotes` | none; ≤4000 chars, control/zero-width stripped, tabs and newlines kept. Empty DELETES the key. **Search (2026-09-23):** `noteMatches` also matches a query that IS a scripture reference against the passages `lib/scripture.js` reads from the notes — it only adds matches, and every candidate still goes through `/api/videos`'s scope → schedule pipeline. `lib/scripture.js` is pure and client-bundled: no regex lookbehind (a parse-time SyntaxError in Safari before 16.4). **Browse by book** is `GET /api/videos?index=books` — a MODE of that route, so it passes the one `requireViewer` gate and the scope/schedule already resolved there — counted after `isPlayable` → scope → schedule over every page of the library (bounded at 10 × 100, truncation reported). A count is information; counting wider would leak what the filters hide. **Word stems (2026-09-23):** `noteMatches` also matches a query's words by stem (`lib/stem.js`) — additive; a passage query is answered by passage overlap ALONE, or stems would widen "Philippians 2" to the whole book. Verify: `npm test -- scripture notes searchLink booksIndexRoute stem`; `grep -n "(?<" lib/scripture.js` prints nothing |