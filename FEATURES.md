# Marine Video Portal — Features

Current as of **v2.0.0** (rebuilt on Next.js 16 / React 19 / Auth0 v4). Grouped by area; items marked _(admin)_ live in the `/admin` panel.

## Authentication & access control
- Login required for every page via Auth0 (v4 SDK; `/auth/*` routes mounted by middleware).
- Two-tier access: **admins** (fixed `ADMIN_EMAILS` list) and **approved viewers** (managed live by admins, no redeploy needed).
- Logged-in users who aren't approved see a clear "not approved" message instead of any video data.
- **Server-side admin gate** — `/admin` checks the session + admin email in `getServerSideProps` and redirects non-admins before any admin UI is sent; every `/api/admin/*` route also independently returns `403`.
- Centralized identity logic in one shared helper (`lib/auth.js`), with API-route guards in `lib/guard.js`.
- **Auto sign-out after 30 minutes of inactivity** (protects a portal left open on a shared machine).
- **API rate limiting** (sliding window) on the video list, upload, share-creation, bulk-share, bulk share actions (resend/extend/revoke), and share playback-event endpoints; fails open so an infrastructure hiccup never blocks real users.
- Auth0 sign-ups can be disabled tenant-wide so strangers can't self-register. (Access is by email identity, so this is the primary guard against self-registering as an approved/admin address.)
- **Geo location whitelist** _(admin, Settings tab)_ — restricts access by the connecting country (from Vercel's edge geo header). Two independent whitelists, each **off by default**: a viewer whitelist (`GEO_WHITELIST` env var, gates the homepage, `/watch/[id]`, and share/bundle links) and a separate admin whitelist (`ADMIN_GEO_WHITELIST` env var, gates `/admin` and every `/api/admin/*` route). Both whitelists are env-only and shown **read-only** in the admin UI — only the enforcement on/off toggle is editable there. Keeping the admin whitelist separate means a traveling admin is never blocked by the viewer whitelist, and even if the admin whitelist itself locks an admin out, it can still be fixed directly in Vercel without `/admin` needing to be reachable.

## Homepage & viewer experience
- **Modern dark design** — glassmorphism, gradient accents, Inter typography.
- **Admin-adjustable color palette** _(admin)_ — 7 presets plus custom hex colors, applied to **all** visitors; cached client-side with a no-flash pre-paint script so returning visitors never see a color flicker.
- **Video thumbnails** — the homepage upgrades to a responsive **thumbnail grid** (16:9 cards with a play overlay) when thumbnails are configured, and falls back to a clean title list otherwise. The admin library shows thumbnails too. Thumbnail URLs are **CDN token-signed** so they work with "Block Direct URL File Access" enabled.
- **Search** — viewers can search the whole library by title (debounced).
- **Collections / categories** — filter the homepage by collection via chips.
- **Resume playback & Continue-watching** — videos remember where each viewer left off (via player.js); the homepage shows a Continue-watching strip with progress bars. Degrades gracefully if the player protocol is unavailable.
- **Admin-adjustable video count** _(admin)_ — hard cap enforced in code (bunny.net's API doesn't honor it as a strict limit).
- **Custom ordering** _(admin)_ — drag-to-reorder; newly uploaded videos float to the top (newest first) until placed.
- **Pagination** — 10 per page with Previous/Next.
- Autoplay disabled on all embedded players.

## Video playback & security
- Every play uses a **signed, time-limited bunny.net embed token**, generated fresh per request — never a permanent or public URL.
- Direct bunny.net CDN file URLs are never used or exposed by the app.
- Thumbnail requests carry the site's `Referer`, so hotlink protection blocks direct/off-site access while the app still works.
- **Viewer watermark** — an optional overlay of the signed-in viewer's email on the player itself, for traceability, on both `/watch/[id]` and private share links (`/s/[id]`). Layered and most-specific-wins: per-share choice (Default/Always/Never, set when creating a link) > per-video choice _(admin, Videos tab)_ > global default _(admin, Settings tab)_ — and an **exempted** viewer _(admin, Settings tab)_ never sees a watermark no matter what else is set. Honest limitation: this is deterrence and traceability, not DRM — a determined viewer can still crop it out of a screen recording.

## Video management _(admin)_
- **Upload directly from the browser to bunny.net** — TUS resumable upload with a progress bar, **drag-and-drop**, and **cancel/retry** for in-progress uploads (a cancelled upload cleans up its half-created video). The Bunny API key never reaches the client.
- **Encoding status** — per-video "Processing %" / "Failed" badges, auto-refreshing while anything is encoding.
- **Rename** videos inline.
- **Delete** videos (removes from bunny.net and prunes them from the saved order).
- **Bulk video operations** — multi-select any number of videos and **bulk delete** or **bulk assign to a collection** in one action, mirroring the bulk-share UX: every video is processed independently, so one failure never blocks the rest, and per-video success/failure is reported. Bulk delete also prunes the saved order in one pass (capped at 50 videos per action).
- **Drag-to-reorder** the library.
- **Search/filter** the library.
- **Collections** — create/delete collections and assign each video to one.
- **Per-video watermark override** — set a video to always/never watermark regardless of the global default (see Video playback & security above); stored as portal-only metadata, never sent to bunny.net.
- **Per-video analytics** — a collapsible panel per video rolling up its existing share tracking: total shares, unique recipients, views, started, completed, completion rate, and average watched %. Reads only fields already stored by the share flow below — adds no new tracking and no new fetch (computed from the shares already loaded for the Shares tab). The same rollup is also listed, sorted by shares, in the Analytics tab's **Share performance by video**.

## Private share links (per-recipient sharing) _(admin)_
- Generate a one-off private link for any video, tied to a specific recipient email.
- **Forced login** — opening the link requires an Auth0 login and only plays if the logged-in email matches the one specified.
- Wrong-account attempts show a generic mismatch message — **the intended recipient's email is never revealed**.
- **Adjustable expiry** per link (default 72 hours, capped at 720 / 30 days).
- **Per-share watermark override** — Default/Always/Never selector in both the single and bulk share forms, stored only when explicitly chosen; overrides the video's and the global watermark setting for that link (see Video playback & security above).
- **Bulk share** _(admin)_ — multi-select any number of videos in the Videos tab and share all of them with several recipients in one action; every recipient × video pair gets its own independently-revocable link (capped at 50 videos, 50 recipients, 300 total links per action).
- **Email delivery** _(opt-in)_ — a checkbox emails the link(s) straight to each recipient via [Resend](https://resend.com), so the admin no longer has to copy-and-send by hand. Best-effort: a mail failure never blocks link creation.
- **Bundles: one place per recipient, not one email per action** — once a recipient has 2+ currently-active shares (from any single-share or bulk-share action, in any order), they automatically get one consolidated **bundle page** (`/b/[id]`) listing everything shared with them, and every later notification becomes one updated email pointing at that page instead of a new standalone email. Their first-ever share still gets a plain single-link email. Signing in once (the same Auth0 login every share already requires) unlocks the bundle page and every individual link addressed to that email — there's no separate re-verification step. The bundle page is a pure grouping list of ids; each item's title, expiry, and status is always read live from its own share record, so revoking or expiring one item is reflected instantly.
- **Resend** — re-deliver a link's own email to its original recipient (rate-limited, like link creation). Available singly per link or as a **bulk action** across a multi-selected set of links, with per-link success/failure reported so one bad link never blocks the rest of the batch.
- **Extend** — push a link's expiry forward from now (not from its old, possibly-already-passed expiry) without creating a new link or URL — the symmetric counterpart to revoke. Works on an already-expired-but-not-revoked link (the realistic "it lapsed, give me a few more days" case); refuses outright on a revoked link, so extend can never act as a silent un-revoke. If the link belongs to a bundle, extending it also pushes the bundle's own expiry forward so the bundle page doesn't lapse before that link does. Available singly or as a **bulk action** (one hours value applied across the selection, per-link success/failure reported).
- **Instant revocation** — kill any active link immediately, one click, or as a **bulk action** across a multi-selected set. Revoking is a soft-delete (the link is marked revoked, not deleted outright), so a revoked link stays visible with a "Revoked" status instead of silently disappearing, and can never be extended back to life.
- **Un-revoke** — undo an accidental revoke on a single link: clears the revoked mark and restores exactly the expiry the link had before it was revoked, no new link/token minted. Kept deliberately separate from both Extend and Bulk Revoke (neither can double as an un-revoke) as its own considered action.
- **Permanent delete** — once a link has been revoked, it can additionally be **permanently deleted**: a real removal from Redis, gone from the admin list for good. Only ever available after a soft-revoke, so the irreversible step is always a deliberate second act on top of the reversible one, never a shortcut around it.
- **Persistent bundle-link button** — any share row that belongs to a bundle shows a durable **Bundle link** button (copies `/b/[id]`) right alongside Resend/Extend/Revoke, not just a one-time link in the share-creation success toast.
- **Inert until configured** — the email checkbox and Resend button stay hidden unless `RESEND_API_KEY` is set; without it, sharing works exactly as before (copy the link manually).
- **Per-link status** — Active / Expired / Revoked, view count + last-viewed time (every visit counts, not just the first), and real playback signal reported by the player itself: play count, furthest-watched %, and a "Completed" badge — not just whether the page was opened.
- Expired/revoked links show the same clean "expired or doesn't exist" message either way, so a dead link never reveals which kind of dead it is.

## Watch history / "my activity" _(all approved viewers, plus admin lookup)_
- A nav-bar **Activity** link opens `/activity` for any signed-in approved viewer or admin (same server-side gate as the homepage).
- A viewer sees their own watch history — the same progress data already shown as "Continue watching" on the homepage, just as a full list (title, position/duration, last-watched time). No new tracking.
- **Admins additionally get a dropdown** to look up any approved viewer's watch history by email, via a new admin-only endpoint (`GET /api/admin/viewer-activity`, `requireAdmin`, restricted to emails on the approved-viewer list) that reads that viewer's own `progress:<email>` Redis hash — the same data `/api/progress` reads for the caller's own session.

## People & oversight _(admin)_
- **Approved viewer management** — add/remove emails, with **bulk add** (paste comma/space/newline-separated lists; validated + deduped).
- **Viewer last-seen** — each viewer's most recent activity time.
- **Activity / audit log** — the most recent admin actions (viewer add/remove, share create/resend/extend/revoke/unrevoke/purge including bulk actions, video rename/delete, collection create/delete, settings, palette), each with actor and time. Logging is best-effort so it never breaks the underlying action.
- **Analytics dashboard** — total views, 30-day views, watch time, video count, a 30-day views bar chart, and a most-watched list (from bunny.net video stats + the statistics API), plus a **Share performance by video** list (shares, recipients, views, started, completed, completion rate, avg progress — see Video management above for the same rollup as a per-video collapsible panel).
- **Viewer watermark settings** — global on/off default and a viewer-exemption list (see Video playback & security above).
- **Content-protection panel** — explains the tokenized-playback model and the bunny.net "Block Direct URL File Access" setting.

## Admin panel structure _(admin)_
- **Tabbed layout** — Videos, Viewers, Shares, Settings, Activity, Analytics — so admins jump straight to a section instead of one long scroll. Live count badges on Viewers/Shares.
- All admin API routes return `403` for non-admins rather than exposing any data.

## Installable app (PWA)
- **Installable on desktop and mobile** — Windows, Mac, Android, and iOS can install the portal as a standalone app (web manifest + app icon + service worker). No separate build or app store; it runs off the same Vercel deployment.
- **Login works unchanged** — the installed app is the same site, so Auth0 sign-in behaves exactly as in the browser.
- **Full admin in the installed app** — admin accounts see the Admin button and can manage everything from the installed (standalone) app, exactly as in a normal browser tab. (Admin access is still gated server-side, so nothing sensitive is exposed to non-admins either way.)
- Ships PNG app icons (192/512, maskable, plus a 180px Apple touch icon) so home-screen/taskbar icons render cleanly on every platform including iOS.
- The service worker caches only public static assets (app icons + manifest) — never API responses, authed pages, or video — so nothing private or stale is ever served.

## Push notifications
- **New-video announcements** — approved viewers who opt in with a **"Notify me"** button get a Web Push notification when a newly uploaded video finishes encoding. Each video is announced **exactly once** (an atomic Redis `SADD` guard), and only recently uploaded videos are announced, so enabling the feature never back-blasts the existing library.
- **Manual broadcasts** _(admin)_ — send a custom push message to everyone from the Settings tab.
- **Targeted & self-cleaning** — sends reach only **currently-approved** viewers and admins (a removed viewer stops receiving them even if their device subscription lingers); dead subscriptions (HTTP 404/410 from the push service) are pruned automatically.
- **Viewer-controlled** — the button toggles notifications on/off per device; unsubscribing is always allowed. Clicking a notification opens the relevant video.
- **Inert until configured** — the whole feature (button, broadcast form, sends) stays hidden and silent unless `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` are set, so it never breaks a deployment that doesn't use it.

## Platform, quality & observability
- Hosted on Vercel; dependencies install automatically during deploy (no local Node/npm required to ship).
- Settings, viewers, order, share records, bundles, watermark settings, watch history, push subscriptions, the theme, and the audit log are stored in Upstash Redis (via Vercel Storage), editable live from `/admin` without redeploying. All keys are namespaced with a `fable2:` prefix.
- Share expiry is a logical field (`expiresAt`), not raw Redis TTL — a link's own Redis record actually outlives its expiry by a 60-day grace window so an already-lapsed-but-not-revoked link can still be **extended**. All read paths (the share page, playback events, the bundle page) check `expiresAt`/`revokedAt` explicitly rather than relying on the record simply being gone.
- **Opt-in Sentry error monitoring** — modern instrumentation-file setup (client/server/edge); inert until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set.
- **CI pipeline** — GitHub Actions runs lint + tests + build on every push/PR to `main`, catching breakage before Vercel deploys.
- **Smoke tests** — Vitest coverage for the auth check, video-ordering logic, theme helpers, push logic, share/bundle logic, watermark precedence, and the per-video analytics rollup.

## Configuration knobs (environment)
- `BUNNY_CDN_HOSTNAME` — enables thumbnails.
- `BUNNY_CDN_TOKEN_KEY` — signs thumbnail URLs when the pull-zone token key differs from the embed key.
- `SENTRY_*` — enable error monitoring and source-map upload.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — enable push notifications (both required; generate with `npx web-push generate-vapid-keys`). `VAPID_SUBJECT` optionally overrides the contact URI.
- `RESEND_API_KEY` — enable emailing/resending share links via Resend. `MAIL_FROM` optionally sets the from address (a Resend-verified sender; defaults to `onboarding@resend.dev`).
- `GEO_WHITELIST` / `ADMIN_GEO_WHITELIST` — comma-separated ISO country codes for the viewer / admin geo whitelists (see Authentication & access control above). Each only takes effect once its enforcement toggle is turned on in `/admin` → Settings; off and inert by default.

## Known gaps / not yet implemented
- **Access-request flow** — no self-serve way for unapproved users to request access; admins must know who to add.
- **`email_verified` enforcement** — access checks trust the email claim; pair with Auth0 sign-up controls (see Security notes in the README).
- **In-app admin management** — admins are configured via `ADMIN_EMAILS`, not the UI.
- **Captions/transcripts, comments/ratings, scheduled publish/expiry** — not implemented.
