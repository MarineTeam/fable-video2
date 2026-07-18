---
name: config-and-env
description: >-
  Every configuration axis of the Marine Video Portal: the authoritative env-var
  catalog (required vs optional, server-only vs NEXT_PUBLIC build-baked,
  defaults, traps), the Redis-stored runtime settings editable live from /admin,
  how to recreate .env.local and the CI dummy env from scratch, and the
  add-a-new-config-axis checklist. Use when adding/changing/debugging an env var
  or admin setting, or when a feature seems "off" or misconfigured. Also home
  of the canonical CI dummy-env block and the secret-rotation runbook. Not for
  a configured feature actively misbehaving (see debugging-playbook),
  provisioning accounts (see run-and-operate), or data-model design rationale
  (see architecture-contract).
---

# Configuration and environment

Everything this app can be configured with, in one place. Facts verified
against code on 2026-07-18 (file:line citations throughout).

## The two kinds of configuration — pick the right one

| Kind | Lives in | Changed by | Takes effect |
|---|---|---|---|
| **Environment variables** | Vercel → Settings → Environment Variables (prod) / `.env.local` (local) | Editing the value, then **redeploying** | Next deploy. `NEXT_PUBLIC_*` vars additionally require a **rebuild** because Next.js inlines them into the client bundle at build time (on Vercel every deploy rebuilds, so "redeploy" covers it — but a runtime-only restart does not). |
| **Redis runtime settings** | Upstash Redis, keys prefixed `fable2:` (`lib/redis.js:19`) | The `/admin` UI | Immediately, no redeploy |

Decision rule: secrets, service endpoints, and feature on/off switches are env
vars; anything an operator should tune day-to-day without engineering help is a
Redis setting behind an admin API.

> Jargon: "NEXT_PUBLIC" is a Next.js convention — any env var whose name starts
> with `NEXT_PUBLIC_` is copied into the browser JavaScript at build time and is
> therefore public. Never put a secret in one.

## Environment variable catalog

Verified against every `process.env` read in the app
(`grep -rn "process.env" --include="*.js" pages lib components middleware.js *.js`
from repo root — re-run it before trusting this table).

### Required (app is broken or insecure without them)

| Var | Read where | Scope | Behavior when unset | Trap |
|---|---|---|---|---|
| `AUTH0_SECRET` | Implicitly by `new Auth0Client()` in `lib/auth0.js:6` | Server | Auth0 SDK logs a console WARNING at build; login is broken at runtime | Must be a random 32-byte value: `openssl rand -hex 32` |
| `APP_BASE_URL` | `Auth0Client` (redirect building) **and** `pages/api/admin/share.js:14` (share-link URLs; trailing `/` stripped) | Server | Share links fall back to `https://<request Host header>` (`share.js:16`); Auth0 redirects break | Auth0 v4 renamed this from `AUTH0_BASE_URL`. Locally must be `http://localhost:3000` |
| `AUTH0_DOMAIN` | `Auth0Client` | Server | Login broken | **No scheme** — `your-tenant.us.auth0.com`, not `https://…`. Renamed from `AUTH0_ISSUER_BASE_URL` in v4 |
| `AUTH0_CLIENT_ID` | `Auth0Client` | Server | Login broken | From the Auth0 application settings |
| `AUTH0_CLIENT_SECRET` | `Auth0Client` | Server | Login broken | From the Auth0 application settings |
| `BUNNY_LIBRARY_ID` | `lib/bunny.js:10` (every API call, all three signing schemes) | Server | All video listing/playback/upload broken | **Trimmed** in code — see universal rules below |
| `BUNNY_API_KEY` | `lib/bunny.js:11` | Server only — must never reach the client | Bunny API calls 401 | Trimmed. Part of the TUS upload signature |
| `BUNNY_TOKEN_AUTH_KEY` | `lib/bunny.js:80` (embed tokens), `:91` (thumbnail-key fallback) | Server | Signed embed URLs carry a wrong token → player shows 403 | Trimmed. Comes from the Bunny library's Security tab ("Embed View Token Authentication") |
| `ADMIN_EMAILS` | `lib/auth.js:10` (`adminEmails()`/`isAdmin()`); first entry is also the `VAPID_SUBJECT` fallback (`lib/push.js:36`) | Server | **Nobody is admin** — `/admin` and every `/api/admin/*` route are locked for everyone | Comma-separated; each entry is trimmed + lowercased before compare, so case/whitespace in the value is safe |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | `lib/redis.js:11-12` (lazy client — nothing connects at build time) | Server | Falls back to `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`; if neither set, every Redis-touching request errors (rate limiting fails open, guards fail closed) | `KV_*` (Vercel Marketplace names) win over `UPSTASH_*` (native names) because of the `||` order |

### Optional (features are inert until configured — never half-break)

| Var | Read where | Scope | Behavior when unset | Trap |
|---|---|---|---|---|
| `BUNNY_CDN_HOSTNAME` | `lib/bunny.js:88` | Server | `thumbnailUrl()` returns `null` → homepage renders a title list instead of a thumbnail grid | Trimmed. It's the library's CDN/pull-zone host, e.g. `vz-xxxx-xxx.b-cdn.net` |
| `BUNNY_CDN_TOKEN_KEY` | `lib/bunny.js:91` | Server | Falls back to `BUNNY_TOKEN_AUTH_KEY`; if neither, thumbnails are served **unsigned** (`bunny.js:92`) | Only needed when the pull zone's URL Token key differs from the embed key |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `components/NotifyButton.js:4` (client, **build-baked**), `lib/push.js:6,39`, `pages/admin.js:32` (server) | Both | Push UI hidden, push silently disabled | Baked into the bundle — changing it requires a rebuild. See half-configured trap below |
| `VAPID_PRIVATE_KEY` | `lib/push.js:6,40` | Server | Push disabled | Secret half of the keypair from `npx web-push generate-vapid-keys` (VAPID = the Web Push server-identification standard; protocol in the reference skill) |
| `VAPID_SUBJECT` | `lib/push.js:36` | Server | Defaults to `mailto:<first ADMIN_EMAILS entry>` (or `mailto:admin@example.com` if that's empty too) | Must be a `mailto:` or `https:` URI |
| `RESEND_API_KEY` | `lib/mail.js:5,17`; `pages/admin.js:31` (gates the email UI) | Server | Share-link email UI hidden; `sendShareEmail` returns `{ok:false, skipped:true}` — link creation still works | Mail is best-effort: a send failure never blocks link creation (`pages/api/admin/share.js:79`) |
| `MAIL_FROM` | `lib/mail.js:11` | Server | Defaults to `onboarding@resend.dev` (Resend's test sender) | Production value must be a Resend-verified sender, e.g. `Marine Video Portal <share@yourdomain.com>` |
| `SENTRY_DSN` | `sentry.server.config.js:4`, `sentry.edge.config.js:4` | Server + edge runtime | Sentry init is skipped entirely — inert | Server-side errors only |
| `NEXT_PUBLIC_SENTRY_DSN` | `instrumentation-client.js:4` | Client, **build-baked** | Client Sentry inert | Rebuild to change, like all `NEXT_PUBLIC_*` |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | `next.config.js:9-11,16` | **Build-time only** | Source-map upload disabled (`sourcemaps.disable` is true without the auth token); build still succeeds | These configure the build plugin, not the running app |

### Feature-enablement combinations

| Feature | On when | Off means |
|---|---|---|
| Web Push | **BOTH** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` set (`lib/push.js:5-7`) | Notify button and broadcast composer hidden; `/api/push/subscribe` and `/api/admin/broadcast` return 400; `sendToAll`/`announceNewVideos` no-op |
| Share-link email | `RESEND_API_KEY` set (`lib/mail.js:4-6`) | "Email the link" checkbox and "Resend email" button hidden; nothing ever sent |
| Thumbnails | `BUNNY_CDN_HOSTNAME` set | Title list instead of grid (playback unaffected) |
| Sentry capture | Respective DSN set | Completely inert (SDK never initialized) |
| Sentry source maps | `SENTRY_AUTH_TOKEN` (+ org/project) at build | Maps not uploaded; stack traces are minified |

**Half-configured push trap:** `components/NotifyButton.js` only checks the
public key (it's client code and can't see server env), so setting
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` without `VAPID_PRIVATE_KEY` shows the "Notify me"
button but every subscribe attempt hits the `pushEnabled()` 400 in
`pages/api/push/subscribe.js:7`. Always set both or neither.

## Universal rules

1. **Env changes require a redeploy on Vercel.** Nothing re-reads the
   environment live.
2. **`NEXT_PUBLIC_*` values are inlined at build time.** A rebuild (which every
   Vercel deploy performs) is required; a runtime restart is not enough.
3. **All `BUNNY_*` values are `.trim()`ed in code** (`lib/bunny.js:9`) because a
   stray newline pasted into Vercel corrupts TUS upload signatures (this is the
   README's "Upload fails with HTTP 401" incident). If uploads 401 anyway,
   re-paste the values cleanly — and keep the trim when refactoring.
4. **Optional features must be inert until configured.** No crashes, no broken
   buttons, no half-features when a var is missing. Every optional var above
   follows this; new ones must too.
5. **Missing required vars do not fail the build.** Verified 2026-07-18:
   `next build` succeeds with zero app env vars — `Auth0Client` only logs a
   console WARNING (it does not throw at construction), and Redis/Bunny/admin
   reads are all lazy. The failure surfaces at runtime (broken login, erroring
   API routes). Don't rely on the build to catch a missing secret; use the CI
   dummy block as the canonical "what the build environment should contain"
   list anyway.

## Redis runtime settings (live-editable from /admin, no redeploy)

Only the admin-tunable axes are listed here. The full Redis data-model
inventory (shares, progress, audit, push subs, …) lives in
`.claude/skills/architecture-contract/SKILL.md` — do not duplicate it.

All keys use the `k()` prefix helper → **`fable2:`** (`lib/redis.js:19`).
Beware: README/FEATURES and the comment above that line still say `pvp:` —
they are stale; the code is authoritative.

| Setting | Redis key | Edited at | API | Validation / default |
|---|---|---|---|---|
| Homepage video count | `fable2:settings:homeCount` | /admin → Settings | GET/POST `/api/admin/settings` | Integer, clamped 1–200 at **both** write (`pages/api/admin/settings.js:23`) and read (`settings.js:15`, `pages/api/videos.js:26`); default **48** when unset/unparseable |
| Custom video order | `fable2:order` | /admin → drag-to-reorder | POST `/api/admin/order` | JSON array of video GUIDs; max 500 entries, each a non-empty string ≤64 chars (`pages/api/admin/order.js:11-16`). Unplaced videos sort newest-first on top; deleting a video prunes its GUID (`pages/api/admin/videos.js:68-70`) |
| Theme / palette | `fable2:theme` | /admin → theme picker | GET `/api/theme` (public — colors only), POST (admin) | 7 presets in `lib/theme.js:8-16` (ocean, abyss, reef, coral, dusk, gold, mono) + custom; `validateTheme` requires all 6 color keys (`bg, panel, text, muted, accent, accent2`) as `#rrggbb` hex, name ≤32 chars; invalid → default Ocean. Client caches it in localStorage under `pvp:theme` (`lib/theme.js:20` — that client-side name legitimately still says pvp) |
| Approved viewers | `fable2:viewers` (SET) + `fable2:viewer:lastseen` (HASH) | /admin → Viewers | GET/POST/DELETE `/api/admin/viewers` | Emails normalized (trim+lowercase) and regex-validated; POST accepts a single email, array, or pasted blob split on commas/whitespace/semicolons, deduped, capped at 500 per request (`pages/api/admin/viewers.js:26-47`) |

## Recreate the environment from scratch

### Local `.env.local` (repo root; git-ignored by Next.js convention)

```bash
cat > .env.local <<'EOF'
# --- Required ---
AUTH0_SECRET=REPLACE_WITH_openssl_rand_hex_32
APP_BASE_URL=http://localhost:3000
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
BUNNY_LIBRARY_ID=...
BUNNY_API_KEY=...
BUNNY_TOKEN_AUTH_KEY=...
ADMIN_EMAILS=you@example.com
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=...
# --- Optional (feature toggles; safe to omit) ---
# BUNNY_CDN_HOSTNAME=vz-xxxx-xxx.b-cdn.net
# BUNNY_CDN_TOKEN_KEY=...
# NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
# VAPID_PRIVATE_KEY=...
# VAPID_SUBJECT=mailto:you@example.com
# RESEND_API_KEY=...
# MAIL_FROM=Marine Video Portal <share@yourdomain.com>
# SENTRY_DSN=...
# NEXT_PUBLIC_SENTRY_DSN=...
# SENTRY_ORG=... SENTRY_PROJECT=... SENTRY_AUTH_TOKEN=...
EOF
```

Where the real values come from (Auth0 app, Bunny library, Upstash database
provisioning) is `run-and-operate`'s territory — see
`.claude/skills/run-and-operate/SKILL.md`.

### Key-generation commands

```bash
openssl rand -hex 32                 # AUTH0_SECRET
npx web-push generate-vapid-keys     # NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
```

### CI dummy env (build without real services) — CANONICAL COPY

This is the **single home** for the dummy-env block. change-control,
debugging-playbook, run-and-operate, and campaign-email-verified all
cross-reference this section instead of carrying their own copies — when a
build-required variable is added, update `.github/workflows/ci.yml` AND this
section, and every sibling stays correct automatically.

Source of truth: `.github/workflows/ci.yml` (the build step's `env:` block),
mirrored here verbatim. The values only need to exist so `next build` can
compile; nothing is contacted:

```yaml
AUTH0_SECRET: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
APP_BASE_URL: http://localhost:3000
AUTH0_DOMAIN: example.us.auth0.com
AUTH0_CLIENT_ID: ci-dummy
AUTH0_CLIENT_SECRET: ci-dummy
BUNNY_LIBRARY_ID: '1'
BUNNY_API_KEY: ci-dummy
BUNNY_TOKEN_AUTH_KEY: ci-dummy
ADMIN_EMAILS: admin@example.com
KV_REST_API_URL: https://example.upstash.io
KV_REST_API_TOKEN: ci-dummy
```

Copy-pasteable bash form (same values, run from repo root):

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

### Rotating a leaked or expiring secret

No skill owned this until 2026-07-18; it lives here because rotation is a
config operation. The generic sequence, for any secret in the catalog:

1. Generate the replacement at the owning service (Bunny dashboard / Auth0
   application settings / Upstash / `openssl rand -hex 32` for
   `AUTH0_SECRET` / `npx web-push generate-vapid-keys` for VAPID).
2. Update the value in Vercel → Settings → Environment Variables, then
   **redeploy** (env changes never apply to running deployments). If the
   secret is `NEXT_PUBLIC_*` (VAPID public key), a rebuild is required and
   every subscribed browser must re-subscribe — see the catalog row.
3. Revoke/delete the old credential at the owning service **after** the new
   deployment is confirmed working (`env-doctor` + a login + a playback).
4. Consequences to expect: rotating `AUTH0_SECRET` invalidates all session
   cookies (everyone re-logs-in — harmless); rotating `BUNNY_TOKEN_AUTH_KEY`
   must be paired with updating the same key in the Bunny library's Security
   tab or every embed/thumbnail 403s; rotating VAPID keys orphans existing
   push subscriptions (they are pruned automatically on next send).
5. Audit: nothing in-app logs rotations — note it in the PR/issue that
   triggered it.

## "Add a new configuration axis" checklist

1. **Env var or Redis setting?** Secret / service endpoint / on-off feature
   toggle → env var. Operator-tunable knob that should change without a
   deploy → Redis setting behind an admin API route (follow
   `pages/api/admin/settings.js` as the template: `requireAdmin`, clamp/validate
   on write AND read, sane default on missing/error, `logAction` audit entry).
2. **Naming.** Env: `SCREAMING_SNAKE`, prefixed by service (`BUNNY_`,
   `AUTH0_`, `SENTRY_`); `NEXT_PUBLIC_` only if the browser genuinely needs it
   (and then it is public — no secrets). Redis: lowercase, always through
   `k()` — never hardcode the `fable2:` prefix.
3. **Trim and validate at the read site.** Any value an operator will paste
   into Vercel should be trimmed (follow `lib/bunny.js:9`). Redis values must
   be validated on read too, since Redis can hold stale/foreign data.
4. **Optional ⇒ inert until configured.** The feature's UI must hide and its
   API routes must cleanly refuse (or no-op) when unconfigured — model on
   `pushEnabled()` / `mailEnabled()`. Never let a missing optional var throw.
5. **Document:** add a row to the README env table (and FEATURES.md if it
   gates a feature) in the same PR — see
   `.claude/skills/docs-and-writing/SKILL.md`.
6. **CI:** if the build reads it (any `NEXT_PUBLIC_*`, anything in
   `next.config.js`), add a dummy value to the `.github/workflows/ci.yml`
   build env block **and to the canonical dummy-env block in this skill's
   "CI dummy env" section** — change-control, debugging-playbook,
   run-and-operate, and campaign-email-verified all cross-reference it
   instead of carrying copies.
7. **This skill:** add the var/setting to the catalog above and a re-verify
   line to Provenance below.

## When NOT to use this skill

- Provisioning the Auth0 tenant, Bunny library, or Upstash database, deploy
  flow, or operating /admin day-to-day → `.claude/skills/run-and-operate/SKILL.md`.
- Why state lives where it does, the full Redis key inventory, invariants →
  `.claude/skills/architecture-contract/SKILL.md`.
- A configured feature misbehaving (uploads 401, thumbnails missing, login
  loops) → `.claude/skills/debugging-playbook/SKILL.md` (this skill only tells
  you what the knobs are).
- How the third-party services themselves work (signing schemes, Auth0 v4 SDK,
  VAPID) → `.claude/skills/reference/SKILL.md`.

## Provenance and maintenance

Derived 2026-07-18 by reading every `process.env` consumer, the admin settings
API routes, `lib/{bunny,redis,auth,auth0,push,mail,theme}.js`,
`.github/workflows/ci.yml`, and the README env tables, and by running
`next build` with zero env vars to confirm it succeeds (Auth0Client warns, does
not throw). Re-verify before trusting:

```bash
# The complete, authoritative list of env consumers (compare against the catalog):
grep -rn "process.env" --include="*.js" --include="*.mjs" pages lib components middleware.js *.js *.mjs
# Redis key prefix is still fable2: (docs may still say pvp:):
grep -n "fable2" lib/redis.js
# Bunny values still trimmed:
grep -n "trim" lib/bunny.js
# Feature gates unchanged:
grep -n "pushEnabled\|mailEnabled" lib/push.js lib/mail.js
# homeCount default/clamp:
grep -n "DEFAULT_COUNT\|Math.min(Math.max" pages/api/admin/settings.js pages/api/videos.js
# CI dummy block still matches the recipe here:
grep -n -A12 "Dummy values" .github/workflows/ci.yml
# KV_*/UPSTASH_* fallback order:
grep -n "KV_REST_API" lib/redis.js
```

If any grep output disagrees with this file, the code wins — update this file.
