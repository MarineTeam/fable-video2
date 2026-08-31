// Centralized identity helpers. Access control everywhere in the app compares
// normalized email addresses, so normalization must be identical at every
// check site — always go through these helpers.

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

export function isAdmin(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return adminEmails().includes(normalized);
}

// Linear-time check (no backtracking regex) — deliberately not a single
// regex like /^[^\s@]+@[^\s@]+\.[^\s@]+$/, which CodeQL flags as a
// polynomial-time ReDoS risk on attacker-controlled input.
export function isValidEmail(email) {
  const s = String(email || '');
  if (!s || /\s/.test(s)) return false;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!local || !domain) return false;
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

// --- Email verification -----------------------------------------------------
//
// Every access decision in this app compares the session's email claim against
// an admin-managed list. Without this check, anyone able to obtain a session
// *claiming* an approved address gets that address's access — viewer, share
// recipient, or owner. The mitigation up to now lived entirely in tenant
// configuration (Auth0 sign-ups disabled), which is invisible to CI and can
// drift silently.
//
// Enforcement is opt-in via REQUIRE_EMAIL_VERIFIED=1 because nothing in this
// repo can prove a given Auth0 tenant actually emits the claim, and turning it
// on blind would lock out every user — including every owner — with no admin
// UI left to fix it. Confirm the claim is a real boolean on a preview
// deployment first (open /auth/profile while signed in), then set the var.
// The end state is on; off is a staging position, not a resting place.
export function emailVerificationEnforced() {
  return process.env.REQUIRE_EMAIL_VERIFIED === '1';
}

// The normalized email ONLY for sessions that are safe to trust; '' otherwise.
// Every caller already treats '' as not-signed-in, so the failure mode is deny
// — this is an access decision, and the project's fail-open idiom covers
// auxiliary features only.
//
// `email_verified !== true` is the deliberate shape: absent, false, undefined
// and the *string* "false" (or even the string "true") all deny. Only a real
// boolean true passes.
export function trustedEmail(user, enforced = emailVerificationEnforced()) {
  if (!user) return '';
  if (enforced && user.email_verified !== true) return '';
  return normalizeEmail(user.email);
}
