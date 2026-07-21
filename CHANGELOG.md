# Changelog

All notable changes to the Marine Video Portal. Dates are UTC, matching the
commit history (`git log --oneline`).

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
