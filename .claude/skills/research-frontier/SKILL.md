---
name: research-frontier
description: Where the Marine Video Portal can be advanced beyond its current certified standard — the vetted open-problem backlog. Use when asked "what should we build next?", "how do we improve this project?", or when starting discretionary/roadmap work: each direction has why-current-state-falls-short, the repo's asset that makes it tractable, the first three concrete steps, and a falsifiable done-milestone. Everything here is OPEN/CANDIDATE — nothing is started or promised. Not for the settled email_verified campaign (see campaign-email-verified), for how to run experiments (see research-methodology), or for fixing bugs (see debugging-playbook).
---

# Research frontier

The owner's definition of "advancing the project" (recorded 2026-07-18) spans
all four directions below. Ground rules: pick ONE direction per effort; enter
through **research-methodology** (hypothesis → predicted numbers → experiment)
and exit through **change-control**. Every item here is labeled by its honest
status; if you complete or retire one, update this file in the same PR.

**Positioning note (external honesty):** nothing in this repo is
research-novel to the field — signed tokens, invite lists, and PWAs are known
engineering. "Beyond state of the art" here means *beyond this project's own
current certified standard*. Never claim novelty in any external write-up;
what is defensible is rigor: measured invariants, provable access control,
documented failure archaeology.

---

## 1. Product features (from FEATURES.md "Known gaps" — verified present, 2026-07-18)

### 1a. Access-request flow — status: OPEN
- **Falls short:** unapproved users hit "Not approved" (`pages/index.js`) with
  no path forward; admins must learn who to add out-of-band.
- **Asset:** every piece already exists in another form — the approved-viewers
  SET and its admin tab (`pages/api/admin/viewers.js`), the audit log for
  traceability, and optional push/email for notifying admins.
- **First three steps:** (1) add a "Request access" button to the not-approved
  card posting to a new `pages/api/request-access.js` (session-only guard —
  the requester is authenticated but unapproved; rate-limit it; store under a
  new `fable2:access-requests` key, capped); (2) surface pending requests in
  the Viewers tab with one-click approve (moves email into the viewers SET,
  audit-logged); (3) optional push/email notification to admins, inert unless
  configured, per house idiom.
- **Result when:** an unapproved login can file exactly one pending request
  (repeat attempts 429/no-op); an admin approves it from /admin without
  redeploy; smoke-probe still passes (the new route denies anonymous callers);
  the request key appears in redis-inspect and the entry-point matrix gains
  its row.

### 1b. In-app admin management — status: OPEN, higher risk
- **Falls short:** `ADMIN_EMAILS` is env-frozen (`lib/auth.js`); changing
  admins needs a redeploy.
- **Asset:** the settings-tab + Redis pattern. **Named risks that make this
  candidate, not planned:** self-lockout (removing the last admin) and
  privilege escalation surface (an admin-writable admin list is a bigger
  prize than an env var). Design obligation: env list stays as the
  non-removable bootstrap set; Redis can only ADD admins; every change
  audit-logged.
- **First three steps:** (1) write the threat analysis using
  security-analysis-toolkit recipes 1 and 5 BEFORE any code; (2) extend
  `isAdmin` to check env-set ∪ Redis-set with fail-closed Redis handling —
  note this touches the one file identity logic lives in, maximally
  security-touching; (3) tests first in `lib/__tests__/auth.test.js`.
- **Result when:** an env-listed admin can grant/revoke Redis-listed admins
  live; no sequence of UI actions can remove the last env admin (test proves
  it); matrix and audit rows exist.

### 1c. Captions/transcripts, scheduled publish/expiry — status: OPEN, unscoped
- **Falls short:** FEATURES.md lists both as not implemented.
- **Asset:** captions — Bunny Stream exposes caption endpoints on the same
  API this app already wraps in `lib/bunny.js` (vendor capability,
  **unverified from this repo** — confirm against Bunny docs before
  scoping); scheduling — the `isPlayable` filter in `pages/api/videos.js` is
  a natural single gating point, and Redis-stored per-video metadata is an
  established pattern.
- **First three steps (scheduling):** (1) decide the storage shape (e.g.
  `fable2:schedule` hash guid→{from,until}); (2) filter in `/api/videos` and
  guard direct `/watch/[id]` access the same way (both, or it's not a gate);
  (3) admin UI in the Videos tab.
- **Result when:** a video with a future publish date is invisible to viewers
  on the homepage AND direct-URL access, then appears without any deploy;
  a test pins the filter logic.

## 2. Verification depth — status: OPEN (owner-selected priority)

- **Falls short (verified):** 30 unit tests cover 4 pure-logic modules
  (`lib/__tests__/`); zero coverage of API handlers, guards-as-wired, or
  GSSPs. The strongest invariants (deny-by-default) are proven only by the
  runtime smoke-probe, not in CI.
- **Asset:** handlers are small and take plain `(req, res)`; the
  security-analysis-toolkit entry-point matrix is a ready-made coverage
  checklist; vitest ships mocking (`vi.mock`) so no new dependencies are
  needed — staying inside change-control's dependency discipline.
- **First three steps:** (1) prototype ONE handler test — mock `lib/auth0`'s
  `getSession` to return null and assert `/api/admin/videos` responds 403
  without touching Redis/Bunny (also requires widening `vitest.config.js`'s
  include pattern or placing route tests under `lib/__tests__/` — config
  change goes through change-control); (2) generalize into a tiny req/res
  stub helper; (3) generate one denial test per matrix row.
- **Result when (falsifiable by design):** every matrix row has an automated
  denial test, and **deliberately deleting a `requireAdmin` call on a scratch
  branch turns CI red**. If that sabotage passes CI, the suite is decorative —
  the milestone explicitly requires running this negative control.

## 3. Stronger content protection — status: OPEN, candidate

- **Falls short (honest baseline):** signed time-limited embeds + referrer
  hotlink protection + identity gating are real but are not DRM: any approved
  viewer can screen-record, and within its TTL an embed URL works wherever it
  is pasted (the token binds videoId+expiry, not viewer — see
  `signedEmbedUrl` in `lib/bunny.js`).
- **Asset:** per-viewer identity is already present at every play
  (progress tracking is keyed by email), so per-viewer traceability has a
  hook; TTLs are one-line tunables (`ttlSeconds` defaults in `lib/bunny.js`).
- **Candidate directions, ranked by cost:** (1) shorten embed TTL (4h → e.g.
  15min) — near-free, bounds the paste-window; measure that resume/refresh UX
  survives; (2) visible per-viewer watermark overlay on the player frame
  (deterrence + traceability; CSS overlay is trivial but a determined user
  crops it — state that honestly); (3) Bunny DRM / MediaCage or per-session
  playback restrictions (**vendor capability, unverified from this repo**;
  scope against Bunny's current offering and pricing first).
- **Result when:** for (1): TTL reduced with zero playback-failure regressions
  over a week of Sentry/analytics observation; for (2): a test recording is
  attributable to its viewer account in a controlled leak drill; for (3):
  an embed URL replayed from a second, unauthenticated context refuses to
  play before its TTL expires — each a defined test, none "looks safer".

## 4. Scale & resilience — status: OPEN, measure-first

- **Falls short:** README's scaling note (move read-mostly settings to Edge
  Config at ~10k visits/day) is a plan nobody has validated; the actual
  per-visit Redis command count has never been measured; Redis-outage behavior
  is knowable from the catch branches but has never been written down or
  fault-injected.
- **Asset:** the Redis surface is tiny and fully enumerated
  (architecture-contract's data-model inventory); every failure branch is
  already classified in security-analysis-toolkit recipe 5 — the outage
  matrix is half-written.
- **First three steps:** (1) MEASURE: count Redis commands for one homepage
  visit by reading the code path (`requireViewer`/GSSP + `/api/videos` +
  `/api/progress` + `/api/collections` + `/api/theme`) and record the number
  in this file; (2) write the outage matrix (feature × Redis-down behavior)
  from the catch branches, then verify locally by pointing
  `KV_REST_API_URL` at an unreachable host and walking the app; (3) only
  then evaluate Edge Config — with the measured number as the baseline.
- **Result when:** the outage matrix exists and matched observed local
  fault-injection behavior; and any Edge Config migration shows a measured
  per-visit Redis command reduction with smoke-probe + manual checklist
  clean. A migration without the before/after numbers is not a result.

## When NOT to use this skill

Fixing something broken → debugging-playbook. The email_verified work →
campaign-email-verified (it graduated from this list). How to run any of
these as a disciplined experiment → research-methodology. Judging whether a
finished effort merges → change-control + validation-and-qa.

## Provenance and maintenance

Written 2026-07-18. Current-state claims verified against: FEATURES.md
"Known gaps" section, `lib/__tests__/` contents (30 tests, 4 files),
`lib/bunny.js` TTLs and token inputs, `lib/auth.js` env-frozen admin list,
README scaling notes. Vendor capabilities (Bunny captions/DRM) are labeled
unverified — confirm against Bunny's documentation before scoping work.

```bash
grep -n "Known gaps" -A6 FEATURES.md          # gap list still as assumed?
ls lib/__tests__/ && npm test 2>&1 | grep "Tests"   # still 30 tests / 4 files?
grep -n "ttlSeconds" lib/bunny.js             # embed/thumbnail TTL defaults unchanged?
grep -n "Edge Config" README.md               # scaling plan still documented?
```

When a direction is completed or retired, move its story to
debugging-playbook's archaeology (if it failed) or FEATURES.md (if it
shipped), and delete it here — this file lists only open frontiers.
