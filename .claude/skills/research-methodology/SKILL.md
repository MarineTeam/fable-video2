---
name: research-methodology
description: The discipline that turns a hunch into an accepted change in the Marine Video Portal — use when the mechanism or value of a change is UNCERTAIN: investigating a confusing bug where the cause is disputed, proposing an experimental feature, evaluating a performance/architecture idea, or deciding whether an investigation's conclusion is trustworthy. Covers the evidence bar (one mechanism explains ALL observations), predict-numbers-before-running, adversarial refutation, and the idea lifecycle from env-gated experiment to adopted change or documented retirement. Not for routine fixes (debugging-playbook + change-control suffice) or for the list of what to work on (see research-frontier).
---

# Research methodology

When the cause of a bug is disputed, or the value of an idea is unproven, this
is the discipline. For routine work it is overkill — a symptom with a known
playbook entry needs debugging-playbook, and an obvious fix needs
change-control. Use this when someone (including you) is about to act on a
*belief*.

## 1. The evidence bar: one mechanism, ALL observations

A proposed root cause is accepted only when a single mechanism explains every
observation — **including the negative ones** (the things that surprisingly
still work, or that a rival theory predicts should have broken).

Worked example from this repo's real history (commit 9e5b086): `eslint .`
crashed with a TypeError. Rival mechanisms: (a) "our flat config is bad",
(b) "a rule is incompatible", (c) "eslint-config-next's bundled parser doesn't
implement ESLint 10's new `scopeManager.addGlobals` API". Only (c) explains
ALL observations: the crash fires **before any file is linted** (config
theories predict per-file or rule-attribution errors), **no config edit
changes anything**, and **pinning ESLint to 9.x resolves it completely with
zero config changes**. Mechanism (a) or (b) would have sent someone rewriting
a healthy config — the classic cost of accepting a mechanism that explains
only the headline observation.

Apply it: list every observation (including "X still works"); for each
candidate mechanism, check it against the whole list; a mechanism that needs
an auxiliary excuse ("and also something else must be weird") loses to one
that doesn't.

## 2. Predict numbers before running

Before any experiment, write down the expected observation as a number or
exact state — then run. In this project's vocabulary:

| Claim | Written prediction (before running) |
|---|---|
| "My fix restores the tests" | `npm test` → 30 passed (or N+M with M new — name M) |
| "The guards still hold" | smoke-probe → 24/24 PASS |
| "The old data was orphaned by the rename" | redis-inspect → `ORPHANED pvp:* KEYS: >0`, and after migration → `0` |
| "This endpoint is the slow one" | measured Redis commands per visit = the number you derived from code, before you measure |

A prediction you cannot phrase as an observable number or exact state is not
ready to test — sharpen it first. Record the prediction (PR description,
notes) **before** the run; a postdicted "yes that's what I expected" is worth
nothing. If the observation misses the prediction, the mechanism is wrong or
incomplete — do not adjust the prediction after the fact (that is how wrong
mechanisms survive).

## 3. Adversarial refutation

Before adopting a mechanism or shipping an uncertain change, someone must hold
the explicit job of breaking it — yourself in a second pass, a second
session/model, or a reviewer. The refuter's brief: enumerate rival mechanisms
still consistent with the evidence, then design the **discriminating
experiment** — the observation the rivals predict differently (this is the
operational form of debugging-playbook's discriminating-experiment column).
For security-touching claims, the refutation toolkit is
security-analysis-toolkit (leak branches, matrix, fail-open audit); a
concrete house example of a designed negative control: research-frontier's
verification milestone requires deleting a guard on a scratch branch to prove
the test suite actually goes red. A change nobody tried to break is
unreviewed in the way that matters.

## 4. The idea lifecycle

```
hunch → written hypothesis (predicts numbers) → experiment behind the flag idiom
      → measured validation → change-control promotion + docs
      → OR documented retirement
```

- **The flag idiom:** this project's feature flags are **env-gated
  inert-until-configured features** — a new capability ships dark and turns on
  only when its config is present. The two shipped precedents (verify in
  code): Web Push is fully inert unless BOTH VAPID keys are set
  (`lib/push.js` `pushEnabled()`), and share email is inert without
  `RESEND_API_KEY` (`lib/mail.js` `mailEnabled()`), with all UI affordances
  hidden when off. New experimental capabilities follow the same shape: no
  config, no behavior change, no UI — so an experiment can merge safely
  before it is proven, and be retired by never configuring it.
- **Validation:** the evidence hierarchy and thresholds are
  validation-and-qa's; the measurements are diagnostics-and-tooling's.
- **Promotion:** through change-control, with same-commit README/FEATURES
  updates (docs-and-writing).
- **Retirement:** a negative result is a result — record it where the next
  person will trip over it: a FEATURES.md "Known gaps" line for retired
  product ideas, or a debugging-playbook archaeology entry for a disproven
  mechanism (symptom → wrong theory → evidence against → status: settled).
  An idea retired silently will be re-attempted at full price.

## 5. Where good ideas came from here (evidence, not lore)

The repo's history says ideas came from **friction, not speculation**:

- **Real deploy failures** → the README "Common issues" section is accreted
  incident experience (callback URL, "Missing state", whitespace-corrupted
  keys), each now encoded as a check or a doc.
- **Vendor constraints discovered the hard way** → the homepage count is
  clamped in code because Bunny's API "doesn't honor it as a strict limit"
  (FEATURES.md); env values are trimmed because pasted whitespace corrupted
  TUS signatures (`lib/bunny.js` header comment).
- **Operator friction** → bulk viewer add, share-email resend, drag-to-reorder
  all exist because doing it one-at-a-time by hand hurt.

So when hunting for the next valuable thing: mine the audit log, the Common
Issues list, operator complaints, and diagnostics output before brainstorming
in the abstract. (Then file it in research-frontier.)

## When NOT to use this skill

The symptom has a playbook entry → debugging-playbook. The change is obvious
and low-risk → change-control's checklist alone. You need the backlog, not
the method → research-frontier. You need what counts as pass/fail evidence →
validation-and-qa.

## Provenance and maintenance

Written 2026-07-18. The ESLint worked example is from commit 9e5b086's message
plus the pinned `"eslint": "^9.39.5"` in package.json; flag-idiom precedents
verified in `lib/push.js` and `lib/mail.js`; idea-origin claims cite README
"Common issues", FEATURES.md, and code comments — all checked against the
files on that date.

```bash
git log --oneline | grep -i eslint       # the 9e5b086 incident still in history
grep -n '"eslint"' package.json          # still pinned to 9.x?
grep -n "pushEnabled\|mailEnabled" lib/push.js lib/mail.js   # flag idiom precedents intact
grep -n "Common issues" README.md        # accreted-experience section still exists
```
