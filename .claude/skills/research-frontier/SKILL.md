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

### 1a. Access-request flow — status: SHIPPED 2026-08-31, retired from this list
- `pages/api/request-access.js` (session-only guard, 3/hour per email, queue
  capped at 200, repeats idempotent) plus a pending queue at the top of the
  Viewers tab with approve — optionally assigning groups in the same click —
  and dismiss, both audit-logged. Owner email notification is best-effort and
  inert without `RESEND_API_KEY`.
- Milestone met: the new route has a row in the entry-point matrix, is covered
  by the CI denial suite, and the `access-requests` key is in the data-model
  inventory. Note the ordering dependency that shaped it: self-serve requests
  plus an unverified email claim would let someone request access as an address
  that isn't theirs, which is why `trustedEmail` landed in the same change.

### 1b. In-app admin management — status: SHIPPED 2026-08-30, retired from this list
- Delivered as **capability-based roles**, not as an editable admin list: a
  fixed catalog in `lib/capabilities.js`, admin-defined roles in Redis
  (`lib/roles.js`, `/admin` → Roles), and `requireCapability` on every admin
  route. Both named risks were designed out rather than guarded against —
  self-lockout is impossible because `ADMIN_EMAILS` stays the env-only,
  non-removable owner set (Redis can only ADD privilege), and the escalation
  surface is capped by the subset rule `canDelegate`, so a delegated
  `roles.manage` can pass on only what its holder already has.
- Shipped alongside **groups** (`lib/groups.js`), whose content gating is an
  env-gated experiment (`GROUP_CONTENT_GATING`, inert by default) — the one
  part of that change still awaiting a real-deployment result. Its milestone,
  if anyone picks it up: run a week with gating on and confirm no approved
  viewer loses access they should have had, then decide whether `closed`
  becomes a sane default for the ungrouped case.
- Story moved to FEATURES.md; see the architecture contract (§1.1, I2/I2b/I2c)
  for the invariants it introduced.

### 1c. Captions/transcripts — status: OPEN, unscoped (scheduling half SHIPPED)
- **Scheduled publish/expiry shipped 2026-08-31**: `lib/schedule.js` (pure) +
  `lib/scheduleStore.js` (Redis), enforced at both `/api/videos` and the
  `/watch/[id]` GSSP, with an admin editor in the Videos tab. Milestone met —
  a future-dated video is invisible on the homepage AND on direct URL, appears
  without a deploy, and `lib/__tests__/schedule.test.js` pins the window logic.
  One thing deliberately NOT claimed: it fails open and is documented as a
  publishing convenience, not an embargo. If someone later needs a true
  embargo, that is a new, differently-shaped problem — don't retrofit it here
  by flipping the failure mode, which would put library availability behind a
  Redis read.
- **Captions/transcripts remain OPEN and unscoped.** Bunny Stream exposes
  caption endpoints on the same API `lib/bunny.js` already wraps, but that is a
  **vendor capability still unverified from this repo** — confirm against
  Bunny's documentation before scoping.

## 2. Verification depth — status: SHIPPED 2026-08-31, retired from this list
- `lib/__tests__/routeGuards.test.js` calls every guarded route with every HTTP
  method and asserts an anonymous caller can only be refused (401/403/405),
  never 200 and never 500. No `vitest.config.js` change was needed after all —
  the existing `lib/__tests__/**` include pattern already covers it, so the
  change-control config gate this item anticipated never applied.
- The milestone was falsifiable by design and was actually run: deleting a
  `requireCapability` call turns the suite red with
  `admin/audit answered 200 to an anonymous GET`. The suite is therefore not
  decorative. Re-run that sabotage by hand whenever the file changes.
- What is still NOT covered, stated plainly so nobody reads more into this than
  it proves: the suite tests the *anonymous* denial half only. It does not test
  that a signed-in caller holding capability X can reach route X and is refused
  route Y — that needs session and Redis fixtures, and is the obvious next step
  if anyone wants to extend it.

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
