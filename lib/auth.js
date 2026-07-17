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

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}
