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
