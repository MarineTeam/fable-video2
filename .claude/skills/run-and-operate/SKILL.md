---
name: run-and-operate
description: "Run, deploy, and operate the Marine Video Portal. Use when you need to: start local dev, run lint/test/build, understand CI failures (red X on ci.yml), deploy or redeploy on Vercel, provision Auth0/Bunny/Upstash from scratch, or operate any /admin tab (upload videos, manage viewers, share links, settings, activity, analytics). Not for debugging broken behavior (see debugging-playbook), env var reference (see config-and-env), or inspecting Redis state (see diagnostics-and-tooling)."
---

# Run and Operate — Marine Video Portal

How to run this project locally, what CI does, how deploys work, how to provision
the three external services from nothing, and how to operate the `/admin` panel.
Written for engineers AND non-developer operators — jargon is defined where it
first appears. All commands run from the repo root. Facts verified against the
code on 2026-07-18.

**Not this skill's job:** something is *broken* → `.claude/skills/debugging-playbook/SKILL.md`.
What an env var means / how to add one → `.claude/skills/config-and-env/SKILL.md`.
Measuring live state (Redis contents, signed URLs) → `.claude/skills/diagnostics-and-tooling/SKILL.md`.
Why the system is shaped this way → `.claude/skills/architecture-contract/SKILL.md`.

---

## 1. Commands (all verified working)

Requires Node >= 20.9 (`engines` in `package.json`; CI runs Node 24). Check with
`node --version`.

| Command | What it actually runs | Needs env? | Notes |
|---|---|---|---|
| `npm install` | installs dependencies | no | CI uses `npm install --no-audit --no-fund` |
| `npm run dev` | `next dev` → http://localhost:3000 | **yes** — `.env.local` | Real services needed to log in / see videos. See below. |
| `npm run lint` | `eslint .` | no | ESLint is deliberately pinned to 9.x — do NOT upgrade to 10 (see change-control) |
| `npm test` | `vitest run` | no | 4 files, 30 tests, <1s. Tests live only in `lib/__tests__/` |
| `npm run build` | `next build` | **yes** | Use the dummy-env one-liner below for a services-free build check |
| `npm start` | `next start` | yes | Serves the output of a prior `npm run build` |

**Dev server env:** copy the required variables from the README table (or
`config-and-env`) into a file named `.env.local` in the repo root, with
`APP_BASE_URL=http://localhost:3000`. Next.js loads it automatically. Without it,
pages that touch Auth0/Bunny/Redis will error.

**Build without any real services** (same dummy values CI uses — they only need
to exist so `next build` can compile; nothing is contacted):

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

Pre-push checklist: `npm run lint && npm test`, then the build one-liner above.
That is exactly what CI will do.

---

## 2. CI anatomy (`.github/workflows/ci.yml`)

**Triggers:** every push to `main` and every pull request targeting `main`.
Nothing else (no schedule, no other branches).

**One job, `verify`, on ubuntu-latest, Node 24**, four steps in order — it stops
at the first failure:

| Step | Command | A red X here means |
|---|---|---|
| Install dependencies | `npm install --no-audit --no-fund` | Broken `package.json`, unresolvable dependency, or registry outage. Rare. |
| Lint | `npm run lint` | An ESLint rule violation. Run `npm run lint` locally to see it. If the error is a `TypeError` about `scopeManager.addGlobals`, someone upgraded ESLint to 10 — revert to the 9.x pin (see change-control). |
| Test | `npm test` | A Vitest failure in `lib/__tests__/`. Run `npm test` locally. |
| Build | `npm run build` (with the dummy env block) | A compile/build error — bad import, syntax error, Next.js config problem. Reproduce with the one-liner in section 1. |

**Why the dummy env values exist:** `next build` evaluates modules at build time,
and the Auth0 client and page code expect config to be present. The values are
fakes (`ci-dummy`, `example.us.auth0.com`) — CI never contacts real services; it
only proves the code compiles. If you add a new *required* env var to the app,
add a dummy value to the `Build` step's `env:` block too, or CI's build will break
(full checklist: `config-and-env`).

CI does **not** deploy. It is a parallel check — see next section.

---

## 3. Deploy flow (Vercel)

- **Vercel auto-deploys every push to `main`.** There is no deploy script in this
  repo. Merging (or pushing) to `main` *is* the deploy.
- **CI and Vercel run in parallel and independently.** A red CI does not stop the
  Vercel deploy by itself. To make it blocking, enable GitHub branch protection
  requiring the `verify` check on PRs (README recommends this).
- **Env var change → redeploy required.** Editing a variable in Vercel → Settings
  → Environment Variables affects only *new* deployments. After any change, hit
  Redeploy (or push a commit).
- **`NEXT_PUBLIC_*` change → rebuild required.** `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
  is baked into the client bundle at build time. A restart is not enough — it
  needs a fresh build (a normal Vercel redeploy does rebuild, so in practice:
  redeploy, and do not expect a runtime-only restart to pick it up).
- **There is no migration step.** The Redis schema is implicit — code reads and
  writes keys directly; nothing creates or migrates them. Deploying new code
  never transforms stored data.
- **Key-prefix landmine:** all Redis keys are prefixed `fable2:` by `k()` in
  `lib/redis.js` (the comment above that line, the README, and FEATURES.md still
  say `pvp:` — they are stale; the code is the truth). Consequence: any data
  written by a pre-rename deployment lives under `pvp:*` and is **orphaned** —
  viewers, shares, order, theme, progress, audit all silently appear empty after
  the rename until someone manually copies `pvp:*` keys to `fable2:*`. The
  incident history is in `debugging-playbook`; inspect what actually exists in
  Redis with `diagnostics-and-tooling`.
- **Rollback:** Vercel dashboard → Deployments → promote a previous deployment.
  Since state is all in Redis/Bunny, rolling back code never loses data (but an
  old build carries its old baked-in `NEXT_PUBLIC_*` values).

---

## 4. One-time provisioning runbook (from zero to a working portal)

Do these in order. Each produces values for the env table in `config-and-env`
(also in README).

### 4.1 bunny.net (video storage + playback)

1. Create a **Stream library** (bunny.net dashboard → Stream). Note the
   **library ID** → `BUNNY_LIBRARY_ID`, and the library **API key** → `BUNNY_API_KEY`.
2. Library → **Security tab** → enable **Embed View Token Authentication**. Copy
   the key → `BUNNY_TOKEN_AUTH_KEY`. Without this, playback token signing does
   not match and embeds fail.
3. Optional (needed for homepage thumbnails): note the library's CDN/pull-zone
   hostname (looks like `vz-xxxx-xxx.b-cdn.net`) → `BUNNY_CDN_HOSTNAME`. If the
   pull zone has its own URL Token Authentication key different from the embed
   key, that key → `BUNNY_CDN_TOKEN_KEY`.
4. Paste all Bunny values **cleanly** — a stray newline/space corrupts upload
   signatures (the app trims, but re-paste cleanly if uploads 401).

### 4.2 Auth0 (login)

1. Create a **Regular Web Application** in your Auth0 tenant.
2. In the application settings, set exactly:
   - **Allowed Callback URLs:** `https://your-domain/auth/callback`
     — note it is **`/auth/callback`**, NOT `/api/auth/callback`. This app uses
     the Auth0 **v4** SDK, which dropped the `/api` prefix; the old URL from v3
     tutorials will fail with a callback mismatch.
   - **Allowed Logout URLs:** `https://your-domain`
   - **Allowed Web Origins:** `https://your-domain`
3. Copy **Domain** (without `https://`) → `AUTH0_DOMAIN`, **Client ID** →
   `AUTH0_CLIENT_ID`, **Client Secret** → `AUTH0_CLIENT_SECRET`.
4. **Disable sign-ups**: Authentication → Database → your connection →
   **Disable Sign Ups**. Add users manually under User Management → Users.
   **Why this is load-bearing:** the portal grants admin and viewer access purely
   by comparing the logged-in email against admin-managed lists — and it does not
   verify email ownership beyond the Auth0 session claim. With open sign-ups, a
   stranger could self-register an account claiming an approved or admin email
   address. Disabled sign-ups are the guard. Never re-enable them.
5. Generate `AUTH0_SECRET` with `openssl rand -hex 32`.

### 4.3 Vercel + Upstash Redis (hosting + state)

1. Vercel → Import the GitHub repo as a new project (framework auto-detected).
2. Project → **Storage** tab → connect an **Upstash Redis** database (Marketplace).
   This auto-injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` — do not set them by
   hand.
3. Settings → Environment Variables → add everything from 4.1/4.2 plus
   `APP_BASE_URL` (exact production URL, no trailing slash) and `ADMIN_EMAILS`
   (comma-separated). Full table and optional extras (push, email, Sentry):
   `config-and-env`.
4. Deploy (push to `main` or hit Deploy).

### 4.4 First login

1. Visit the production URL, log in with an email listed in `ADMIN_EMAILS`
   (the Auth0 user you created manually).
2. Go to `/admin`:
   - Settings tab → set homepage video count, pick a palette.
   - Viewers tab → add approved viewer emails.
   - Videos tab → upload/organize videos.
3. Sanity check: log in with a non-viewer account in a private window — it should
   see a "not approved" message, not the library.

---

## 5. Operator runbook — the `/admin` panel

`/admin` is a tabbed panel available only to `ADMIN_EMAILS` accounts (non-admins
are redirected before any admin UI is sent, and every admin API independently
rejects them). Tabs: **Videos, Viewers, Shares, Settings, Activity, Analytics**.
Every admin action is recorded to the Activity log (best-effort — see 5.5).

### 5.1 Videos

**Upload lifecycle** (drag-and-drop or "browse"):
1. The server creates the video record on bunny.net and hands the browser a
   signed upload ticket (valid 6 hours). Rate limit: 20 uploads/hour per admin.
2. The file streams **from your browser directly to bunny.net** (resumable TUS
   protocol) — closing the tab mid-upload interrupts it; the row offers Retry
   (which gets a fresh ticket). Cancel aborts and deletes the half-created video.
3. After "Uploaded", Bunny encodes it. The library row shows a
   **"Processing N%"** badge, auto-refreshed every 10 seconds until done. A video
   becomes playable once it reaches transcoding/finished (Bunny status 3/4);
   a **"Failed"** badge means Bunny status 5/6 — delete and re-upload.

**Other operations:**
- **Rename** (pencil icon) — saved to Bunny, max 200 chars.
- **Delete** (trash) — after a confirm dialog, **permanently deletes the video
  from bunny.net** (the only copy of the bytes). It also prunes the video from
  the saved homepage order. There is no undo.
- **Drag-to-reorder** — sets the custom homepage order. Only works when the
  filter box is empty (the UI says so). New uploads float to the top until placed.
- **Collection dropdown** per video, plus a Collections manager (create/delete;
  deleting a collection keeps its videos).
- **Share** button per video — opens the share-link form (see 5.3).

### 5.2 Viewers

The approved-viewer list is the access-control list for the whole library.
- **Add** — one email, or **Bulk add** (paste a list separated by commas, spaces,
  semicolons, or new lines; up to 500 per submit; emails are normalized,
  validated, and deduped; the result message reports invalid entries).
- **Remove** — after a confirm dialog, revokes access on their next request and
  clears their last-seen record. Instant, no redeploy.
- Each row shows the viewer's **last-seen** time (stamped best-effort when they
  use the site; "—" means never seen or the stamp failed silently).
- Caution: adding a viewer does NOT create their Auth0 login — with sign-ups
  disabled you must also add them in Auth0 (User Management → Users), or they
  cannot log in at all.

### 5.3 Shares

Private, recipient-locked links at `/s/<id>` for one-off sharing to people who
are not approved viewers.
- **Create** (from the Videos tab Share button): recipient email + expiry in
  hours — **1 to 720 (30 days), default 72**. Rate limit: 10 creations/min per
  admin. If email is configured (`RESEND_API_KEY`), a checkbox offers to email
  the link to the recipient; a mail failure never blocks creation — copy the link
  by hand. If email is not configured, the checkbox simply does not appear.
- **Shares tab** lists every active link with the video title, recipient, created
  and expiry times, and a **Viewed / Not viewed** badge (stamped on the
  recipient's first open, hover for the timestamp).
- **Resend email** re-delivers the link to the original recipient (only visible
  when email is configured; same rate limit).
- **Revoke** kills the link immediately (confirm dialog, no undo — create a new
  link if needed). Expired links disappear from the list on their own.
- The recipient must log in with the exact email the link was created for; a
  mismatch shows a generic message that never reveals the intended recipient.

### 5.4 Settings

- **Homepage count** — max videos shown on the homepage, 1–200 (default 48).
  Applies live.
- **Color palette** — 7 presets plus custom hex fields. **Applies to ALL
  visitors, live, no redeploy** — this changes the look of the whole site for
  everyone, so treat it as a public-facing change, not a personal preference.
- **Push broadcast** — composer for a manual push notification (title required,
  max 80 chars; body optional, max 200) sent to every opted-in device of current
  viewers and admins. Only visible when both VAPID keys are configured. Reports
  how many devices were reached and how many dead subscriptions were pruned.
- **Content protection** — informational panel (no controls).

### 5.5 Activity

The most recent admin actions, newest first: viewer add/remove, share
create/resend/revoke, video upload/rename/delete/collection-change, settings,
palette, collections. The panel shows the last **100** entries; Redis stores at
most **200** (older ones are trimmed forever). Logging is **best-effort**: a
logging failure never blocks the action being logged, so the log can have gaps —
treat it as an operational aid, **not** a complete or tamper-proof audit trail.

### 5.6 Analytics

Two data sources, both bunny.net, both best-effort (a partial Bunny outage shows
zeros rather than an error):
- **Per-video view counters** from the Bunny video list → Total views, Videos
  count, Most-watched list (top 8).
- **Bunny Statistics API** (last 30 days) → the 30-day views chart, "Views
  (30 days)", and "Watch hours (30 days)".

These are Bunny's numbers, not the portal's — they count embed plays and include
nothing about *who* watched. Per-viewer "who watched what" does not exist beyond
the continue-watching progress data (see `architecture-contract`).

---

## 6. Where everything lives (data and artifact conventions)

| Thing | Where | Notes |
|---|---|---|
| Video files (the only copy) | bunny.net Stream library | Never touch this server. Deleting in /admin deletes from Bunny permanently. |
| All app state | Upstash Redis, keys prefixed `fable2:` | Viewers, order, shares, settings, theme, progress, push subs, audit. Authoritative key inventory: `architecture-contract`. README/FEATURES saying `pvp:` are stale — `lib/redis.js` line 19 is the truth. |
| Server-side files | **none** | Vercel serverless: no writable filesystem, no uploads directory, no local DB. If a change needs a server file, the design is wrong for this platform. |
| Logs | Vercel dashboard → project → Logs (function logs) | Plus Sentry error capture if `SENTRY_DSN` is set (inert otherwise). There is no log file in the repo or on any server. |
| Build artifacts | `.next/` locally (gitignored); Vercel builds its own | Never commit `.next/`. |
| Client-side leftovers | Browser localStorage key `pvp:theme`; service-worker cache `pvp-static-v1` | These `pvp` names are legitimate and current — only the Redis prefix was renamed. |

---

## 7. When NOT to use this skill

| Situation | Go to |
|---|---|
| Something is failing (login loop, 401 upload, missing thumbnails, empty admin lists…) | `.claude/skills/debugging-playbook/SKILL.md` |
| What does env var X mean / how do I add a new config axis | `.claude/skills/config-and-env/SKILL.md` |
| Inspect Redis contents, verify a signed URL, probe an API | `.claude/skills/diagnostics-and-tooling/SKILL.md` |
| Why is it built this way / Redis data model / invariants | `.claude/skills/architecture-contract/SKILL.md` |
| How to make and gate a code change | `.claude/skills/change-control/SKILL.md` |

---

## Provenance and maintenance

Derived 2026-07-18 by reading and cross-checking: `package.json` (scripts,
engines), `.github/workflows/ci.yml` (triggers, steps, dummy env), `README.md`
(provisioning, deploy, common issues), `pages/admin.js` (every tab's actual
behavior), `pages/api/admin/{videos,viewers,share,shares,settings,audit,analytics,upload}.js`
(limits, lifecycles, pruning), `lib/{redis,audit,bunny}.js` (key prefix, audit
cap, status codes, env trimming). Commands in section 1 were run successfully on
that date.

Re-verify before trusting, if this file is old:

| Claim | One-liner |
|---|---|
| Scripts and Node engine | `grep -n -A8 '"scripts"' package.json && grep -n '"node"' package.json` |
| CI steps + dummy env | `cat .github/workflows/ci.yml` |
| Redis prefix is `fable2:` | `grep -n "fable2" lib/redis.js` |
| Share expiry 1–720h default 72 | `grep -n "DEFAULT_HOURS\|MAX_HOURS" pages/api/admin/share.js` |
| homeCount clamp 1–200 default 48 | `grep -n "DEFAULT_COUNT\|Math.min" pages/api/admin/settings.js` |
| Audit cap 200 / shown 100 | `grep -n "MAX_ENTRIES" lib/audit.js && grep -n "recentActions" pages/api/admin/audit.js` |
| Upload 20/h, share 10/min limits | `grep -rn "allowRequest" pages/api/admin/` |
| Delete prunes saved order | `grep -n "Prune" pages/api/admin/videos.js` |
| Admin tab list | `grep -n "const TABS" pages/admin.js` |
| Bunny playable statuses | `grep -n "isPlayable" lib/bunny.js` |
