---
name: security-analysis-toolkit
description: First-principles proof methods for the Marine Video Portal's security claims — prove it, don't eyeball it. Use when a change touches auth, guards, signing, sessions, share links, or adds any page/API route; when reviewing a security-touching PR (change-control requires the matrix re-check); or when asked "is this safe?". Contains the entry-point×guard matrix method (with the verified matrix), token-signature verification recipes, information-leak analysis, secret trust-boundary tracing, and the fail-open/fail-closed audit. Not for executing the email_verified campaign (see campaign-email-verified) or writing tests (see validation-and-qa).
---

# Security analysis toolkit

Five recipes. Each is a method you re-run, followed by the worked result as of
2026-07-18 (every row verified by reading the cited file). A claim without one
of these analyses behind it is an opinion, not a security property.

**Jargon, once:** *GSSP* = `getServerSideProps`, Next.js server-side page
code that runs before any UI is sent. *Guard* = the helpers in `lib/guard.js`
(`requireAdmin`, `requireViewer`) or an equivalent inline check. *Fail closed*
= on error, deny. *Fail open* = on error, allow.

## Recipe 1 — The entry-point × guard matrix

Every reachable surface gets a row; every row gets an explicit guard decision.
**Acceptance rule: a new page or API route without a row here (and a guard
decision in code) does not merge** — and any diff that changes a row is
security-touching per change-control.

Regenerate the surface list:

```bash
find pages -name "*.js" | grep -v __tests__     # every page + API route
grep -rn "requireAdmin\|requireViewer\|getSessionEmail\|getSession" pages lib/guard.js
grep -n "matcher" middleware.js                  # what bypasses the session-rolling middleware
```

Verified matrix (2026-07-18):

| Surface | Methods | Guard | Notes |
|---|---|---|---|
| `/` (index.js) | page | GSSP: session → login redirect; unapproved see "Not approved" shell, no data | props: own email/admin/approved flags only |
| `/admin` (admin.js) | page | GSSP: session → login; non-admin → redirect `/` before any UI | props: own email + mailOn/pushOn booleans |
| `/watch/[id]` | page | GSSP: session → login; non-approved → redirect `/`; id regex `^[0-9a-f-]{10,64}$` | props include a fresh signed embed URL (by design, time-limited) |
| `/s/[id]` | page | GSSP: session → login; then share-token existence + recipient email match; id regex `^[A-Za-z0-9_-]{8,64}$` | recipients need NOT be approved viewers — that is the feature |
| `/auth/login,logout,callback,profile` | routes | mounted by Auth0 v4 middleware (`middleware.js`) | `/auth/profile` returns only the caller's own session |
| `/api/videos` | GET | `requireViewer` + rate limit 60/min/email | 405 otherwise |
| `/api/collections` | GET | `requireViewer` | |
| `/api/progress` | GET, POST | `requireViewer` | data keyed by caller's own email — cannot read others' |
| `/api/theme` | GET | **none — deliberately public** | leaks only the palette; rationale in file header comment |
| `/api/theme` | POST | `requireAdmin` | |
| `/api/push/subscribe` | POST | `pushEnabled()` then `requireViewer` | 400 when push unconfigured |
| `/api/push/unsubscribe` | POST | session-only (`getSessionEmail`) | deliberate: a removed viewer may silence their own device |
| `/api/admin/videos` | GET, PUT, DELETE | `requireAdmin` | |
| `/api/admin/viewers` | GET, POST, DELETE | `requireAdmin` | |
| `/api/admin/settings` | GET, POST | `requireAdmin` | |
| `/api/admin/order` | POST | `requireAdmin` | |
| `/api/admin/share` | POST | `requireAdmin` + rate limit 10/min | create + resend |
| `/api/admin/shares` | GET, DELETE | `requireAdmin` | |
| `/api/admin/upload` | POST | `requireAdmin` + rate limit 20/hour | |
| `/api/admin/collections` | GET, POST, DELETE | `requireAdmin` | |
| `/api/admin/audit` | GET | `requireAdmin` | |
| `/api/admin/analytics` | GET | `requireAdmin` | |
| `/api/admin/broadcast` | POST | `requireAdmin` | |
| static: manifest, sw.js, icons, robots.txt | GET | none — excluded by middleware matcher | required for PWA install pre-login |

Subtleties found and accepted: `/api/theme` GET public (colors only);
`/api/push/unsubscribe` session-only by design; `/s/[id]` bypasses viewer
approval by design. Every unlisted method on every route falls through to 405.

Automated cross-check of the deny half of this matrix:
`node .claude/skills/diagnostics-and-tooling/scripts/smoke-probe.mjs <url>`.

**Re-run when:** any file under `pages/` is added/removed, any guard call
changes, or `middleware.js`'s matcher changes.

## Recipe 2 — Token-signature verification from first principles

Never trust that signing code is right because it "works in the browser" —
re-derive the token independently and compare. Method: compute the vendor
formula yourself with `node:crypto` on fixed inputs, call the app's function,
compare strings exactly. (Full formula semantics: see the reference skill.)

Worked example (executed 2026-07-18; all three matched):

```bash
BUNNY_LIBRARY_ID=123 BUNNY_API_KEY=dummykey BUNNY_TOKEN_AUTH_KEY=tokkey \
BUNNY_CDN_HOSTNAME=vz-test.b-cdn.net node -e "
import('./lib/bunny.js').then(async (b) => {
  const crypto = await import('node:crypto');
  const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const u = new URL(b.signedEmbedUrl(guid));
  const exp = u.searchParams.get('expires');
  const expected = crypto.createHash('sha256').update('tokkey' + guid + exp).digest('hex');
  console.log('embed token match:', u.searchParams.get('token') === expected);
  const tus = b.tusAuth(guid);
  const tsig = crypto.createHash('sha256')
    .update('123' + 'dummykey' + tus.headers.AuthorizationExpire + guid).digest('hex');
  console.log('tus signature match:', tus.headers.AuthorizationSignature === tsig);
});"
```

(The thumbnail scheme verifies the same way — base64url of the **raw** digest
of key+path+expires; it also matched.) Parse `expires` back out of the
generated URL rather than computing your own timestamp, or clock drift between
the two computations produces false mismatches.

Expiry enforcement is Bunny-side and needs live credentials to prove: craft a
URL with `expires` in the past, expect the embed to refuse. Label results
accordingly — the offline check proves *our formula*, not *their enforcement*.

**Re-run when:** `lib/bunny.js` signing functions change, keys are rotated, or
Bunny changes its token scheme (watch for sudden universal 403s).

## Recipe 3 — Information-leak analysis

Method: for one handler, enumerate **every** exit branch (returns, redirects,
errors, thrown paths). For each, write down exactly what a caller learns. Then
check the union against what the feature promises to conceal.

Worked example — `/s/[id]` promises the intended recipient is never revealed
(`pages/s/[id].js`, all branches walked 2026-07-18):

| Branch | Caller learns |
|---|---|
| id fails regex | "gone" — nothing |
| no session | redirected to login — nothing |
| Redis error or share absent | "gone" — nothing (Redis failure fails closed to "gone") |
| email mismatch | "mismatch" — that a live link exists, **not** whose it is: `share.email` never enters props; the rendered message is generic |
| match | the video — as intended |

Accepted residual disclosure, stated honestly: "gone" vs "mismatch" are
distinguishable, so a link-holder learns whether a link is still live. The
recipient's identity is what the design conceals, and no branch emits it.

Second worked example — admin denial uniformity: `requireAdmin` returns the
same `403 {"error":"Forbidden"}` for every route and method, whether the
caller is anonymous or a signed-in non-admin (`lib/guard.js`), so probing
admin routes teaches an attacker nothing about which admin features exist.
Contrast: `requireViewer` deliberately distinguishes 401 "Not signed in" from
403 "Not approved" — a UX choice for legitimate users, an accepted signal.

**Re-run when:** touching any handler that branches on identity or secret
state (share, guard, viewer routes).

## Recipe 4 — Trust-boundary tracing (secrets stay server-side)

Method: pick a secret; find every read; follow every value derived from it;
confirm nothing crossing to the client contains or reverses it. Then audit the
generic channels: GSSP props and `NEXT_PUBLIC_` inlining.

Worked example — `BUNNY_API_KEY` (2026-07-18):

```bash
grep -rn "BUNNY_API_KEY" --include="*.js" lib pages components   # reads: lib/bunny.js only
grep -rn "apiKey" lib/bunny.js                                   # flows: api() header, tusAuth() hash input
```

The key is read only in `lib/bunny.js`; it leaves the module as (a) an
`AccessKey` header on server→Bunny calls and (b) hashed inside the TUS
`AuthorizationSignature` (SHA-256 — one-way; the browser gets signature +
expiry + ids, sufficient to upload one video until expiry, not to derive the
key). `pages/api/admin/upload.js` returns only `{videoId, endpoint, headers}`.

Generic-channel audit: every GSSP props object was walked (index, admin,
watch, s) — they contain the caller's own identity, booleans, video metadata,
and time-limited signed URLs; no keys, no other users' emails (the viewers
list reaches admins only via the guarded `/api/admin/viewers`). The only
`NEXT_PUBLIC_` vars are the VAPID public key and Sentry DSN — public by
definition:

```bash
grep -rn "NEXT_PUBLIC_" --include="*.js" lib pages components next.config.js
```

**Re-run when:** adding an env var, a GSSP, or any route that returns config.

## Recipe 5 — Fail-open vs fail-closed audit

The rule this codebase enforces: **access decisions fail closed; auxiliary
features fail open / best-effort.** Method: list every `catch`/fallback on a
code path, classify which side of the line it is on, and verify the fallback
matches the rule.

Worked table (every site verified 2026-07-18):

| Site | On failure | Class | Correct? |
|---|---|---|---|
| viewer check `sismember` — `lib/guard.js`, `pages/index.js`, `pages/watch/[id].js` | `approved = false` | access | ✔ closed |
| share lookup — `pages/s/[id].js` | `share = null` → "gone" | access | ✔ closed |
| session absent — all guards/GSSPs | 401 / login redirect | access | ✔ closed |
| rate limiter — `lib/ratelimit.js` | request allowed | auxiliary | ✔ open (availability over throttling) |
| audit log — `lib/audit.js` | action proceeds unlogged | auxiliary | ✔ best-effort |
| share email — `lib/mail.js`, `pages/api/admin/share.js` | link still created | auxiliary | ✔ best-effort |
| push send/announce — `lib/push.js` | silent skip | auxiliary | ✔ best-effort |
| last-seen stamp — guard + GSSPs | dropped | auxiliary | ✔ best-effort |
| theme GET — `pages/api/theme.js` | default palette | public data | ✔ open |
| progress GET — `pages/api/progress.js` | empty history | own data | ✔ degrade |
| Bunny list — `pages/api/videos.js` | 502 to caller | availability | ✔ honest error |

Anything that moves a row across the line (e.g. making an access check "fail
open for resilience") is wrong by definition here — see change-control's
non-negotiables. The email_verified campaign adds a new access-class check and
therefore must fail closed (see campaign-email-verified, which fences this).

**Re-run when:** adding any `catch`, `.catch()`, default, or fallback on a
path that includes an identity or approval decision.

## When NOT to use this skill

- Executing the verified-email fix → **campaign-email-verified** (it consumes
  these recipes at its gates).
- Turning an analysis into automated regression tests → **validation-and-qa**.
- Understanding the vendor protocols behind the tokens → **reference**.
- Live measurement of a deployment → **diagnostics-and-tooling**.

## Provenance and maintenance

Written 2026-07-18. Every matrix row, branch walk, and catch-site
classification came from reading the cited files in this repo; the signature
equivalence check was actually executed (all three schemes matched). Nothing
here relies on external claims except Bunny's server-side expiry enforcement,
which is labeled as requiring live verification.

```bash
find pages -name "*.js" | grep -v __tests__ | wc -l   # 23 files as of 2026-07-18 — more? matrix is stale
grep -rln "requireAdmin" pages/api/admin | wc -l      # 11 — every admin route guarded
grep -c "catch" lib/guard.js lib/ratelimit.js lib/audit.js lib/mail.js lib/push.js   # fallback sites drifted?
grep -rn "NEXT_PUBLIC_" --include="*.js" lib pages components | grep -v test         # public-by-design list
```

If a re-verification command's output disagrees with this file, re-run the
affected recipe and update the worked results in the same change.
