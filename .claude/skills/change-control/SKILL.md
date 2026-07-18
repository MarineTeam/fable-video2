---
name: change-control
description: "Use when planning, reviewing, or merging ANY change to this repo — code, security-touching code, dependencies, config/env, docs, or skills: the gate each change class must pass, the non-negotiables with incident history, and the pre-merge checklist. Load BEFORE editing package.json, eslint.config.mjs, lib/auth.js, lib/guard.js, middleware.js, or pages/api/**. Not for debugging (see debugging-playbook), deploying (see run-and-operate), or env-var meanings (see config-and-env)."
---

# Change control — how changes are made here

This is the constitution for changing the Marine Video Portal. It answers three
questions: **what class of change is this**, **what gate must it pass**, and
**which rules must it never break**. Facts below verified against the repo on
2026-07-18.

Definitions (once): **CI** = the GitHub Actions job in
`.github/workflows/ci.yml`. **Green CI** = that job passing. **PR** = GitHub
pull request. **Vercel** = the hosting platform that builds and deploys the
`main` branch. **Security-touching** = defined precisely in the section below.

## The merge path

The single hard gate is CI: one `verify` job — install → `npm run lint` →
`npm test` → `npm run build` — running on every push and PR to `main`
(`.github/workflows/ci.yml`, Node 24, dummy env for the build step).

**Recommended path for every change: branch → PR → green CI → merge to `main`.**
Vercel deploys `main`. Two precision points:

- A change whose `next build` fails will also fail Vercel's build, so a broken
  build does not go live — but **lint or test failures do not block a Vercel
  deploy by themselves**. Only branch protection (requiring the CI check on
  PRs) makes green CI mandatory. README.md line 177 suggests enabling it;
  whether it is actually enabled **cannot be verified from the repo** — it is
  GitHub settings, not code. Behave as if it is off: never push directly to
  `main` without local lint/test/build passing first.
- CI's build uses dummy env values. Green CI proves the code compiles and the
  pure logic is correct; it proves nothing about real Auth0/Bunny/Redis
  behavior. For runtime evidence standards, see
  `.claude/skills/validation-and-qa/SKILL.md`.

## Change classification — what gate applies

| Class | Examples | Gate before merge |
|---|---|---|
| App code | `pages/**`, `components/**`, `lib/**`, `middleware.js`, `public/sw.js` | Green CI + pre-merge checklist below + README/FEATURES updated in the SAME change if behavior changed (non-negotiable 9) |
| Security-touching code | See definition below | All of the above **+ the security gate below** |
| Dependency change | Any edit to `dependencies`/`devDependencies` in `package.json` | Written justification (non-negotiable 8) + green CI + re-run `npm run lint` locally (the ESLint pin, non-negotiable 5, is the incident here) |
| Config / env | Vercel env vars, Redis-stored settings | No code gate — but no silent behavior change either: `NEXT_PUBLIC_*` values are baked at build time (redeploy required), and README's env table must stay true. See `.claude/skills/config-and-env/SKILL.md` |
| Docs of record | `README.md`, `FEATURES.md` | CI still runs (cheap); accuracy gate is `.claude/skills/docs-and-writing/SKILL.md` — never document a behavior that code does not have |
| Skill library | `.claude/skills/**` | CI runs but does not check skill content; verify every stated command/path against the repo before writing it, keep the sibling map's one-home-per-fact rule |

## Non-negotiables

Each rule states WHAT, then RATIONALE, then the evidence or incident behind it.
These are inferred from code patterns and the complete 4-commit history — they
are load-bearing, not stylistic.

**1. Identity logic changes only in `lib/auth.js`.**
Every access decision in the app — admin, approved viewer, share recipient —
compares normalized emails via `normalizeEmail`/`isAdmin` from `lib/auth.js`
(consumed by `lib/guard.js` and the share flow). RATIONALE: normalization must
be byte-identical at every check site or two code paths will disagree about who
a user is; a duplicate lowercase/trim somewhere else is a future auth bypass.
README.md line 232 states it explicitly: "Centralized identity logic lives in
`lib/auth.js` — update it there only." FEATURES.md line 10 repeats the
centralization. Never re-implement email comparison inline.

**2. Never invert fail-open rate limiting or best-effort side effects.**
An optional subsystem must never block a core action. Concretely:
- `lib/ratelimit.js` `allowRequest` **fails OPEN** — on any Redis/limiter
  error it returns `true` (comment: "an infrastructure hiccup must never block
  real users"). Do not "harden" it to fail closed.
- `lib/audit.js` `logAction` swallows all errors ("a logging failure must
  never break the admin action being logged").
- `lib/mail.js` `sendShareEmail` returns `{ ok: false }` on failure — a mail
  outage must not break share creation.
- `lib/push.js` sends are best-effort; dead subscriptions are pruned with
  `.catch(() => {})`.
- `lib/guard.js` stamps last-seen with a floating `.catch(() => {})`.
RATIONALE: the primary product action (watch, upload, share, admin edit) is
the thing users pay for; audit/mail/push/metrics are accessories. Note the one
deliberate asymmetry: `requireViewer` sets `approved = false` when the Redis
membership check throws — the ACCESS decision fails closed while the
accessories fail open. Preserve both directions exactly.

**3. Optional features stay inert until configured.**
Push requires BOTH `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
(`lib/push.js` line 6); mail requires `RESEND_API_KEY` (`lib/mail.js`
`mailEnabled`); Sentry requires its DSNs; thumbnails require
`BUNNY_CDN_HOSTNAME` (`lib/bunny.js` `thumbnailUrl` returns `null` without
it). UI affordances hide when unconfigured. RATIONALE: a deployment that
doesn't use a feature must never be broken by it. Any new optional feature
you add must follow this idiom — a `xEnabled()` check, silent no-op when off.

**4. No video bytes on the server; no Bunny API key in the client.**
`pages/api/admin/upload.js` creates the Bunny video record and returns a
server-computed TUS signature; the browser streams the file directly to
`https://video.bunnycdn.com/tusupload` via tus-js-client. Only the signature
ships to the browser (`lib/bunny.js` `tusAuth`); `BUNNY_API_KEY` is read only
server-side ("Server-side only — the API key must never reach the client",
`lib/bunny.js` line 3). RATIONALE: proxying video through a Vercel serverless
function would hit body-size/time limits and cost, and leaking the API key
gives full library control to anyone with the bundle. Any upload/playback
change must keep both properties.

**5. ESLint stays pinned to 9.x.**
`package.json` has `"eslint": "^9.39.5"`. Incident (commit 9e5b086):
eslint-config-next 16.2.10's bundled parser does not implement ESLint 10's
`scopeManager.addGlobals`, so `eslint .` crashes with a TypeError under
ESLint 10. Do NOT "upgrade to fix the deprecation warning" — that is the exact
regression the pin prevents. Unpin only when eslint-config-next itself
supports ESLint 10 (verify by upgrading both together on a branch and running
`npm run lint`).

**6. The two disabled lint rules stay disabled, for their stated reasons.**
In `eslint.config.mjs` (commit d76a881 + inline comments):
- `@next/next/no-img-element: off` — thumbnails are token-signed bunny.net CDN
  URLs that rely on the browser sending the site Referer; `next/image` would
  proxy them server-side and break hotlink protection. "Fixing" this warning
  breaks content protection.
- `react-hooks/set-state-in-effect: off` — the app deliberately uses plain
  fetch-on-mount + setState (no data library); the compiler-powered rule flags
  that whole pattern even after an `await`. Re-enabling it means rewriting the
  data layer, not deleting the line.
If you touch these rules, keep (or update) the explanatory comments — they are
the institutional memory.

**7. Redis keys only via `k()` from `lib/redis.js`.**
Every server-side Redis key goes through `k(name)` → `` `fable2:${name}` ``.
Incident-shaped evidence (commit 6dd4351): the whole `pvp:` → `fable2:` prefix
rename was a one-line change to `lib/redis.js` precisely because no key is
hardcoded anywhere else; hardcoded keys would have scattered that rename
across every route. RATIONALE plus a trap: the comment above `k()`
(`lib/redis.js` line 18) still says `pvp:` — it is stale, the code on line 19
is the truth. Two client-side names legitimately still contain `pvp` and are
NOT Redis keys: `THEME_STORAGE_KEY = 'pvp:theme'` (browser localStorage,
`lib/theme.js` line 20) and the service-worker cache name `pvp-static-v1`
(`public/sw.js` line 4). Do not "fix" those as part of a Redis change. The
authoritative key inventory lives in
`.claude/skills/architecture-contract/SKILL.md`.

**8. Dependency minimalism — adding a package needs written justification.**
As of 2026-07-18 there are 10 runtime dependencies and 3 dev dependencies. The
precedent: share-link email uses Resend's REST API via raw `fetch`
(`lib/mail.js`: "No SDK dependency, nothing in the client bundle"). Before
adding any dependency, answer in the PR: what does the package do that ~40
lines of fetch/crypto cannot, what does it add to the client bundle, and what
is its maintenance/supply-chain cost? Default answer is "use fetch".

**9. README.md and FEATURES.md are updated in the SAME change as any behavior
change.**
Cost of not doing so, live in the repo today: commit 6dd4351 changed the Redis
prefix to `fable2:` but README.md line 12 and FEATURES.md line 81 still say
`pvp:` — the docs of record now misdirect anyone inspecting Redis, and any
data written under `pvp:*` by a pre-rename deployment is orphaned. One stale
line has to be re-discovered by every future maintainer. Docs-of-record
process and the known-drift ledger live in
`.claude/skills/docs-and-writing/SKILL.md`.

**10. No secrets in client code.**
Only `NEXT_PUBLIC_*` env vars reach the browser bundle — and therefore
anything named `NEXT_PUBLIC_*` must be safe to publish (currently only the
VAPID public key and the Sentry DSN). `BUNNY_API_KEY`,
`BUNNY_TOKEN_AUTH_KEY`, `AUTH0_*` secrets, `KV_REST_API_*`,
`RESEND_API_KEY`, `VAPID_PRIVATE_KEY` are server-only and must never be
imported into `pages/*` render code, `components/**`, or anything shipped to
the client. Corollary: `NEXT_PUBLIC_*` values are baked at build time — a
change requires a redeploy/rebuild, not a restart.

## Security-touching changes — the extra gate

A change is **security-touching** if it modifies any of:

- `lib/auth.js` (identity normalization / admin list)
- `lib/guard.js` (`requireAdmin` / `requireViewer`)
- `middleware.js` (Auth0 route mounting, session rolling, or its matcher)
- `lib/auth0.js` or anything about session handling
- any file under `pages/api/admin/`
- the signing functions in `lib/bunny.js` (`signedEmbedUrl`, `thumbnailUrl`,
  `tusAuth`)
- the share-link flow (`pages/api/admin/share.js`, `pages/s/`)

Before merging a security-touching change, in addition to green CI:

1. Re-run the entry-point × guard matrix check — enumerate every route under
   `pages/api/` and `pages/` and confirm which guard covers it. Method:
   `.claude/skills/security-analysis-toolkit/SKILL.md`.
2. Walk the manual security-invariant checklist in
   `.claude/skills/validation-and-qa/SKILL.md`.

Known accepted gap while doing this (do not "discover" it as new):
`email_verified` is NOT checked — access trusts the session email claim,
mitigated today by Auth0 sign-ups being disabled tenant-wide (FEATURES.md
line 95). Enforcing it is the dedicated campaign:
`.claude/skills/campaign-email-verified/SKILL.md`.

## Pre-merge checklist (run from repo root)

Every box, every code change. All three commands must exit 0.

```bash
npm run lint
```

```bash
npm test
```

Build with CI's exact dummy env (copied from `.github/workflows/ci.yml`; CI
runs Node 24, local requires >= 20.9):

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

Then confirm:

- [ ] No non-negotiable above is violated (skim the list against your diff)
- [ ] Behavior changed? README.md and FEATURES.md updated in this same change
- [ ] New tests for new pure logic, placed in `lib/__tests__/*.test.js` — the
      only path vitest picks up (`vitest.config.js` include pattern); see
      `.claude/skills/validation-and-qa/SKILL.md`
- [ ] Security-touching? Extra gate above completed
- [ ] Dependency added/changed? Justification written; `npm run lint` re-run
- [ ] New env var? Follows inert-until-configured (rule 3) and is documented
      per `.claude/skills/config-and-env/SKILL.md`

## When NOT to use this skill

| You are trying to… | Use instead |
|---|---|
| Diagnose a failure or weird symptom | `.claude/skills/debugging-playbook/SKILL.md` |
| Run locally, deploy, provision services, operate /admin | `.claude/skills/run-and-operate/SKILL.md` |
| Understand an env var or Redis-stored setting | `.claude/skills/config-and-env/SKILL.md` |
| Understand WHY the architecture is shaped this way, or the Redis data model | `.claude/skills/architecture-contract/SKILL.md` |
| Learn Bunny/Auth0/Upstash/Web Push domain details | `.claude/skills/reference/SKILL.md` |
| Decide what counts as proof, add/extend tests | `.claude/skills/validation-and-qa/SKILL.md` |
| Prove a security property from first principles | `.claude/skills/security-analysis-toolkit/SKILL.md` |
| Maintain README/FEATURES themselves | `.claude/skills/docs-and-writing/SKILL.md` |
| Work on `email_verified` enforcement | `.claude/skills/campaign-email-verified/SKILL.md` |
| Measure runtime state (Redis, signed URLs, env sanity) | `.claude/skills/diagnostics-and-tooling/SKILL.md` |

This skill owns: change classes and their gates, the non-negotiables with
their incident history, and the pre-merge checklist. Authoritative content on
anything else lives in the sibling named above.

## Provenance and maintenance

Derived 2026-07-18 by direct inspection of the code and the complete git
history (4 commits: 741d980 initial build, 9e5b086 ESLint pin, d76a881 lint
rule disable, 6dd4351 key prefix rename). Nothing here is speculation; every
rule cites its file or commit. Branch protection status is the one fact NOT
verifiable from the repo (GitHub settings) and is labeled as such above.

Re-verify before trusting, one line each:

```bash
git log --oneline                                  # still exactly these 4 commits + yours?
cat .github/workflows/ci.yml                       # gate steps + dummy env block unchanged?
grep -n '"eslint"' package.json                    # still ^9.x (rule 5)?
grep -n "off" eslint.config.mjs                    # both rules still disabled with comments (rule 6)?
grep -n "fable2" lib/redis.js                      # k() prefix still fable2: (rule 7)?
grep -rn "pvp" --include="*.js" --include="*.md" . --exclude-dir=node_modules   # drift ledger for rule 9
grep -n "Fails OPEN" lib/ratelimit.js              # fail-open comment intact (rule 2)?
grep -n "update it there only" README.md           # identity rule still documented (rule 1)?
grep -rn "allowRequest" pages/                     # rate-limited endpoints: videos, upload, share
ls pages/api/admin/                                # security-touching route inventory current?
```
