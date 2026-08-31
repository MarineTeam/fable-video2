import { redis, k } from './redis';
import { normalizeEmail } from './auth';
import {
  normalizeCapabilities,
  normalizeRoleName,
  effectiveCapabilities,
  isValidRoleId,
} from './capabilities';

// Redis side of the role system. Two hashes, mirroring the viewer:tags idiom
// (one hash keyed by the thing, one keyed by email) so both directions are a
// single round trip:
//
//   k('roles')       roleId -> { id, name, capabilities[], createdAt, updatedAt }
//   k('user:roles')  email  -> [roleId, ...]
//
// Neither is consulted for owners: ADMIN_EMAILS resolves to the full catalog
// without reading Redis at all, so no stored data — and no Redis outage — can
// demote the bootstrap admins (capabilities.js property 2).

export const MAX_ROLES = 50;
export const MAX_ROLES_PER_USER = 10;

// The Upstash client parses JSON on read, but a raw string left by another
// tool is handled defensively too — same shape of guard as viewerTags.js.
function parseList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseRole(id, value) {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeRoleName(raw.name);
  if (!name) return null;
  return {
    id,
    name,
    capabilities: normalizeCapabilities(raw.capabilities),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// roleId -> role, skipping records that no longer parse into a usable role.
export async function loadRoles() {
  const raw = (await redis().hgetall(k('roles'))) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const role = parseRole(id, value);
    if (role) out[id] = role;
  }
  return out;
}

export function sortedRoles(rolesById) {
  return Object.values(rolesById || {}).sort((a, b) => a.name.localeCompare(b.name));
}

// email -> [roleId, ...], for every user holding at least one role.
export async function loadRoleAssignments() {
  const raw = (await redis().hgetall(k('user:roles'))) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) {
    const ids = parseList(value);
    if (ids.length) out[email] = ids;
  }
  return out;
}

export async function rolesForEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  return parseList(await redis().hget(k('user:roles'), norm));
}

// The single resolution point used by the guards. Owners short-circuit before
// any Redis call; everyone else fails CLOSED to zero capabilities, because an
// authorization check must never be widened by an infrastructure error
// (architecture contract I9).
export async function resolveCapabilities(email, { owner } = {}) {
  if (owner) return effectiveCapabilities({ owner: true });
  const norm = normalizeEmail(email);
  if (!norm) return [];
  try {
    const [roleIds, rolesById] = await Promise.all([rolesForEmail(norm), loadRoles()]);
    return effectiveCapabilities({ owner: false, roleIds, rolesById });
  } catch {
    return [];
  }
}

export async function saveRole(role) {
  if (!isValidRoleId(role.id)) return { ok: false, error: 'Bad role id' };
  const name = normalizeRoleName(role.name);
  if (!name) return { ok: false, error: 'Bad role name' };
  const record = {
    id: role.id,
    name,
    capabilities: normalizeCapabilities(role.capabilities),
    createdAt: role.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis().hset(k('roles'), { [role.id]: record });
  return { ok: true, role: record };
}

// Deleting a role also strips it from everyone holding it, so a stale id can
// never linger in an assignment list and silently come back to life if some
// future record reuses the id.
export async function deleteRole(id) {
  const r = redis();
  await r.hdel(k('roles'), id);
  const assignments = await loadRoleAssignments().catch(() => ({}));
  await Promise.all(
    Object.entries(assignments)
      .filter(([, ids]) => ids.includes(id))
      .map(([email, ids]) => {
        const next = ids.filter((rid) => rid !== id);
        return next.length
          ? r.hset(k('user:roles'), { [email]: next })
          : r.hdel(k('user:roles'), email);
      })
  );
  return { ok: true };
}

// Replaces a user's whole role list. Ids with no live role record are dropped
// rather than stored, so the hash never accumulates references to nothing.
export async function setRolesForEmail(email, roleIds, rolesById) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, error: 'Bad email' };
  const next = [...new Set((Array.isArray(roleIds) ? roleIds : []).filter((id) => rolesById[id]))]
    .slice(0, MAX_ROLES_PER_USER)
    .sort();
  if (next.length) await redis().hset(k('user:roles'), { [norm]: next });
  else await redis().hdel(k('user:roles'), norm);
  return { ok: true, roleIds: next };
}

// Called when a viewer is removed outright, so no orphaned assignment
// survives — same contract as clearViewerTags.
export async function clearRolesForEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  try {
    await redis().hdel(k('user:roles'), norm);
  } catch {
    // best-effort, mirrors the lastseen/tags cleanup idiom
  }
}
