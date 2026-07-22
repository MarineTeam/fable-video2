# Changelog

All notable changes to the Marine Video Portal. Dates are UTC, matching the
commit history (`git log --oneline`).

## 2026-07-22 — Geo location whitelisting for viewers and admins

- **Two independent, off-by-default geo whitelists** — `GEO_WHITELIST` for
  viewers (gates the homepage, `/watch/[id]`, and share/bundle links) and a
  separate `ADMIN_GEO_WHITELIST` for admins (gates `/admin` and every
  `/api/admin/*` route). Both are Vercel env vars, shown **read-only** in the
  admin Settings tab; only each whitelist's enforcement toggle is editable
  there (stored in Redis, off by default). Kept as two separate env vars
  specifically so a traveling admin is never blocked by the viewer
  whitelist, and — if the admin whitelist itself ever locks an admin out —
  it can still be fixed by editing `ADMIN_GEO_WHITELIST` directly in Vercel,
  with no dependency on `/admin` being reachable.
- Country is read from Vercel's edge-injected `x-vercel-ip-country` request
  header — no external geo-IP service, no added dependency or latency.
  `lib/geo.js` (`resolveGeoAccess`, `isGeoAllowed`).
- **Fails open**, unlike a true access-control guard: a missing/undetermined
  country or a Redis error while reading the enforcement toggle is
  *allowed*, not denied — the same "inert until configured, never
  half-breaks" contract as push/mail, so a geo-check hiccup never locks out
  the whole portal.
- Enforced in `lib/guard.js` (`requireAdmin`/`requireViewer`, covering all
  `/api/admin/*` and viewer API routes) and in each page's own
  `getServerSideProps` (`/`, `/watch/[id]`, `/admin`, `/s/[id]`, `/b/[id]`).
  Blocked users see a "Not available in your region" notice.

## 2026-07-22 — Share un-revoke/permanent-delete, persistent bundle link, viewer activity

- **Un-revoke** — undo an accidental revoke on a single share link: clears the
  revoked mark and restores exactly the expiry the link had before it was
  revoked, minting no new link/token. Kept deliberately separate from both
  Extend and Bulk Revoke — neither can double as an un-revoke, and undoing a
  revoke is treated as its own considered action (`lib/share.js`
  `unrevokeShare`, `PUT /api/admin/shares`).
- **Permanent delete** — once a link has been revoked, it can additionally be
  hard-deleted from Redis for good. Only ever available after a soft-revoke,
  so the irreversible step is always a deliberate second act on top of the
  reversible one (`lib/share.js` `purgeShare`,
  `DELETE /api/admin/shares?permanent=1`).
- **Persistent bundle-link button** — any share row belonging to a bundle now
  shows a durable "Bundle link" button (copies `/b/[id]`) alongside
  Resend/Extend/Revoke, instead of only surfacing once in the share-creation
  success toast.
- **Watch history / "my activity"** — a new nav-bar **Activity** link opens
  `/activity` for any signed-in approved viewer or admin. A viewer sees their
  own watch history (the same progress data as the homepage's "Continue
  watching," just as a full list); admins additionally get a dropdown to look
  up any approved viewer's history by email, via a new admin-only endpoint
  (`GET /api/admin/viewer-activity`, `requireAdmin`, restricted to approved
  viewers) that reads the same `progress:<email>` data `/api/progress` already
  reads for the caller's own session — no new tracking.

## 2026-07-21 — Viewer watermarking, per-video analytics, bulk video ops

- **Viewer watermark** — an optional overlay of the viewer's email on
  playback, for traceability, shown on both private share links (`/s/[id]`)
  and the regular library (`/watch/[id]`). Layered, most-specific-wins
  precedence: a per-share choice (Default/Always/Never, set in either share
  form) overrides a per-video choice (set per row in the Videos tab), which
  overrides the global default (Settings tab) — and an **exempted** viewer
  never sees a watermark regardless of any of the above. Pure precedence
  logic lives in `lib/watermark.js` (`resolveWatermark`), unit-tested for
  every override order. A watermark is a deterrence/traceability accessory,
  not access control: any Redis read behind it fails open (no watermark)
  rather than blocking or altering playback.
- **Per-video analytics** _(admin)_ — a collapsible panel per video in the
  Videos tab, and a "Share performance by video" list in the Analytics tab,
  both rolling up the per-share tracking that already exists: total shares,
  unique recipients, views, started, completed, completion rate, and average
  watched %. Computed client-side from the shares already loaded for the
  Shares tab (`lib/videoAnalytics.js`) — no new tracking, no new fetch. The
  rollup also captures each video's title from the share records themselves
  (already attached by the shares API), so it survives the video later being
  deleted from bunny.net.
- **Bulk video operations** _(admin)_ — multi-select videos in the Videos tab
  to bulk-delete or bulk-assign-to-collection, mirroring the existing
  bulk-share UX: every video is processed independently server-side, so one
  failure never aborts the rest of the batch, and per-video success/failure
  is reported. New `pages/api/admin/videos-bulk.js`.
- New Redis keys: `settings:watermarkDefault` (global boolean),
  `watermark:video` (hash, videoId → mode, only non-default entries),
  `watermark-exempt` (set of exempt viewer emails). `share:<id>` gained an
  optional `watermark` field (stored only when explicitly set to
  `always`/`never`).
- Extended: `pages/api/admin/settings.js` (watermark default + exemption
  add/remove), `pages/api/admin/videos.js` (GET returns `watermarkMode` per
  video; PUT accepts it as portal-only metadata, never sent to bunny.net),
  `pages/api/admin/share.js` / `bulk-share.js` (accept `watermark` on
  create), `lib/share.js` (`createShare` stores it additively), `pages/s/[id].js`
  / `pages/watch/[id].js` (resolve and pass to the player),
  `components/ResumablePlayer.js` (renders the overlay).

## 2026-07-21 — Bulk share actions, extend, and consolidated bundles

- **Bulk resend / bulk revoke / bulk extend** — multi-select any number of
  share links in the Shares tab and act on all of them in one click. Every
  link is processed independently; one bad or already-revoked link never
  aborts the rest of the batch, and success/failure is reported per link.
- **Extend** — a new action that pushes a link's expiry forward from *now*
  (not from its old expiry) without creating a new link/URL/token. Works on
  an already-expired-but-not-revoked link (the realistic "it lapsed, give me
  a few more days" case); refused outright on a revoked link, so it can never
  double as a silent un-revoke.
- **Consolidated bundle pages (`/b/[id]`)** — once a recipient has 2+
  currently-active shares, they get one page listing everything shared with
  them, gated exactly like an individual `/s/[id]` link. Every later
  notification for that recipient becomes one updated email pointing at the
  bundle instead of a new standalone email; their first-ever share still gets
  the plain single-link email. The bundle record is a pure grouping list of
  ids — every item's title/expiry/status is read live from its own share
  record on each view, so revoking or extending one item shows up instantly
  without touching the bundle itself. Extending a bundled item also extends
  its bundle so the bundle page can't lapse before a member it still owns.
- **Revoke is now a soft-delete.** A revoked link is marked `revokedAt`
  rather than deleted outright, so it stays visible in the admin list with a
  "Revoked" status instead of disappearing, and can never be extended.
- **Expiry is now a logical field, not raw Redis TTL.** `expiresAt` decides
  whether a link is usable; the underlying Redis record deliberately outlives
  that expiry by a 60-day grace window purely so "Extend" has something to
  act on. Every recipient-facing read path (`/s/[id]`, `/api/share-event`,
  `/b/[id]`) checks `expiresAt`/`revokedAt` explicitly rather than treating a
  present record as automatically usable.
- New Redis keys: `bundle:<id>` (grouping list) and `bundle-by-email:<email>`
  (lookup index, "one bundle per recipient"). `share:<id>` gained optional
  `revokedAt`, `bundleId` fields.
- New routes: `pages/b/[id].js`, `pages/api/admin/shares-bulk.js`. Extended:
  `pages/api/admin/share.js` (extend action), `pages/api/admin/shares.js`
  (status + bundleId on list, soft-delete on revoke).

## 2026-07-20 — Bulk video sharing, per-link view/playback tracking

- **Bulk share** — multi-select videos in the Videos tab and share all of
  them with several recipients in one action; every recipient × video pair
  gets its own independently-revocable link, one email per recipient.
- Share links now track **view count and last-viewed time** on every visit
  (previously only a single first-view timestamp).
- **Real playback signal** reported by the player itself via a new
  `/api/share-event` endpoint: play count, furthest-watched %, and a
  "Completed" badge — not just whether the page was opened.
- New: `lib/share.js` (shared create/clamp/base-URL helpers),
  `pages/api/admin/bulk-share.js`, `pages/api/share-event.js`.

## Earlier

Application code was built in four commits before this changelog started
(`741d980` initial build on Next.js 16 / React 19 / Auth0 v4, `9e5b086` pin
ESLint to 9.x, `d76a881` disable two lint rules, `6dd4351` rename the Redis
key prefix from `pvp:` to `fable2:`). See `git log --oneline` for the full
history and `.claude/skills/architecture-contract/SKILL.md` for the
load-bearing design decisions behind them.
