import { redis, k } from './redis';
import { normalizeEmail } from './auth';

// Groups: named sets of viewers that are ALSO able to scope what their members
// can see, unlike viewer tags (lib/viewerTags.js), which stay a pure label
// used for picking share recipients. Both exist on purpose — a tag is a
// throwaway note, a group is a managed object with an access consequence.
//
//   k('groups')        groupId -> { id, name, collectionIds[], videoIds[], ... }
//   k('user:groups')   email   -> [groupId, ...]
//
// Content gating is OFF unless GROUP_CONTENT_GATING=1, per the house
// inert-until-configured rule (change-control non-negotiable 3): with it unset
// this whole module is membership bookkeeping and no viewer's library changes.
// When it IS on, the rule is "groups RESTRICT, they do not grant":
//
//   * a viewer in no group is governed by the live `groupDefaultAccess`
//     setting — 'open' (the default, so flipping the env var does not blank
//     everyone's library) or 'closed';
//   * a viewer in one or more groups sees exactly the union of those groups'
//     collections and videos — a group scoped to nothing therefore grants
//     nothing, which is the honest reading of an empty scope;
//   * owners and role-holders (staff) bypass gating entirely.
//
// Deliberately NOT gated: /s/[id] and /b/[id]. A share link is an explicit
// per-recipient grant naming one video, issued to people who need not be
// approved viewers at all — filtering it by group membership would break the
// feature rather than tighten it.

export const MAX_GROUPS = 100;
export const MAX_GROUPS_PER_USER = 20;
export const MAX_GROUP_NAME_LENGTH = 60;
export const MAX_SCOPE_ENTRIES = 500;

export function groupGatingEnabled() {
  return process.env.GROUP_CONTENT_GATING === '1';
}

export function normalizeGroupName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_GROUP_NAME_LENGTH);
  return name || null;
}

export function groupIdFromName(name, rand = () => Math.random().toString(36).slice(2, 8)) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${slug || 'group'}-${rand()}`;
}

export function isValidGroupId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return [];
  const clean = list
    .filter((v) => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(clean)].slice(0, MAX_SCOPE_ENTRIES).sort();
}

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

function parseGroup(id, value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeGroupName(raw.name);
  if (!name) return null;
  return {
    id,
    name,
    collectionIds: normalizeIdList(raw.collectionIds),
    videoIds: normalizeIdList(raw.videoIds),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Pure decision logic — kept free of Redis so it is unit-testable, same split
// as lib/geo.js's resolveGeoAccess.
// ---------------------------------------------------------------------------

// `unrestricted: true` means "the full library", and every caller must treat
// it as the only way to see everything — there is no wildcard scope entry.
export function resolveContentScope({ gatingOn, staff, groups, defaultAccess }) {
  if (!gatingOn || staff) return { unrestricted: true, collectionIds: [], videoIds: [] };
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) {
    return defaultAccess === 'closed'
      ? { unrestricted: false, collectionIds: [], videoIds: [] }
      : { unrestricted: true, collectionIds: [], videoIds: [] };
  }
  const collectionIds = new Set();
  const videoIds = new Set();
  for (const group of list) {
    for (const id of group?.collectionIds || []) collectionIds.add(id);
    for (const id of group?.videoIds || []) videoIds.add(id);
  }
  return {
    unrestricted: false,
    collectionIds: [...collectionIds].sort(),
    videoIds: [...videoIds].sort(),
  };
}

// The scope a caller gets when membership cannot be read while gating is ON.
// Fails CLOSED: an authorization check must never be widened by an
// infrastructure error (architecture contract I9).
export const DENY_SCOPE = Object.freeze({
  unrestricted: false,
  collectionIds: [],
  videoIds: [],
});

export function isVideoVisible(scope, video) {
  if (!scope || scope.unrestricted) return true;
  const guid = video?.guid || '';
  const collectionId = video?.collectionId || '';
  // Boolean(), not the bare || chain: an empty guid/collectionId must yield
  // false, never the empty string, so this stays a real predicate.
  return Boolean(
    (guid && scope.videoIds.includes(guid)) ||
      (collectionId && scope.collectionIds.includes(collectionId))
  );
}

export function filterVideosByScope(videos, scope) {
  if (!scope || scope.unrestricted) return videos || [];
  return (videos || []).filter((v) => isVideoVisible(scope, v));
}

// A collection chip is shown only when the scope names that collection. A
// group that grants loose videoIds out of an ungranted collection therefore
// hides the chip while the videos themselves stay reachable — the chip is a
// filter over an already-filtered list, not an access decision of its own.
export function isCollectionVisible(scope, guid) {
  if (!scope || scope.unrestricted) return true;
  return Boolean(guid) && scope.collectionIds.includes(guid);
}

export function filterCollectionsByScope(collections, scope) {
  if (!scope || scope.unrestricted) return collections || [];
  return (collections || []).filter((c) => isCollectionVisible(scope, c?.guid));
}

// email -> group list, from a groupId->group map and an email->ids map.
export function groupsForMember(email, groupIds, groupsById) {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  return (groupIds || []).map((id) => (groupsById || {})[id]).filter(Boolean);
}

export function membersOfGroup(membershipByEmail, groupId) {
  return Object.entries(membershipByEmail || {})
    .filter(([, ids]) => ids.includes(groupId))
    .map(([email]) => email)
    .sort();
}

// ---------------------------------------------------------------------------
// Redis side
// ---------------------------------------------------------------------------

export async function loadGroups() {
  const raw = (await redis().hgetall(k('groups'))) || {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const group = parseGroup(id, value);
    if (group) out[id] = group;
  }
  return out;
}

export function sortedGroups(groupsById) {
  return Object.values(groupsById || {}).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadGroupMemberships() {
  const raw = (await redis().hgetall(k('user:groups'))) || {};
  const out = {};
  for (const [email, value] of Object.entries(raw)) {
    const ids = parseList(value);
    if (ids.length) out[email] = ids;
  }
  return out;
}

export async function groupIdsForEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return [];
  return parseList(await redis().hget(k('user:groups'), norm));
}

export async function saveGroup(group) {
  if (!isValidGroupId(group.id)) return { ok: false, error: 'Bad group id' };
  const name = normalizeGroupName(group.name);
  if (!name) return { ok: false, error: 'Bad group name' };
  const record = {
    id: group.id,
    name,
    collectionIds: normalizeIdList(group.collectionIds),
    videoIds: normalizeIdList(group.videoIds),
    createdAt: group.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await redis().hset(k('groups'), { [group.id]: record });
  return { ok: true, group: record };
}

// Mirrors deleteRole: the membership hash is swept too, so no email is left
// pointing at a group that no longer exists.
export async function deleteGroup(id) {
  const r = redis();
  await r.hdel(k('groups'), id);
  const memberships = await loadGroupMemberships().catch(() => ({}));
  await Promise.all(
    Object.entries(memberships)
      .filter(([, ids]) => ids.includes(id))
      .map(([email, ids]) => {
        const next = ids.filter((gid) => gid !== id);
        return next.length
          ? r.hset(k('user:groups'), { [email]: next })
          : r.hdel(k('user:groups'), email);
      })
  );
  return { ok: true };
}

export async function setGroupsForEmail(email, groupIds, groupsById) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: false, error: 'Bad email' };
  const next = [...new Set((Array.isArray(groupIds) ? groupIds : []).filter((id) => groupsById[id]))]
    .slice(0, MAX_GROUPS_PER_USER)
    .sort();
  if (next.length) await redis().hset(k('user:groups'), { [norm]: next });
  else await redis().hdel(k('user:groups'), norm);
  return { ok: true, groupIds: next };
}

// Sets a group's member list in one go, the per-group counterpart to
// setGroupsForEmail. Membership lives in the email->ids hash (one read serves
// both directions), so this diffs the current members and touches only the
// emails whose list actually changes.
export async function setMembersOfGroup(groupId, emails) {
  const r = redis();
  const wanted = new Set(
    (Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean)
  );
  const memberships = await loadGroupMemberships();
  const current = new Set(membersOfGroup(memberships, groupId));
  const writes = [];
  for (const email of wanted) {
    if (current.has(email)) continue;
    const next = [...new Set([...(memberships[email] || []), groupId])]
      .slice(0, MAX_GROUPS_PER_USER)
      .sort();
    writes.push(r.hset(k('user:groups'), { [email]: next }));
  }
  for (const email of current) {
    if (wanted.has(email)) continue;
    const next = (memberships[email] || []).filter((id) => id !== groupId);
    writes.push(
      next.length ? r.hset(k('user:groups'), { [email]: next }) : r.hdel(k('user:groups'), email)
    );
  }
  await Promise.all(writes);
  return { ok: true, members: [...wanted].sort() };
}

export async function clearGroupsForEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  try {
    await redis().hdel(k('user:groups'), norm);
  } catch {
    // best-effort, mirrors clearViewerTags
  }
}

// 'open' | 'closed' — what a viewer in NO group sees while gating is on.
// Live-editable from /admin so it never needs a redeploy, exactly like the geo
// enforcement toggles. Unreadable setting falls back to 'open', the
// non-destructive default; the gate itself still fails closed via DENY_SCOPE.
export async function groupDefaultAccess() {
  try {
    const raw = await redis().get(k('settings:groupDefaultAccess'));
    return String(raw) === 'closed' ? 'closed' : 'open';
  } catch {
    return 'open';
  }
}

// The one entry point the viewer paths call. `staff` is true for owners and
// anyone holding a capability — they administer the library, so gating it for
// them would be theatre.
export async function contentScopeFor(email, { staff } = {}) {
  if (!groupGatingEnabled() || staff) {
    return { unrestricted: true, collectionIds: [], videoIds: [] };
  }
  try {
    const [groupIds, groupsById, defaultAccess] = await Promise.all([
      groupIdsForEmail(email),
      loadGroups(),
      groupDefaultAccess(),
    ]);
    return resolveContentScope({
      gatingOn: true,
      staff: false,
      groups: groupsForMember(email, groupIds, groupsById),
      defaultAccess,
    });
  } catch {
    return DENY_SCOPE;
  }
}
