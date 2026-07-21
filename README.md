# Marine Video Portal

A private, invite-only video site built with **Next.js 16** (Pages Router), hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** (v4 SDK) for login, and **Upstash Redis** (via Vercel Storage) for admin-managed settings, collections, share links, watch history, and the audit log.

Videos are never public: every play uses a **signed, time-limited bunny.net token** generated fresh on each request. Access is gated to an admin-managed list of approved viewers, with per-recipient private share links for one-off sharing.

## Architecture at a glance

- **No video bytes touch this server.** Uploads stream from the admin's browser straight to bunny.net over resumable TUS, authorized by a server-signed ticket — the Bunny API key stays server-side and never reaches the client.
- **Playback is always tokenized.** Each play uses a short-lived signed Bunny embed URL, so a raw, shareable video URL is never exposed.
- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare the session email against admin-managed lists.
- **All state lives in Redis.** Approved viewers, collections, custom ordering, share links, share bundles, watch progress, push subscriptions, the theme, and the audit log are stored in Upstash Redis under the `fable2:` key prefix — editable live from `/admin`, no redeploy.

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
middleware.js             Auth0 v4 middleware — mounts /auth/* and rolls sessions
pages/
  _app.js                 Theme bootstrap, service-worker registration, idle-timeout mount
  _document.js            No-flash palette script (applies cached theme pre-paint), PWA links
  index.js                Homepage — thumbnail grid/list, search, collections, continue-watching
  admin.js                Tabbed admin panel (server-gated) — Videos/Viewers/Shares/Settings/Activity/Analytics
  watch/[id].js           Watch page — fresh signed embed per request, resume support
  s/[id].js               Private share-link page — recipient-locked, view-counting, playback events
  b/[id].js               Consolidated share-bundle page — same recipient-locked gate, live per-item status
  api/
    videos.js             Page of videos for approved viewers (search + collection filter, rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history
    theme.js              Public GET palette; admin POST to update it
    share-event.js         Records a share link's real playback signal (play/progress/complete)
    push/
      subscribe.js        Store a viewer's Web Push subscription
      unsubscribe.js      Remove a Web Push subscription
    admin/
      videos.js           List (ordered, with watermark mode) / rename / set-collection / set watermark mode / delete
      videos-bulk.js       Bulk delete / bulk assign-to-collection over a multi-selected set of videos
      viewers.js          List (with last-seen) / add (single or bulk) / remove
      settings.js         Homepage video count, global watermark default + exemption list
      order.js            Custom homepage video order
      share.js            Create/resend/extend a single private share link (rate-limited)
      shares.js           List active share links (status + bundle) / revoke (soft-delete)
      shares-bulk.js       Bulk resend/revoke/extend over a multi-selected set of links
      bulk-share.js        Share N videos x M recipients in one action
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js             Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
      broadcast.js        Send a manual push broadcast to viewers + admins
components/
  AppShell.js             Header/layout shell
  ShareShell.js           Minimal shell shared by /s/[id] and /b/[id]
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress + share playback events
  NotifyButton.js         Per-device push opt-in/out toggle
  icons.js                Inline SVG icons
lib/
  auth0.js                Auth0Client instance (v4 SDK)
  auth.js                 Shared isAdmin(email) / normalizeEmail helpers, used everywhere
  guard.js                requireAdmin / requireViewer session guards for API routes
  bunny.js                Bunny API: videos, collections, statistics, TUS signing,
                          signed embed URLs, token-signed thumbnail URLs
  redis.js                Upstash Redis connection (lazy) + key prefix helper k()
  order.js                Apply custom video order (new uploads float to top, newest first)
  theme.js                Palette presets, validation, CSS-variable mapping
  audit.js                Append-only admin action log (capped)
  push.js                 Web Push helpers (VAPID send, announce-once guard, self-pruning)
  mail.js                 Resend email helpers for share links (inert without RESEND_API_KEY)
  share.js                Share-link primitives: create/resend/extend/revoke, logical-expiry model
  bundle.js               Share-bundle grouping/notification logic (one place per recipient)
  watermark.js            Layered watermark precedence (exempt > share > video > global default) + Redis helpers
  videoAnalytics.js       Pure rollup of existing per-share tracking, grouped by video
  ratelimit.js            Sliding-window limiter (fails open)
  __tests__/              Vitest smoke tests (auth, order, theme, push, share, bundle, watermark, videoAnalytics)
public/
  manifest.webmanifest    PWA manifest
  sw.js                   Service worker (caches only icons + manifest; push handlers)
  icon-192.png / icon-512.png / apple-touch-icon.png / icon.svg   App icons
  robots.txt              Disallow all (private site)
styles/globals.css        Design system (dark glassmorphism, gradient accents, Inter)
instrumentation.js        Sentry server/edge init hook (opt-in)
instrumentation-client.js Sentry client init (opt-in)
sentry.{server,edge}.config.js   Opt-in Sentry init (inert without a DSN)
next.config.js            Wrapped with withSentryConfig
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
| `RESEND_API_KEY` | Enable **emailing share links** to their recipient (via [Resend](https://resend.com)). Unset → the "Email the link" checkbox and "Resend email" button stay hidden and nothing is ever sent. |
| `MAIL_FROM` | From address for share-link emails, e.g. `Marine Video Portal <share@yourdomain.com>` (must be a Resend-verified sender). Defaults to `onboarding@resend.dev` for testing. |

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
npm test          # Vitest smoke tests
npm run build     # production build
```

You'll need the environment variables above in a local `.env.local` to run against real services (with `APP_BASE_URL=http://localhost:3000`).

### CI

Every push / PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): **lint → test → build**. A broken build fails the check before Vercel deploys it. Consider enabling branch protection to require the check on PRs.

---

## Admin panel (`/admin`)

Tabbed layout, gated server-side to `ADMIN_EMAILS`:

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete, drag-to-reorder, search, encoding-status badges, per-video collection assignment and **watermark override** (Default/Always/Never), per-video private share-link creation, a collapsible **per-video analytics** panel (shares, unique recipients, views, started, completed, completion rate, avg progress — rolled up from existing share tracking), multi-select **bulk share** to several recipients at once (with an optional **"email the link"** checkbox when email is configured), and multi-select **bulk delete / bulk assign-to-collection**. Also a Collections manager (create/delete).
- **Viewers** — add/remove approved emails, **bulk add** (paste a list), and each viewer's **last-seen** time.
- **Shares** — every share link with recipient, expiry, **Active/Expired/Revoked** status, view count + last-viewed time, and real playback signal (plays, furthest %, Completed). Multi-select for **bulk resend / bulk extend / bulk revoke**, each reporting per-link success/failure. Per-link **resend**, **extend** (push expiry forward without a new link), and **revoke** (instant, soft-delete). Links point at a recipient's consolidated **bundle page** once they have 2+ active shares. Share creation (single and bulk) includes a **watermark** override (Default/Always/Never).
- **Settings** — homepage video count, the site **color palette** (7 presets + custom, applied to all visitors), a **push broadcast** composer, **viewer watermark** controls (global on/off default + a viewer-exemption list), and a content-protection info panel.
- **Activity** — the most recent admin actions (add/remove viewer, share create/resend/extend/revoke including bulk actions, video rename/delete/reorder/watermark including bulk actions, settings, palette, watermark exemptions, collections).
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day views chart, a most-watched list, and a **share performance by video** list (shares, recipients, views, started, completed, completion rate, avg progress — the same rollup as the Videos tab's per-video panel, no extra fetch).

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
- **`/admin` is gated server-side** via `getServerSideProps` (redirects non-admins), and every `/api/admin/*` route independently returns `403`.
- **Playback is always tokenized** — signed, time-limited embed URLs generated per request; no permanent public URL is used or exposed.
- **Share-link and bundle-page mismatches don't reveal** the intended recipient's email — an expired, revoked, or nonexistent link/bundle all show the same generic message.
- **Revoking is a soft-delete.** A revoked share link is marked, not deleted — it stays visible in the admin Shares list with a "Revoked" status, and can never be extended back to life. Extend is refused outright on a revoked link.
- **Share expiry is decided by a stored field, not by whether the Redis record still exists.** A link's record deliberately outlives its expiry by a 60-day grace window (so an already-lapsed link can still be **extended**), but every read path (the share page, playback-event reporting, the bundle page) explicitly checks `expiresAt`/`revokedAt` rather than treating "record exists" as "link is usable".
- **Thumbnails** are served from the CDN and, when a token key is present, are **signed** so they keep working with "Block Direct URL File Access" enabled. Requests from the app carry the site's `Referer`, so hotlink protection still blocks direct/off-site access.
- **Viewer watermark is deterrence and traceability, not DRM.** It overlays the viewer's email on playback; a determined viewer can still crop it out of a screen recording. Precedence is exemption > per-share > per-video > global default (`lib/watermark.js`), and — being an accessory, not access control — any Redis read behind it fails open (no watermark shown) rather than blocking playback on an infrastructure hiccup.
- **Rate limiting** guards the video list, upload, share-creation, bulk-share, bulk resend/extend/revoke, bulk video ops, and share playback-event endpoints (fails open if the limiter backend is unavailable).
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

---

## Scaling notes (Redis/Upstash)

A homepage visit costs a small, fixed number of Redis commands (viewer check, homepage count, video order, last-seen, plus collections/progress reads). At ~1,000 visits/day this stays well under typical free-tier limits. Watch history and the audit log add bounded writes. If traffic grows into the 10,000+ daily-visit range, move the rarely-changing settings (viewer list, count, order, palette) to Vercel Edge Config to cut Redis load, leaving Redis for the TTL-based share links and per-viewer progress.
