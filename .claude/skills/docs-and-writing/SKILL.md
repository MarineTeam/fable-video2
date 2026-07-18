---
name: docs-and-writing
description: "Use when writing or updating ANY documentation in this repo: README.md, FEATURES.md, code comments, or .claude/skills/* — including 'update the docs', 'document this feature', 'add a Common Issues entry', 'is the README stale?', or when a code change needs its same-commit doc update. Contains the docs-of-record contracts, house style guide with templates, the update-with-every-change rule, and the known-drift ledger. Not for making the code change itself (see change-control) or for env-var semantics (see config-and-env)."
---

# Docs and writing — maintaining the documentation of record

This skill defines what each document in this repo is FOR, the style it must be
written in, and the one rule that keeps it all true: **docs update in the same
commit as the behavior they describe**. It also carries the known-drift ledger —
the verified list of places where the docs are currently wrong.

---

## 1. The docs inventory and each doc's contract

| Document | Audience | Contract (what it must always contain) |
|---|---|---|
| `README.md` | Whoever deploys and operates the site (possibly a non-developer using Vercel + `/admin`) | Architecture at a glance, how it works, tech stack, project structure, **env var reference (Required + Optional tables)**, one-time setup checklist, local dev + CI, admin panel guide, PWA install, opt-in features, Security notes, **Common issues**, Scaling notes. The deploy-facing source of truth. |
| `FEATURES.md` | Whoever asks "what does this product do?" | Versioned feature inventory (header: `Current as of **v2.0.0** ...`), grouped by area with `_(admin)_` markers, ending with the honest **"Known gaps / not yet implemented"** section. The product-facing source of truth. |
| `.claude/skills/*/SKILL.md` | Maintainers (human and AI) doing work on the repo | How-to-work-here knowledge: runbooks, invariants, incident history, style. **Cross-reference README/FEATURES; never restate their content as a second authority.** |
| Code comments | The next person reading that file | WHY and constraints only — never what the code does (see section 5). |

**One home per fact.** A fact lives in exactly one document; everything else
points at it. Example: the full env-var tables live in `README.md` — a skill
that needs an env var links to the README (or to
`.claude/skills/config-and-env/SKILL.md` for maintainer-level detail), it does
not copy the table.

- Deployment/ops/security facts → home is `README.md`.
- Product capability and gap facts → home is `FEATURES.md`.
- Maintainer process, incidents, verification recipes → home is the relevant skill.

---

## 2. The update-with-every-change rule

**Any behavior change lands in the SAME commit as its README/FEATURES
updates.** Not a follow-up PR, not a TODO. If the diff changes what the app
does, the diff also changes what the docs say it does.

Checklist to run before committing any change:

- [ ] Does this change what the app does or how it's operated? → update the
      matching `README.md` section(s) in this commit.
- [ ] Does this add/remove/change a user-visible capability or close a known
      gap? → update `FEATURES.md` (add the bullet, or delete the line from
      "Known gaps / not yet implemented"). Bump the version header
      (`FEATURES.md` line 3: `Current as of **v2.0.0** ...`) when the release
      version changes — feature additions that ship under a new version must
      not sit under the old header.
- [ ] Does this add an env var? → add a row to the README's **Required** or
      **Optional** env table, AND — if the build needs it — add a dummy value
      to the CI build env block in `.github/workflows/ci.yml` (the
      `# Dummy values so the production build compiles without real services.`
      block under the Build step), or CI's `npm run build` breaks.
- [ ] Does this change a fact a skill states? → update that skill and its
      Provenance section in the same commit.
- [ ] Does this invalidate an entry in the drift ledger below? → remove the
      entry as part of the fix.

### Why this rule exists: the `pvp:` → `fable2:` incident

Commit `6dd4351` renamed the Redis key namespace by editing exactly one line of
`lib/redis.js` — and nothing else. As of 2026-07-18 the cost is still visible:

- `README.md` and `FEATURES.md` both still tell operators their data lives
  under `pvp:` (exact lines in the ledger below). Anyone inspecting Redis by
  hand with `KEYS pvp:*` finds nothing and concludes the database is empty.
- Even the comment **directly above the changed line** in `lib/redis.js` still
  says `pvp:` — the edit didn't look one line up.
- Real operational consequence: any Redis data written under `pvp:*` by a
  pre-rename deployment (viewers, shares, progress, theme, audit) is silently
  orphaned until manually migrated — and the docs actively point you at the
  wrong keys while you debug it.

One skipped 3-line doc edit produced a permanently misleading source of truth.
That is the entire argument for the same-commit rule.

---

## 3. Known-drift ledger (verified 2026-07-18)

Every entry below was re-verified against the code on the date above. **Do not
trust this ledger blindly — re-grep before acting** (commands in Provenance).
When you fix an entry through normal change control, delete it from this table
in the same commit.

Ground truth: `lib/redis.js` line 19 — `export const k = (name) =>
`fable2:${name}`;` — every server-side Redis key is prefixed `fable2:`.

| # | Location | Currently says | Correction needed |
|---|---|---|---|
| 1 | `README.md` line 12 ("All state lives in Redis") | "stored in Upstash Redis under the `pvp:` key prefix" | `pvp:` → `fable2:` |
| 2 | `FEATURES.md` line 81 (Platform, quality & observability) | "All keys are namespaced with a `pvp:` prefix." | `pvp:` → `fable2:` |
| 3 | `lib/redis.js` line 18 (comment above `k()`) | `// Every key this app touches is namespaced under pvp:` | `pvp:` → `fable2:` |
| 4 | `README.md` lines 43, 110, 168 | "ESLint 10 flat config" | ESLint is deliberately **pinned to 9.x** (`package.json` line 25: `"eslint": "^9.39.5"`, commit `9e5b086`) because eslint-config-next 16.2.10's parser crashes under ESLint 10. Say "ESLint 9 flat config" — and do NOT "fix" this by upgrading ESLint (see `.claude/skills/change-control/SKILL.md`). |

**Legitimate `pvp` survivors — do NOT rename these** (client-side names,
unrelated to the Redis prefix; renaming them would orphan users' cached
theme/assets):

- `lib/theme.js` line 20: `THEME_STORAGE_KEY = 'pvp:theme'` (browser localStorage key).
- `public/sw.js` line 4: `const CACHE = 'pvp-static-v1'` (service-worker cache name).

---

## 4. House style guide (derived from the actual docs)

Match these patterns exactly — the docs read as one voice because they follow
them consistently.

| Pattern | Rule | Real example |
|---|---|---|
| Tables for enumerable facts | Env vars, tech stack, anything list-of-N-things with attributes → a table, not prose | README "Tech stack" and both env tables |
| Bold feature names | Bullet starts `**Feature name** — description` (bold, then spaced em-dash) | FEATURES: `**Search** — viewers can search the whole library by title (debounced).` |
| "Inert unless configured" phrasing | Opt-in features are described as *inert*: name the exact env var(s), state that UI affordances stay hidden and nothing is ever sent | README Push section: "completely **inert unless both `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set**"; FEATURES: "**Inert until configured**" bullets |
| Em-dashes | ` — ` (spaced) joins a bold lead-in to its explanation, or appends a consequence to a sentence | Pervasive in both docs |
| Callouts as blockquotes | A load-bearing caveat sits in a `>` blockquote directly under its section heading | README line 118 (the Auth0 v4 env-var rename warning) — the one existing instance; follow its form |
| Imperative setup steps | Numbered steps, imperative mood, exact UI paths in bold, parenthetical rationale | README "One-time setup checklist": "**Disable open sign-ups** (Authentication → Database → 'Disable Sign Ups') ..." |
| `---` separators | README separates every top-level section with `---`; FEATURES uses plain `##` headings with no separators | Compare the two files |
| Common Issues phrasing | Bold **symptom as the user sees it**, then ` — ` and the explanation/fix in one or two sentences | README: `**Upload fails with HTTP 401** — a stray newline/space in \`BUNNY_API_KEY\`...` |
| Admin markers | FEATURES bullets/sections that live in `/admin` carry the `_(admin)_` suffix | FEATURES section headings |

### Template: adding a Common Issues entry (README.md)

Append to the bulleted list under `## Common issues`:

```markdown
- **<Symptom exactly as the operator sees it>** — <one-sentence cause>. <One
  actionable sentence: what to check or change, naming exact env vars/paths in
  backticks.>
```

Rules: symptom first and bold (operators scan by symptom, not by cause); no
sub-bullets; no "you should"; if the fix is "expected behavior", say so plainly
(see the "Thumbnails 403 directly but load in the app — expected" entry).

### Template: adding a FEATURES.md bullet

Place under the correct `##` area section (create a new area only if none fits):

```markdown
- **<Feature name>** _(admin, if it lives in /admin)_ — <what it does for the
  user, present tense>. <Behavioral guarantee or degradation note if any:
  "Best-effort: ...", "Inert until configured — ...", "Degrades gracefully
  if ...".>
```

And if the feature closes a known gap, delete the corresponding line from
`## Known gaps / not yet implemented` in the same commit. Never let a shipped
feature coexist with its own gap entry.

---

## 5. Code comments: WHY and constraints, never what

This codebase's comment idiom is strict: a comment earns its place only by
recording a **reason, constraint, or non-obvious consequence** that the code
cannot express. No narration of what the next line does. New code must match.

Real examples (all verified 2026-07-18):

- `lib/ratelimit.js` lines 21–22: `// Sliding-window check. Fails OPEN: an
  infrastructure hiccup must never block real users.` — records the invariant,
  not the mechanics.
- `lib/bunny.js` lines 3–5: `// ... Env values are trimmed because a stray
  newline pasted into Vercel corrupts TUS signatures.` — records the incident
  that motivates an otherwise-baffling `.trim()`.
- `pages/api/theme.js` lines 6–7: `// GET is public (the palette applies to
  the login-facing shell too and leaks nothing but colors). POST is
  admin-only.` — records a security decision that would otherwise look like a
  missing guard.
- `eslint.config.mjs` lines 8–15: both rule-disables carry their full
  rationale in place.

Test for any comment you write: *if the code is correct, does this comment tell
the reader something they could not infer from it?* If no, delete the comment.
And when you change a line, **read the comment above it** — the stale
`lib/redis.js` comment (ledger entry 3) exists because commit `6dd4351` didn't.

---

## 6. Skill-library maintenance (`.claude/skills/`)

Rules for writing or editing any skill in this repo:

- **Frontmatter contract** — YAML with `name:` (matching the directory name)
  and a trigger-rich `description:` that says exactly WHEN to load the skill
  (symptoms, verbs, situations), ideally ending "Not for ... (see <sibling>)."
  Keep it under ~500 characters.
- **Provenance and maintenance section required** — every skill ends with one:
  how it was derived, and one-line re-verification commands for every volatile
  fact it states. A skill without one cannot be trusted after its first drift.
- **One home per fact** — before stating a fact, ask which document owns it.
  If a sibling skill or README/FEATURES owns it, cross-reference
  (`see .claude/skills/<name>/SKILL.md`) instead of duplicating. Short
  restatements for readability are fine; authoritative tables live in exactly
  one place.
- **Skills must not contradict README/FEATURES** — except where the doc is
  provably stale. "Provably" means: cite the exact code line that contradicts
  it, state it explicitly as a staleness, and **add the entry to the drift
  ledger in this skill** (section 3) in the same commit.
- Date-stamp volatile facts ("as of 2026-07-18"); imperative voice; tables and
  checklists over prose; every command copy-pasteable from the repo root.
- Skills are maintainer-facing: don't restate the README's operator content —
  link to it.

---

## 7. When NOT to use this skill

- **Making the code change itself** (gating, review, non-negotiables, commit
  discipline) → `.claude/skills/change-control/SKILL.md`. This skill only
  governs the doc half of the same commit.
- **Looking up what an env var means or adding a config axis** →
  `.claude/skills/config-and-env/SKILL.md` (this skill only tells you *where*
  to document it).
- **Understanding the architecture or Redis data model** →
  `.claude/skills/architecture-contract/SKILL.md`.
- **Debugging a live problem** → `.claude/skills/debugging-playbook/SKILL.md`.
- **Writing tests or acceptance evidence** →
  `.claude/skills/validation-and-qa/SKILL.md`.

---

## Provenance and maintenance

Derived 2026-07-18 by reading `README.md` and `FEATURES.md` in full, verifying
every cited line number, code comment, and style example against the working
tree, and cross-checking the drift entries against `lib/redis.js`,
`lib/theme.js`, `public/sw.js`, `package.json`, `eslint.config.mjs`, and
`.github/workflows/ci.yml`. Commit references (`6dd4351` namespace rename,
`9e5b086` ESLint pin) come from the repo's 4-commit history.

Re-verify before relying on volatile facts:

```bash
# Drift ledger entries 1–3 still stale? (expect fable2 in code, pvp in docs/comment)
grep -n "fable2" lib/redis.js
grep -n "pvp" README.md FEATURES.md lib/redis.js
# Ledger entry 4 still stale? (expect eslint ^9 in package.json, "ESLint 10" in README)
grep -n '"eslint"' package.json
grep -n "ESLint 10" README.md
# Legitimate pvp survivors unchanged?
grep -n "pvp" lib/theme.js public/sw.js
# Style-example comments still present?
grep -n "Fails OPEN" lib/ratelimit.js
grep -n "stray newline" lib/bunny.js
grep -n "GET is public" pages/api/theme.js
# FEATURES version header
head -3 FEATURES.md
# CI dummy env block still exists?
grep -n "Dummy values" .github/workflows/ci.yml
```

If any grep result contradicts this skill, the code wins: update this skill
(and the ledger) in the same commit as whatever changed.
