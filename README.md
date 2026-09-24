# Marine Video Portal

A private, invite-only video site built with **Next.js 16** (Pages Router), hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** (v4 SDK) for login, and **Upstash Redis** (via Vercel Storage) for admin-managed settings, collections, share links, watch history, and the audit log.

Videos are never public: every play uses a **signed, time-limited bunny.net token** generated fresh on each request. Access is gated to an admin-managed list of approved viewers, with per-recipient private share links for one-off sharing.

## Architecture at a glance

- **No video bytes touch this server.** Uploads stream from the admin's browser straight to bunny.net over resumable TUS, authorized by a server-signed ticket — the Bunny API key stays server-side and never reaches the client.
- **Playback is always tokenized.** Each play uses a short-lived signed Bunny embed URL, so a raw, shareable video URL is never exposed.
- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare the session email against admin-managed lists.
- **All state lives in Redis.** Approved viewers, collections, custom ordering, share links, share bundles, watch progress, My List, ratings, comments, transcripts, chapters, notes, schedules, roles, groups, push subscriptions, the theme, and the audit log are stored in Upstash Redis under the `fable2:` key prefix — editable live from `/admin`, no redeploy.

---

## How it works

- Visiting the site requires logging in via Auth0 (the v4 SDK mounts `/auth/login`, `/auth/logout`, and `/auth/callback` via `middleware.js`).
- Only **approved viewers** (managed live by an admin) see the video library. Everyone else sees a clear "not approved" message after logging in.
- The homepage shows the library — as a **thumbnail grid** when thumbnails are configured, otherwise a title list — with **search**, **collection filters**, and a **Continue watching** strip that resumes videos where the viewer left off. It's paginated and capped at an admin-controlled count.
- Clicking a video opens a watch page (`/watch/[id]`) that plays it in a tokenized bunny.net embed and remembers playback position.
- Private share links live at `/s/[id]` — recipient-locked, expiring, revocable, extendable. A recipient with 2+ active links also gets a consolidated bundle page at `/b/[id]` listing everything shared with them (same recipient-locked gate).
- Admins manage everything from a tabbed **`/admin`** panel: upload videos, organize the library, manage viewers and share links, adjust the site's color palette, and view analytics and an activity log.
- `/admin` is gated **server-side** (redirects non-admins before any UI is sent) and every `/api/admin/*` route independently returns `403` for non-admins.
- The portal is an **installable PWA** — it can be installed as a standalone app on Windows, Mac, Android, and iOS off the same deployment. Admins get the full admin panel in the installed app too.

### What viewers get

The short version; [FEATURES.md](FEATURES.md) has the detail and the known gaps.

- **Watching** — resume where you left off, chapters that seek, a transcript
  in every language bunny.net produced, and a link to any moment (`?t=`).
- **Finding** — search across titles, notes and what was said (in every
  transcript language), reaching the whole library; by passage ("Philippians 2"
  finds a title or note citing "Phil 1:27–2:11"), by word form ("baptism" finds
  "baptized"), and **Browse by book**.
- **Keeping** — My List, continue-watching, a full watch history (`/activity`),
  and a private podcast feed.
- **Responding** — rate a video (only you see your vote) and **comment** under
  it (others see your account name, never your email).
- **When** — videos can be scheduled, repeat weekly ("Sundays 09:00–13:00"),
  or open early for one group.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (Pages Router), React 19 |
| Hosting | Vercel |
| Video | bunny.net Stream (tokenized embeds, TUS resumable upload, collections, statistics) |
| Auth | Auth0 (`@auth0/nextjs-auth0` v4 — middleware-mounted `/auth/*` routes) |
| Data | Upstash Redis (`@upstash/redis`) via Vercel Storage |
| Rate limiting | `@upstash/ratelimit` |
| Push | Web Push / VAPID (`web-push`), opt-in |
| Error monitoring | Sentry (`@sentry/nextjs` v10, instrumentation files), opt-in |
| Uploads | `tus-js-client` v4 (browser → bunny.net) |
| Playback resume | `player.js` |
| Lint | ESLint 10 flat config (`eslint.config.mjs`, `eslint-config-next`) |
| Tests / CI | Vitest 4 + GitHub Actions (lint + test + build) |

---

## Project structure

```
middleware.js             Auth0 v4 middleware — mounts /auth/* and rolls sessions (skips api/cron/)
pages/
  _app.js                 Theme bootstrap, service-worker registration, idle-timeout mount
  _document.js            No-flash palette script (applies cached theme pre-paint), PWA links
  index.js                Homepage — thumbnail grid/list, search, collections, continue-watching, My List, Browse by book
  admin.js                Tabbed admin panel (server-gated) — Videos/Viewers/Groups/Roles/Shares/Settings/Activity/Analytics
  activity.js             Watch history — your own, or (staff) any approved viewer's
  watch/[id].js           Watch page — fresh signed embed per request, resume, chapters, transcript, rating, comments
  watch/public/[id].js    The public door — one public video, no account (rules in lib/publicWatch.js)
  s/[id].js               Private share-link page — recipient-locked, view-counting, playback events
  b/[id].js               Consolidated share-bundle page — same recipient-locked gate, live per-item status
  api/
    videos.js             Page of videos for approved viewers (search incl. transcripts + passages, collection filter, rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history
    mylist.js             The viewer's own saved queue
    rating.js             The viewer's own rating of one video
    comments.js           Comments under a video — list / add / delete (author or comments.manage)
    transcript/[id].js    One video's transcript, for the watch page
    request-access.js     File a self-serve access request (signed in, not yet approved)
    feed-token.js         The viewer's own podcast feed URL
    feed/[token].js       Per-subscriber podcast feed (token-authenticated)
    feed/[token]/[file].js  One episode's artwork
    manifest.js           PWA manifest carrying the admin-set name (served at /manifest.webmanifest)
    app-icon/[size].js    The app icon at 180 / 192 / 512
    monitor.js            Query Monitor process stats (404 when off)
    theme.js              Public GET palette; admin POST to update it
    share-event.js        Records a share link's real playback signal (play/progress/complete)
    cron/
      transcripts.js      Scheduled job: collect finished transcriptions (CRON_SECRET-gated, 404 without it)
    push/
      subscribe.js        Store a viewer's Web Push subscription
      unsubscribe.js      Remove a Web Push subscription
    admin/
      videos.js           List (ordered, with watermark mode) / rename / set-collection / set watermark mode / delete
      videos-bulk.js      Bulk delete / bulk assign-to-collection over a multi-selected set of videos
      viewers.js          List (with last-seen + tags) / add (single or bulk) / remove
      viewers-bulk.js     Bulk add-tag / remove-tag over a multi-selected set of viewers
      access-requests.js  Pending access-request queue: list / approve (optionally into groups) / dismiss
      groups.js           Groups: registry, membership, content scope
      roles.js            Roles: create / edit / delete / assign, with the no-escalation rule
      schedule.js         A video's publish window — from/until, weekly repeat, per-group windows
      chapters.js         A video's chapter list
      notes.js            A video's notes
      transcribe.js       Queue bunny.net Transcribe AI (optionally with chapter suggestions) / ingest the result
      public-video.js     Open or close a video's public door
      rating-recount.js   Rebuild rating totals from the votes
      app-icon.js         Set or reset the app icon
      viewer-activity.js  Any approved viewer's watch history (analytics.read)
      settings.js         Homepage video count, global watermark default + exemption list, site name, geo toggles
      order.js            Custom homepage video order
      share.js            Create link(s) for one video x 1+ recipients / resend / extend (rate-limited)
      shares.js           List active share links (status + bundle) / revoke (soft-delete)
      shares-bulk.js      Bulk resend/revoke/extend over a multi-selected set of links
      bulk-share.js       Share N videos x M recipients in one action
      private-list.js     Per-video tracked invite list: list/add (skips its own already-invited emails, rate-limited) / remove (revokes only its own tracked share)
      cleanup.js          Manual garbage collection for share indexes whose TTL lags
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js            Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
      broadcast.js        Send a manual push broadcast to viewers + admins
components/
  AppShell.js             Header/layout shell
  ShareShell.js           Minimal shell shared by /s/[id] and /b/[id]
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress + share playback events
  TranscriptPanel.js      Searchable, seekable transcript (every language bunny.net produced)
  Comments.js             Comments under a video
  RatingButtons.js        The viewer's own 👍/👎
  SaveToListButton.js     Add to / remove from My List
  NotifyButton.js         Per-device push opt-in/out toggle
  EmailTagInput.js        Multi-email entry as removable chips/tags (used by Share and Private list forms)
  QueryMonitor.js         Opt-in floating performance panel
  icons.js                Inline SVG icons
lib/
  auth0.js                Auth0Client instance (v4 SDK)
  auth.js                 Shared isAdmin(email) / normalizeEmail helpers, used everywhere
  guard.js                requireAdmin / requireViewer session guards for API routes
  capabilities.js         Capability catalog + pure no-escalation logic of the role system
  roles.js                Redis side of roles
  groups.js               Groups: membership and content scope (vs. viewerTags, a pure label)
  accessRequests.js       Self-serve access requests (one pending per person)
  accessRequestNotify.js  Tells whoever holds viewers.manage that a request arrived
  params.js               Strict readers for untrusted request parameters
  geo.js                  GEO_WHITELIST / ADMIN_GEO_WHITELIST enforcement
  bunny.js                Bunny API: videos, collections, statistics, TUS signing,
                          signed embed URLs, token-signed thumbnail URLs, captions, transcription
  redis.js                Upstash Redis connection (lazy) + key prefix helper k()
  order.js                Apply custom video order (new uploads float to top, newest first)
  uploadGrants.js         Which groups a new upload is granted to
  videoCleanup.js         Forgets everything stored about a deleted video (both delete paths)
  schedule.js / scheduleStore.js         Publish windows: from/until, weekly repeat, per-group windows
  chapters.js / chaptersStore.js         Chapter markers ('Sermon 24:15')
  aiChapters.js           bunny.net's AI chapter suggestions, in this repo's chapter shape
  notes.js / notesStore.js               Per-video notes (searchable)
  captions.js / captionsStore.js         WebVTT parsing + transcript search; stored transcripts, collect lock
  transcribeQueue.js      Which queued transcriptions to check, and when to give up
  transcriptCollect.js    Collects finished transcriptions (admin list + scheduled job)
  cronAuth.js             CRON_SECRET check for scheduled-job routes (constant-time)
  scripture.js            Scripture references in titles and notes ("Phil 2:1-11")
  stem.js                 Word stems for search ("baptism" ~ "baptized")
  searchLink.js           Links that open the library already searched
  timestampLink.js        Links that start a video at a moment (?t=)
  mylist.js / mylistStore.js             My List
  ratings.js / ratingsStore.js / ratingScripts.js   Per-viewer ratings; Lua keeps totals equal to votes
  comments.js / commentsStore.js         Comments: rules (pure) and storage (atomic per-video cap)
  publicVideos.js / publicVideosStore.js / publicWatch.js   Public (unlisted) videos and their door
  podcast.js / podcastStore.js           Per-subscriber podcast feed and tokens
  siteName.js / siteNameStore.js         The admin-set display name
  appIcon.js / appIconStore.js           The admin-set app icon (validated, stored as PNGs)
  theme.js                Palette presets, validation, CSS-variable mapping
  audit.js                Append-only admin action log (capped)
  push.js                 Web Push helpers (VAPID send, announce-once guard, self-pruning)
  mail.js                 Resend email helpers for share links (inert without RESEND_API_KEY)
  share.js                Share-link primitives: create/resend/extend/revoke, logical-expiry model
  bundle.js               Share-bundle grouping/notification logic (one place per recipient)
  privateList.js          Per-video invite list: its own tracked email->shareId index, layered on lib/share.js
  viewerTags.js           Viewer tags: per-viewer tag list + bulk add-tag/remove-tag over a selection
  watermark.js            Layered watermark precedence (exempt > share > video > global default) + Redis helpers
  videoAnalytics.js       Pure rollup of existing per-share tracking, grouped by video
  monitor.js / monitorClient.js          Query Monitor, server and browser halves (opt-in)
  ratelimit.js            Sliding-window limiters (fail open)
  __tests__/              Vitest suite — pure logic, API routes, and Lua scripts against a real redis-server
public/
  sw.js                   Service worker (caches only icons + manifest; push handlers)
  icon-192.png / icon-512.png / apple-touch-icon.png / icon.svg   Default app icons
  robots.txt              Disallow all (private site)
styles/globals.css        Design system (dark glassmorphism, gradient accents, Inter)
instrumentation.js        Sentry server/edge init hook (opt-in)
instrumentation-client.js Sentry client init (opt-in)
sentry.{server,edge}.config.js   Opt-in Sentry init (inert without a DSN)
next.config.js            Wrapped with withSentryConfig; rewrites /manifest.webmanifest to /api/manifest
vercel.json               The daily scheduled job (/api/cron/transcripts)
vitest.config.js          Test config
eslint.config.mjs         ESLint 10 flat config (next/core-web-vitals)
.github/workflows/ci.yml  Lint + test + build on push/PR to main
```

---

## Environment variables (Vercel → Settings → Environment Variables)

> The Auth0 v4 SDK renamed its env vars: `APP_BASE_URL` (was `AUTH0_BASE_URL`) and `AUTH0_DOMAIN` (was `AUTH0_ISSUER_BASE_URL`, and **without** `https://`).

### Required

| Key | Description |
|---|---|
| `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate with `openssl rand -hex 32` or generate-secret.vercel.app/32. |
| `APP_BASE_URL` | Exact site URL, e.g. `https://your-app.vercel.app` (no trailing slash). |
| `AUTH0_DOMAIN` | Auth0 domain **without** scheme, e.g. `your-tenant.us.auth0.com`. |
| `AUTH0_CLIENT_ID` | From the Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From the Auth0 application settings. |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID. |
| `BUNNY_API_KEY` | bunny.net Stream library API key (server-side only). |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library's Embed View Token Authentication key (Security tab). |
| `ADMIN_EMAILS` | Comma-separated admin emails, e.g. `you@example.com,other@example.com`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when an Upstash Redis database is connected via Vercel's Storage/Marketplace tab. (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` also work.) |

### Optional

| Key | Description |
|---|---|
| `BUNNY_CDN_HOSTNAME` | Library CDN/pull-zone host (e.g. `vz-xxxx-xxx.b-cdn.net`). **Required for thumbnails** — without it the homepage falls back to the title list. |
| `BUNNY_CDN_TOKEN_KEY` | Pull zone's URL Token Authentication key. Only needed if it differs from `BUNNY_TOKEN_AUTH_KEY` and "Block Direct URL File Access" is on. |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Enable Sentry error capture (server / client). Inert if unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Enable Sentry source-map upload during build. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Enable **push notifications** (new-video announcements + admin broadcasts). Set **both** to turn the feature on; leave unset and the "Notify me" button and broadcast form stay hidden. Generate a keypair with `npx web-push generate-vapid-keys`. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is baked in at build time — changing it needs a rebuild, not just a restart. |
| `VAPID_SUBJECT` | Contact URI for push (a `mailto:` address or https URL). Defaults to `mailto:<first ADMIN_EMAILS entry>`. |
| `CRON_SECRET` | Optional. Switches on the scheduled transcript collector (`/api/cron/transcripts`, scheduled daily in `vercel.json`). 16+ random characters (**secret**); Vercel sends it to the job automatically. Unset → the route answers 404. |
| `RESEND_API_KEY` | Enable **emailing share links** to their recipient (via [Resend](https://resend.com)). Unset → the "Email the link" checkbox and "Resend email" button stay hidden and nothing is ever sent. |
| `MAIL_FROM` | From address for share-link emails, e.g. `Marine Video Portal <share@yourdomain.com>` (must be a Resend-verified sender). Defaults to `onboarding@resend.dev` for testing. |
| `GEO_WHITELIST` | Comma-separated ISO country codes viewers must connect from, e.g. `US,CA`. Only enforced once the "Enforce viewer geo whitelist" toggle is turned on in `/admin` → Settings (**off by default**); shown read-only there. Unset/empty → inert. |
| `ADMIN_GEO_WHITELIST` | Same idea as `GEO_WHITELIST` but for admin access, checked instead of it for any `ADMIN_EMAILS` account. Kept as a separate env var so a traveling admin is never blocked by the viewer whitelist, and — if this one ever locks an admin out — it can be edited directly in Vercel without needing `/admin` to be reachable. Also toggled off by default in `/admin` → Settings. |
| `ADMIN_GEO_BYPASS_EMAILS` | Comma-separated admin emails that always skip the admin geo check entirely, regardless of country or the enforcement toggle. Arm this **before** traveling — it's a standing safety net, not an in-the-moment fix, since env var changes need a redeploy. Shown read-only in `/admin` → Settings alongside `ADMIN_GEO_WHITELIST`. Unset/empty → inert (nobody is bypassed). |
| `REQUIRE_EMAIL_VERIFIED` | Set to `1` to refuse sessions whose `email_verified` claim isn't boolean `true`. Unset → today's behaviour: access trusts the email claim as-is. **Confirm your tenant actually emits the claim before turning this on** — sign in on a preview deployment and open `/auth/profile`. If the claim is absent, enabling this locks out every user including every owner, recoverable only by changing the var back and redeploying. Once verified, turn it on: unset is a staging position, not a resting place. |
| `BUNNY_CDN_HOSTNAME` (podcast) | Also gates the **podcast feed**: without a CDN hostname there is no enclosure URL to publish, so the feed route 404s and the viewer-facing section stays hidden. The feed additionally needs **MP4 Fallback enabled on the Bunny library** — otherwise the `play_*.mp4` files it points at do not exist. |
| `GROUP_CONTENT_GATING` | Set to `1` to make **group content scopes actually restrict what members can see** (homepage list, collection filters, and direct `/watch/…` links alike). Unset → groups are membership bookkeeping only: scopes are recorded in `/admin` → Groups but change nobody's library. When it is on, a viewer in no group is governed by the live **"viewers in no group see"** setting in that tab (whole library by default, so turning the flag on never silently blanks anyone); a viewer in one or more groups sees exactly the union of those groups' collections and videos, and a group scoped to nothing grants nothing. Owners and role-holders always bypass it. Share links (`/s/…`, `/b/…`) are never group-gated. |
| `QUERY_MONITOR_ENABLED` | Set to `true`/`1`/`on`/`yes` (case/whitespace-insensitive) to turn on the **Query Monitor** performance panel — a floating widget, visible to signed-in users, reporting Redis query count/time, outbound third-party API calls (bunny.net, Resend, web-push) count/time, the page's server-render cost, client render time, and process memory/uptime for the current view. Click it to expand a per-request breakdown. Deliberately one server-side var, not a server + `NEXT_PUBLIC_` pair: the browser learns whether it's on at runtime from `/api/monitor` (which 404s outright when off, and requires a signed-in session otherwise — process stats are never exposed to a logged-out visitor), so toggling it needs only a redeploy, not a rebuild. Unset or off → a single cheap env-var check per Redis/API call and nothing else; call sites are otherwise untouched. |

After adding or changing any variable, **redeploy** — changes only apply to new deployments.

---

## One-time setup checklist

1. **bunny.net** — create a Stream library, enable **Embed View Token Authentication**, upload videos (or upload them from `/admin` later). Note the CDN/pull-zone hostname for `BUNNY_CDN_HOSTNAME` if you want thumbnails.
2. **Auth0** — create a **Regular Web Application**. Set Allowed Callback URLs to `https://your-domain/auth/callback` (note: **`/auth/callback`**, not `/api/auth/callback` — the v4 SDK dropped the `/api` prefix), Allowed Logout URLs and Web Origins to the exact production domain. **Disable open sign-ups** (Authentication → Database → "Disable Sign Ups") and add people manually under User Management → Users, so strangers can't self-register. (Because access is by email identity, this is the primary guard against someone self-registering as an approved/admin address.)
3. **Vercel** — import the GitHub repo, connect an Upstash Redis database under Storage, add the environment variables above, deploy.
4. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video count, add approved viewers, upload/organize videos, pick a palette.

---

## Local development

Node/npm are **not required** to deploy (Vercel installs everything), but they're handy for local work and verification. Node 20.9+ required (22 or 24 LTS recommended).

```bash
npm install       # install dependencies
npm run dev       # local dev server at http://localhost:3000
npm run lint      # ESLint 10 flat config (next/core-web-vitals)
npm test          # Vitest suite (unit + real-Redis script tests)
npm run build     # production build
```

You'll need the environment variables above in a local `.env.local` to run against real services (with `APP_BASE_URL=http://localhost:3000`).

### CI

Every push / PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): **lint → test → build**. A broken build fails the check before Vercel deploys it. Consider enabling branch protection to require the check on PRs.

---

## Admin panel (`/admin`)

Tabbed layout, gated server-side to **owners (`ADMIN_EMAILS`) and anyone holding at least one capability**
(see Roles below). Each tab is shown only to someone whose capabilities reach it, and every
`/api/admin/*` route re-checks the capability server-side on each call — hiding a tab is a tidier UI,
never the access decision:

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete, drag-to-reorder, search, encoding-status badges, per-video collection assignment and **watermark override** (Default/Always/Never), per-video private share-link creation to **one or more recipients at once** (emails entered as removable chips/tags, with a picker to add every viewer carrying a given tag), a **Private list** button opening a persistent, editable invite for that video with the same chip/tag-picker recipient entry (add/remove recipients directly, see below), a **Public/Private** toggle (with a copyable public link when on), a **Notes** editor whose text is searchable by viewers,
  a **Chapters** editor (one `24:15 Sermon` per line, reporting any lines it could not use),
  a **Schedule** button setting a publish window (visible from / hidden again from, either or both), optionally
  **repeating weekly** (days of the week plus a daily time range, kept in the timezone of the browser that set it) and with
  **per-group windows** that let one group see the video earlier or later than everyone else — badged
  Scheduled / Windowed / Expired / **Weekly · on now** / **Weekly · off now**,
  a **Transcribe** button (bunny.net Transcribe AI, optionally with **chapter suggestions** — review them
  with **Suggest chapters** before anything is saved; finished transcripts are collected when the tab
  opens, or by the daily job below), a collapsible **per-video analytics** panel (shares, unique recipients, views, started, completed, completion rate, avg progress — rolled up from existing share tracking), multi-select **bulk share** to several recipients at once (with an optional **"email the link"** checkbox when email is configured, and the same by-tag picker), and multi-select **bulk delete / bulk assign-to-collection**. Also a Collections manager (create/delete) with a **Share** button per collection that pre-selects every video in it and opens the same bulk-share form, instead of picking videos by hand.
- **Viewers** — a **Pending access requests** queue at the top (approve, optionally dropping the person straight
  into groups, or dismiss), then add/remove approved emails, **bulk add** (paste a list), each viewer's **last-seen** time, and **tags/groups** (e.g. "Team A") — add/remove a tag per viewer inline, or multi-select viewers and tag/untag the selection in one action; a filter-by-tag dropdown narrows the list. Tags are pure grouping labels and feed the share forms' by-tag recipient picker above; they don't themselves
grant or restrict access — for that, see the **Groups** tab, which is a separate, managed object.
- **Shares** — every share link with recipient, expiry, **Active/Expired/Revoked** status, view count + last-viewed time, and real playback signal (plays, furthest %, Completed). Multi-select for **bulk resend / bulk extend / bulk revoke / bulk un-revoke / bulk delete**, each reporting per-link success/failure (un-revoke and delete are their own deliberate actions — Extend and Bulk Revoke never silently restore or purge a link as a side effect). Per-link **resend**, **extend** (push expiry forward without a new link), **revoke** (instant, soft-delete), **Un-revoke** (restores the exact link, no new token), and, once revoked, **Delete permanently** (irreversible hard-delete, only ever available after a soft-revoke — bulk delete silently skips and reports-failed any selected link that isn't already revoked). Links that are part of a bundle show a persistent **Bundle link** button (copies `/b/[id]`) alongside Resend/Extend/Revoke, not just in the one-time share-creation toast. Share creation (single and bulk) includes a **watermark** override (Default/Always/Never).
- **Groups** — named groups of viewers, each with a member list and an optional **content scope**
  (collections and/or individual videos). Create/rename/delete a group, tick its members from the approved
  viewer list, and tick what it can see. Whether that scope restricts anything is a deployment decision
  (`GROUP_CONTENT_GATING`) — the tab says plainly which mode it is in, and when gating is on it also
  carries the live **"viewers in no group see the whole library / nothing"** setting. Requires
  `groups.manage`.
- **Roles** — capability-based access for people who are *not* in `ADMIN_EMAILS`. Create roles from a
  fixed catalog of capabilities (upload videos, manage viewers, revoke shares, read the audit log, …),
  then assign roles per email. Two rules are enforced server-side and shown in the UI: accounts in
  `ADMIN_EMAILS` are **owners** who always hold every capability and can never be demoted from here, and
  nobody can grant, edit or revoke a capability they do not hold themselves. Requires `roles.manage`.
  **Comments** are moderated through the same catalog: a comment's author can always delete it, and
  anyone holding **"Remove any viewer's comment"** (`comments.manage`) can delete anyone's. No role holds
  it until you grant it; owners always do.
- **Settings** — the **site name** (shown in the header, the browser tab and the installed app; blank resets
  it to "Marine Video Portal"), the **app icon** (upload a square image for the installed app and browser
  tab; reset returns to the default), **Recount ratings** (rebuilds the 👍/👎 totals from the votes
  themselves; safe any time), homepage video count, the site **color palette** (7 presets + custom, applied to all visitors), a **push broadcast** composer, **viewer watermark** controls (global on/off default + a viewer-exemption list), **geo location whitelist** enforcement toggles for viewers and admins (each off by default, with their `GEO_WHITELIST`/`ADMIN_GEO_WHITELIST` country lists and the `ADMIN_GEO_BYPASS_EMAILS` bypass list all shown read-only), and a content-protection info panel.
- **Activity** — the most recent admin actions (add/remove viewer, share create/resend/extend/revoke/unrevoke/purge including bulk actions, private-list add/remove, video rename/delete/reorder/watermark including bulk actions, settings, palette, watermark exemptions, collections).
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day views chart, a most-watched list, and a **share performance by video** list (shares, recipients, views, started, completed, completion rate, avg progress — the same rollup as the Videos tab's per-video panel, no extra fetch).

A nav-bar **Activity** link (any signed-in approved viewer or admin) opens `/activity` — a viewer sees their own watch history; an owner, or a staff member holding both `viewers.read` and `analytics.read`, additionally gets a dropdown to look up any approved viewer's history by email (`GET /api/admin/viewer-activity`, guarded by the `analytics.read` capability, reads that viewer's own `progress:<email>` data — nothing new is tracked).

---

## Installing as an app (PWA)

The site is installable as a standalone app off the live deployment — no app store, no separate build:

- **Windows / Mac (Chrome or Edge):** open the site → click the install icon in the address bar → **Install**.
- **Android (Chrome):** menu → **Install app** / **Add to Home screen**.
- **iOS (Safari):** **Share** → **Add to Home Screen**.

The installed app is the **full portal** — admins see the Admin button and can manage everything from the installed app, exactly as in a normal browser tab. Login is unchanged (same site, same Auth0 flow). App icons are provided as PNG (192/512 + a 180px Apple touch icon) and SVG, so home-screen/taskbar icons render cleanly on all platforms including iOS. The service worker caches only the app icons and manifest (never authed pages, API, or video), so the app still needs a connection to use.

---

## Push notifications (opt-in)

Push is completely **inert unless both `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set** — with no keys, the "Notify me" button and broadcast composer never appear and nothing is ever sent.

- **New-video announcements** — a video is announced once it finishes encoding, and only if it was uploaded recently (so enabling push never back-blasts the existing library). An atomic Redis guard ensures each video is announced exactly once even across concurrent admin polls.
- **Manual broadcasts** — admins can send a custom push to everyone from the Settings tab.
- **Targeted & self-cleaning** — sends reach only currently-approved viewers and admins; a removed viewer stops receiving them, and dead subscriptions (HTTP 404/410) are pruned automatically.

Generate a keypair with `npx web-push generate-vapid-keys`.

---

## Scheduled transcript collection (opt-in)

Transcription at bunny.net takes minutes, so a finished transcript has to be fetched afterwards. Without
this, that happens whenever an admin opens the Videos tab. With it, a scheduled job does it too.

- **Switch it on** by setting `CRON_SECRET` (16+ random characters). Vercel sends it to the job as
  `Authorization: Bearer …` on every run; unset, blank or too short → `/api/cron/transcripts` answers 404.
- **Schedule** — `vercel.json`, **daily** at `0 6 * * *` UTC, because Vercel's Hobby plan refuses to deploy
  a cron that runs more often (and may run it up to an hour late). On Pro, change it to `*/15 * * * *`.
- **Bounded and safe to repeat** — each run collects at most 25 videos, gives up on a request still
  pending after 3 days, and holds a 5-minute Redis lock so an overlapping or doubled run does nothing.
  Collections are audited as "scheduled job".
- The route sits outside `middleware.js`, so sessions and geo enforcement never see it; the secret is its
  only gate.

---

## Emailing share links (opt-in)

Share links can be delivered to their recipient by email through [Resend](https://resend.com), and re-sent later from the Shares tab. Like push, the feature is **inert unless `RESEND_API_KEY` is set** — with no key, the "Email the link" checkbox and the "Resend email" button never appear and nothing is ever sent, so the admin simply copies the link by hand as before.

- **On create** — tick the checkbox on a share form (single or bulk) and the link(s) are emailed as they're created.
- **Bundled recipients get one email, not one per action** — a recipient's first-ever share gets a plain single-link email. Once they have 2+ currently-active shares (built up from any single or bulk action, in any order), every later notification is one consolidated email pointing at their `/b/[id]` bundle page instead of a new standalone email. The first time this happens for someone, any of their other already-active, not-yet-bundled shares are swept into the same bundle too.
- **Resend** — re-deliver a link's own email to its original recipient, singly or as a bulk action across a multi-selected set (rate-limited, like link creation).
- **Best-effort** — a mail failure never blocks link creation; the link is stored either way and can be copied or resent.

Set `RESEND_API_KEY` and (recommended) `MAIL_FROM` to a Resend-verified sender. Emails are sent server-side via Resend's REST API — no extra dependency, nothing built into the client bundle.

---

## Security notes

- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare the normalized session email. Because of this, keep Auth0 **sign-ups disabled** so nobody can self-register as an approved/admin address. Centralized identity logic lives in `lib/auth.js` — update it there only.
- **`/admin` is gated server-side** via `getServerSideProps` (redirects anyone holding no capability), and every
  `/api/admin/*` route independently returns `403` unless the caller holds that route's capability.
- **Email verification is enforceable in code** (`REQUIRE_EMAIL_VERIFIED=1`). With it on, a session whose
  `email_verified` claim is not boolean `true` is treated as not signed in at every one of the 8 places that
  read the claim — the API guard chokepoint, the homepage, `/admin`, `/watch`, `/activity`, `/s/…`, `/b/…`
  and `/api/share-event`. The check is `!== true`, so an absent, `false`, or string-`"true"` claim all deny;
  it is an access decision and therefore fails closed. Share and bundle recipients are included by explicit
  choice: they are the users least likely to have verified emails, which is exactly why exempting them would
  leave a forged unverified session able to match a link's recipient address. Signed-in-but-unverified users
  get a "verify your email" notice rather than a login redirect, which would loop.
- **Roles add privilege, they never subtract it.** Accounts listed in `ADMIN_EMAILS` are owners: their full
  capability set is decided from the env var alone, without reading Redis, so no stored data — and no Redis
  outage — can demote them, and changing that list still needs an env edit and a redeploy. Everyone else's
  capabilities come from assigned roles and **fail closed** to none if they can't be read. Delegation is
  capped by the **no-escalation rule**: an actor may only create, edit, delete or assign a role whose
  capabilities are a subset of their own, so handing someone `roles.manage` lets them pass on what they
  already hold and nothing more. Holding any capability also grants access to the library itself, so
  giving someone their *first* role additionally requires `viewers.manage` — `roles.manage` on its own
  cannot be used to add a viewer. Every role and assignment change is audit-logged.
- **Playback is always tokenized** — signed, time-limited embed URLs generated per request; no permanent public URL is used or exposed.
- **Share-link and bundle-page mismatches don't reveal** the intended recipient's email — an expired, revoked, or nonexistent link/bundle all show the same generic message.
- **Revoking is a soft-delete.** A revoked share link is marked, not deleted — it stays visible in the admin Shares list with a "Revoked" status, and can never be extended back to life. Extend is refused outright on a revoked link. **Un-revoke** reverses this (clears the revoked mark, restores the link's prior expiry, mints no new token) and is a deliberate, separate action from both Extend and Bulk Revoke. A revoked link can additionally be **permanently deleted** — a real, irreversible removal from Redis — but only once it has already been soft-revoked, so the hard delete is always a second, deliberate step on top of the reversible one.
- **Share expiry is decided by a stored field, not by whether the Redis record still exists.** A link's record deliberately outlives its expiry by a 60-day grace window (so an already-lapsed link can still be **extended**), but every read path (the share page, playback-event reporting, the bundle page) explicitly checks `expiresAt`/`revokedAt` rather than treating "record exists" as "link is usable".
- **Thumbnails** are served from the CDN and, when a token key is present, are **signed** so they keep working with "Block Direct URL File Access" enabled. Requests from the app carry the site's `Referer`, so hotlink protection still blocks direct/off-site access.
- **Viewer watermark is deterrence and traceability, not DRM.** It overlays the viewer's email on playback; a determined viewer can still crop it out of a screen recording. Precedence is exemption > per-share > per-video > global default (`lib/watermark.js`), and — being an accessory, not access control — any Redis read behind it fails open (no watermark shown) rather than blocking playback on an infrastructure hiccup.
- **Rate limiting** guards the video list, upload, share-creation, bulk-share, bulk resend/extend/revoke, bulk video ops, and share playback-event endpoints (fails open if the limiter backend is unavailable).
- **Geo location whitelist is two independent, off-by-default checks** — one for viewers (`GEO_WHITELIST`), one for admins (`ADMIN_GEO_WHITELIST`) — read from Vercel's edge-injected `x-vercel-ip-country` header, with no external geo-IP service or added latency. Each is inert until both its enforcement toggle (`/admin` → Settings) is on **and** its whitelist is non-empty, and each **fails open** (allows the request) when the country can't be determined or a Redis lookup errors, the same "optional feature never half-breaks" contract as push/mail — a geo hiccup never locks out the whole portal. The admin whitelist is a separate env var precisely so a traveling admin is never blocked by the viewer list, and can always be fixed directly in Vercel even if `/admin` is unreachable.
- **Idle sign-out** logs users out after 30 minutes of inactivity.
- Direct bunny.net CDN file URLs (`*.b-cdn.net/.../playlist.m3u8`, `play_720p.mp4`) are never used by the app; if you want them fully locked down, enable **Block Direct URL File Access** on the library's Security tab.

---

## Common issues

- **Thumbnails show as a title list** — `BUNNY_CDN_HOSTNAME` isn't set (or the deploy hasn't picked it up). The grid only appears once the API returns thumbnail URLs.
- **Thumbnails 403 directly but load in the app** — expected: that's referrer-based hotlink protection. The app works; direct/off-site access is blocked.
- **Resume doesn't work** — the Bunny embed must expose the player.js protocol; playback still works either way. Check the browser console/network for `/api/progress` calls.
- **Login loops or 404 on `/auth/login`** — `middleware.js` isn't deployed or its matcher was edited; the v4 SDK mounts the auth routes in middleware.
- **Callback URL mismatch** — the Auth0 app must allow `https://your-domain/auth/callback` (v4 dropped the `/api` prefix).
- **"Missing state" on callback** — login was started from a different URL than `APP_BASE_URL` (e.g. an old preview link). Always start from the exact production URL.
- **Upload fails with HTTP 401** — a stray newline/space in `BUNNY_API_KEY`/`BUNNY_LIBRARY_ID` corrupts the TUS signature (the app trims them; re-paste cleanly in Vercel if it recurs).
- **Geo whitelist toggle is on but nobody is being blocked** — expected if `GEO_WHITELIST`/`ADMIN_GEO_WHITELIST` is unset or empty; the toggle alone does nothing until the matching env var lists at least one country (and a redeploy has picked it up).
- **An admin is locked out by `ADMIN_GEO_WHITELIST`** — edit the env var directly in Vercel (add the admin's current country) and redeploy; this doesn't depend on `/admin` being reachable. If the admin added their email to `ADMIN_GEO_BYPASS_EMAILS` before traveling, they're never blocked in the first place — but that has to be armed ahead of time, since it's also just an env var that needs a redeploy.
- **Query Monitor panel doesn't show up** — `QUERY_MONITOR_ENABLED` only takes effect after a redeploy (it's a server-side env var), and the panel only renders for a *signed-in* user, on a page whose props include `user` — check `/api/monitor` directly: `404` means the flag isn't on for that deployment, `401` means you're not logged in.

---

## Scaling notes (Redis/Upstash)

A homepage visit costs a small, fixed number of Redis commands (viewer check, homepage count, video order, last-seen, plus collections/progress reads). At ~1,000 visits/day this stays well under typical free-tier limits. Watch history and the audit log add bounded writes. If traffic grows into the 10,000+ daily-visit range, move the rarely-changing settings (viewer list, count, order, palette) to Vercel Edge Config to cut Redis load, leaving Redis for the TTL-based share links and per-viewer progress.

**Share commands stay O(1) in the share count, not O(n).** Loading the admin Shares list, checking a recipient's existing shares on every new share creation, and rendering a `/b/[id]` bundle page all batch every share lookup into a single `MGET` (`lib/share.js` `loadShares`) instead of one `GET` per id — at 1,000 shares that's the difference between ~4 Redis commands and ~1,000 per page view. Bulk actions (`/api/admin/shares-bulk`) follow the same shape: one `MGET` to fetch and validate the whole selection, then per-id `SET`s only where the write genuinely differs per item (revoke/unrevoke/extend each need their own timestamp, so that side can't shrink further) — except **bulk delete**, where every write is identical (drop the key, drop it from the index), so it collapses to one multi-key `DEL` plus one multi-member `SREM` regardless of selection size. `revokeShare`/`unrevokeShare`/`extendShare` also stopped reading back a key's TTL before rewriting it — the TTL is a pure function of `expiresAt` (`ttlSecondsFor`), so re-deriving it is free and reading it back was always a redundant round-trip.
