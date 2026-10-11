// Group-scoped staff: where a scope is stored.
//
//   k('user:scope')  email -> [groupId, ...]   (absent = unscoped)
//
// Kept apart from lib/staffScope.js so lib/groups.js and lib/guard.js can both
// read a scope without importing each other. Owners (ADMIN_EMAILS) are never
// scoped: every reader skips this hash for them, and /api/admin/roles refuses
// to write one.
//
// An EMPTY list is stored rather than deleted: absent means "the whole
// portal", so deleting the row when its last group went would widen the person
// to everything.
import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import { normalizeScope } from './staffScopeRules';

function parse(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  // Present but unreadable is scoped to nothing, never unscoped.
  return normalizeScope(Array.isArray(v) ? v : []);
}

// null (unscoped) or the stored group ids. THROWS on a Redis failure: every
// caller is an access decision and fails closed itself.
export async function scopeForEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const value = await redis().hget(k('user:scope'), e);
  return value === null || value === undefined ? null : parse(value);
}

export async function loadStaffScopes() {
  const raw = (await redis().hgetall(k('user:scope'))) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) out[normalizeEmail(email)] = parse(value);
  return out;
}

// null lifts the scope; an array stores it.
export async function setScopeForEmail(email, scope) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const next = normalizeScope(scope);
  if (next === null) await redis().hdel(k('user:scope'), e);
  else await redis().hset(k('user:scope'), { [e]: JSON.stringify(next) });
  return next;
}
