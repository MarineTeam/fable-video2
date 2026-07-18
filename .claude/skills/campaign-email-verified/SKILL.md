---
name: campaign-email-verified
description: The executable, decision-gated campaign to close the project's hardest open security gap — enforcing email_verified so access checks stop trusting the raw session email claim. Use when asked to "enforce email verification", "close the email_verified gap", harden identity checks, or work the top item of the security backlog. Follow it phase by phase; do not skip gates. Not for general security review (see security-analysis-toolkit), auth debugging (see debugging-playbook), or other feature work (see research-frontier).
---

# Campaign: enforce `email_verified`

**Status: OPEN — not started as of 2026-07-18.** This document is the plan,
not a record of work done. Nothing below is implemented.

**The hole (verify before believing me):** every access decision in this app
compares the session's email claim against admin-managed lists, and none of
them checks `email_verified`. If the Auth0 tenant ever gains a connection or
misconfiguration that issues sessions with unverified emails, anyone able to
*claim* an approved address gets in — viewer, share recipient, or **admin**.
Today's mitigation is tenant configuration only (sign-ups disabled, users
added manually), which is defense that lives outside this repo, can drift
silently, and is invisible to CI. FEATURES.md lists this under "Known gaps".

**Success is measurable, never judged by eye:** the campaign is done when the
new unit tests pass, the 30 existing tests still pass, and a live probe with
an unverified-email session is denied at every surface in the
security-analysis-toolkit matrix — with docs updated and the FEATURES gap line
removed, all through change-control.

Rules of engagement: work on a branch; load **change-control** before editing
any of the files below (all are security-touching); this check is an access
decision so it must **fail closed** — the project's fail-open idiom is for
auxiliary features and explicitly does not apply (see security-analysis-
toolkit recipe 5).

---

## Phase 0 — Confirm the hole (read-only, ~10 min)

Enumerate every site that trusts the claim:

```bash
grep -rnE "user\??\.email" pages lib | grep -v __tests__
grep -rn "email_verified" pages lib middleware.js
```

(The `\??` matters: `lib/guard.js` uses optional chaining, `session?.user?.email`.)

**Expected (2026-07-18):** first grep hits exactly 5 files —
`lib/guard.js` (`getSessionEmail`, feeding `requireAdmin`/`requireViewer`)
plus the four GSSPs (GSSP = `getServerSideProps`, the server-side page code
Next.js runs before sending any UI; glossary in the reference skill):
`pages/index.js`, `pages/admin.js`, `pages/watch/[id].js`,
`pages/s/[id].js` (some hits are cosmetic `session.user.name || email`
fallbacks). Second grep hits **nothing** in app code.

- If the second grep already hits `lib/auth.js` or `lib/guard.js` → someone
  started this campaign. **Stop; find their branch/PR before continuing.**
- If the first grep shows sites this document doesn't list → the app grew
  since 2026-07-18. Add the new sites to your Phase 3 wiring checklist.

Note the chokepoint: all five files either call `getSessionEmail`/the guards or
repeat the same inline pattern. That concentration is the asset that makes
this campaign small.

## Phase 1 — Ground truth about the claim (GATE: do not proceed on assumption)

Nothing in this repo proves the Auth0 v4 session actually carries
`email_verified` for this tenant's connection type. Establish it empirically.

Options, in order of preference:

1. **Preview-deploy inspection:** on a branch, temporarily log the claim in a
   GSSP (`console.log('claims', session.user)` in `pages/index.js`), deploy a
   preview, log in, read the Vercel function logs, **revert the log commit**.
2. **Local inspection:** `npm run dev` with a real `.env.local` and the same
   temporary log.
3. `/auth/profile` (mounted by the v4 middleware) returns the session user as
   JSON — log in and open it in a browser; no code change needed. Try this
   first.

**Expected:** `email_verified: true` present as a boolean for your admin
account (Auth0 database connections include the claim by default; that default
is vendor behavior — hence this gate rather than an assumption).

- **If the claim is a boolean → proceed to Phase 2.**
- **If the claim is absent/undefined** → code cannot enforce what the token
  doesn't carry. Branch: fix token contents first at the tenant (ensure the
  connection/scopes include `email`; an Auth0 Action can force-add the claim),
  i.e. solution B becomes a prerequisite, not an alternative. Re-run this
  phase until the claim appears, then continue.

## Phase 2 — Choose the enforcement design (GATE: decision required)

| Option | What | Pros | Cons / obligations |
|---|---|---|---|
| **A. Enforce in code** at the chokepoint | treat unverified as not-signed-in in `lib/auth.js` + `lib/guard.js` + the 4 GSSPs | testable in CI forever; survives tenant drift; visible in this repo | must decide the share-recipient question below |
| **B. Enforce at Auth0** (Action denying login to unverified emails) | zero code | also blocks before any session exists | invisible to CI; config drift re-opens the hole silently; not testable from the repo |
| **C. Both** (recommended end state) | A then B | belt and suspenders | do A first — it is the one this repo can prove |

**Decision sub-gate (owner input, do not decide unilaterally): share
recipients.** `/s/[id]` recipients are exactly the users least likely to have
verified emails (external one-off invitees). Blocking unverified recipients is
strictly safer and consistent; allowing them preserves today's UX but keeps a
slice of the hole open (a forged unverified session could match a share link's
recipient address). Present both; get an explicit choice; default to
**enforce everywhere** if the owner is unreachable, and say so in the PR.

Rollback plan for A: one `git revert` — no data, no schema, no config touched.

## Phase 3 — Test-first implementation (option A)

1. **Write the pure function first**, in `lib/auth.js` (identity logic lives
   there and nowhere else — change-control non-negotiable):

   ```js
   // Returns the normalized email ONLY for sessions safe to trust.
   // Unverified or missing claims yield '' — callers already treat '' as
   // not-signed-in, so failure mode is deny (fail closed).
   export function trustedEmail(user) {
     if (!user || user.email_verified !== true) return '';
     return normalizeEmail(user.email);
   }
   ```

   The `!== true` shape is the point: absent, `false`, `undefined`, or a
   string `"false"` all deny.

2. **Write the tests before wiring** — add `describe('trustedEmail')` to
   `lib/__tests__/auth.test.js` (the vitest include pattern only runs tests in
   `lib/__tests__/`; see validation-and-qa). Cases, with expected results:
   `{email:'a@b.co', email_verified:true}` → `'a@b.co'`;
   `email_verified:false` → `''`; claim absent → `''`; `'true'` (string) →
   `''`; `null`/`undefined` user → `''`; verified but uppercase/whitespace
   email → normalized. Run:

   ```bash
   npm test    # EXPECT: 30 existing tests still pass + your new ones (state the exact new total in the PR)
   ```

3. **Wire the chokepoints** (checklist — all five files from Phase 0):
   - [ ] `lib/guard.js` `getSessionEmail` → `return trustedEmail(session?.user)`
         (this alone covers every API route: both guards call it).
   - [ ] `pages/index.js` GSSP: derive email via `trustedEmail`; empty →
         redirect to login (same as no session).
   - [ ] `pages/admin.js` GSSP: same.
   - [ ] `pages/watch/[id].js` GSSP: same.
   - [ ] `pages/s/[id].js` GSSP: per the Phase 2 decision (enforce → same
         treatment; allow → leave, and document why in the code comment).
   - [ ] `grep -rn "user.email" pages lib | grep -v __tests__ | grep -v trustedEmail`
         → remaining hits are cosmetic display names only.

4. **Gate:**

   ```bash
   npm run lint    # EXPECT: clean
   npm test        # EXPECT: all pass, incl. new trustedEmail suite
   # then npm run build with the CI dummy env — canonical block:
   # config-and-env → "CI dummy env (build without real services)"
   # EXPECT: exit 0
   ```

## Phase 4 — Validation and promotion

**Live validation on a preview deployment:**

1. Verified admin logs in → everything works exactly as before. EXPECT: no
   behavior change for verified users at all.
2. Create an unverified test user (Auth0 dashboard → create user; do not
   verify the email, or set `email_verified:false` via the Management API),
   add that address as an approved viewer, log in with it.
   **EXPECT: treated as not-signed-in → redirected to login / 401 from APIs —
   a designed denial, not a 500.** If the login redirect loops for them,
   design a "verify your email" notice screen instead — that is a UX change;
   run it through change-control, don't improvise.
3. `node .claude/skills/diagnostics-and-tooling/scripts/smoke-probe.mjs <preview-url>`
   → EXPECT: all rows still PASS (no guard accidentally loosened).
4. Re-run the validation-and-qa manual security checklist → EXPECT: no
   regressions.

**Promotion (through change-control):** PR with the measured evidence (test
counts, probe output, the unverified-login observation); same-commit doc
updates — README "Security notes" (replace "pair with Auth0 sign-up controls"
framing with the enforced reality), FEATURES.md (remove the
"`email_verified` enforcement" line from Known gaps; add the feature bullet),
per docs-and-writing. After merge: optionally add the Auth0 Action (option B)
and record it in README's setup checklist so the tenant config is at least
written down where CI can't see it.

## Fenced wrong paths — do not take these

| Wrong path | Why it's wrong |
|---|---|
| Client-side-only checks (hide UI for unverified users) | APIs remain open; the client is not a trust boundary. |
| Enforcing only at login/GSSP but not in `getSessionEmail` | API routes are directly reachable; the chokepoint is the guards. |
| Making the check fail open ("if claim missing, allow") | This is an access decision; the project's fail-open idiom covers auxiliary features only. Missing claim = deny, and Phase 1 exists so you know why it's missing. |
| Treating share recipients as automatically exempt | That's the Phase 2 decision gate — get it decided, don't assume. |
| Upgrading `@auth0/nextjs-auth0` "while we're in here" | Separate change, separate risk — never batch a dependency bump into a security fix (change-control's dependency-change gate; the ESLint incident is the precedent for "routine" upgrades breaking things). |
| Trusting this doc over the code | Re-run Phase 0's greps first; the app may have grown. |

## When NOT to use this skill

Any security work that isn't this specific campaign → security-analysis-
toolkit. Auth *breakage* (login loops, callback errors) → debugging-playbook.
After this campaign closes, its residue belongs in FEATURES.md + the
archaeology section of debugging-playbook, and this skill should be marked
DONE at the top with the merge commit.

## Provenance and maintenance

Written 2026-07-18 from direct code inspection: trust sites verified by grep
(5 files, listed above); absence of any `email_verified` check verified;
guard chokepoint verified in `lib/guard.js`. NOT verifiable from the repo and
therefore gated in Phase 1: whether this tenant's sessions carry the claim.
The owner selected this as the project's hardest live problem on 2026-07-18.

```bash
grep -rn "email_verified" pages lib middleware.js   # still no hits? campaign still open — else update Status line
grep -rn "user.email" pages lib | grep -v __tests__ # trust-site list still 5 files?
grep -n "email_verified" FEATURES.md                # gap still documented?
```
