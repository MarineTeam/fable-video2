// Group-scoped staff: the pure rules.
//
// PURE MODULE — no Redis import, so pages/admin.js may use it. Storage is
// lib/staffScopeStore.js; the route helpers that read Redis or bunny are
// lib/staffScope.js; resolution is lib/guard.js resolveActor().
//
// A person's ROLES decide what they may do. Their SCOPE decides where: a list
// of group ids. No scope (null) is the portal as before. A scope limits every
// capability to those groups, their members, and the videos those groups'
// scopes grant.
//
//   staffScope === null        unscoped — the whole portal
//   staffScope === [ids...]    only these groups
//   staffScope === []          scoped to NOTHING — never read as "unscoped"
//
// Every group here restricts (there is no unrestricted-label kind, unlike
// the sibling repos), so only whether a group still EXISTS matters: a deleted
// group contributes nothing.
//
// The four ways scoping could leak, and the rule that closes each:
//
//   1. Widening your own scope. A scope IS what its groups grant, so a scoped
//      person never edits a group's scope, collections, or the homepage order
//      (their own uploads are granted to their groups, the one exception).
//      GLOBAL_CAPABILITIES are stripped entirely.
//   2. The no-group hole. While gating is on, a viewer in no group is governed
//      by the "default access" setting, which is 'open' unless changed — the
//      whole library. So a scoped person approves new people only INTO one of
//      their groups (membership written before approval), and never removes
//      anyone's last group (leavesNoGroup).
//   3. People shared with other groups. Removing someone from the portal
//      affects every group they are in, so it needs all of them in scope
//      (mayRemovePerson). The same for deleting a video (mayDeleteVideo).
//   4. Handing out scope. roles.manage is global, so no scoped person can set
//      anyone's scope, their own included.
import { CAP, normalizeCapabilities } from './capabilities';

export const GLOBAL_CAPABILITIES = Object.freeze([
  CAP.SETTINGS_MANAGE,
  CAP.ROLES_MANAGE,
  CAP.AUDIT_READ,
  CAP.BROADCAST_SEND,
]);

export const MAX_SCOPE_GROUPS = 20;

const isId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);

// null for "unscoped", an array (possibly empty) otherwise.
export function normalizeScope(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v || '').trim()).filter(isId))].sort().slice(0, MAX_SCOPE_GROUPS);
}

export function isScoped(actor) {
  return Array.isArray(actor?.staffScope);
}

export function capabilitiesUnderScope(capabilities, scope) {
  const caps = normalizeCapabilities(capabilities);
  if (!Array.isArray(scope)) return caps;
  return caps.filter((cap) => !GLOBAL_CAPABILITIES.includes(cap));
}

// The groups of a scope that still exist.
export function effectiveScopeGroups(scope, groupsById) {
  if (!Array.isArray(scope)) return null;
  return scope.filter((id) => (groupsById || {})[id]);
}

// The content a scope reaches, in lib/groups.js's scope shape. Never
// `unrestricted`: an empty or dead scope reaches nothing.
export function contentOfScope(scope, groupsById) {
  const groups = (effectiveScopeGroups(scope, groupsById) || []).map((id) => groupsById[id]);
  const union = (key) => [...new Set(groups.flatMap((g) => g[key] || []))].sort();
  return { unrestricted: false, collectionIds: union('collectionIds'), videoIds: union('videoIds') };
}

export function groupInScope(actor, id, groupsById) {
  if (!isScoped(actor)) return true;
  return effectiveScopeGroups(actor.staffScope, groupsById).includes(id);
}

// Is this person (by the group ids they are in) one of the caller's people?
export function personInScope(actor, groupIds, groupsById) {
  if (!isScoped(actor)) return true;
  const mine = new Set(effectiveScopeGroups(actor.staffScope, groupsById));
  return (Array.isArray(groupIds) ? groupIds : []).some((id) => mine.has(id));
}

// Is this video (guid + collectionId) inside the caller's scope?
export function videoInScope(actor, video) {
  if (!isScoped(actor)) return true;
  const scope = actor.contentScope;
  if (!scope) return false;
  const guid = video?.guid || '';
  const collectionId = video?.collectionId || '';
  return Boolean(
    (guid && scope.videoIds.includes(guid)) || (collectionId && scope.collectionIds.includes(collectionId))
  );
}

// Rule 2.
export function leavesNoGroup(nextGroupIds, groupsById) {
  return !(Array.isArray(nextGroupIds) ? nextGroupIds : []).some((id) => (groupsById || {})[id]);
}

// A scoped caller may add or remove only their own groups on someone, and
// never leave them in none. Returns an error string, or null when allowed.
export function membershipChangeProblem(actor, before, after, groupsById) {
  if (!isScoped(actor)) return null;
  const mine = new Set(effectiveScopeGroups(actor.staffScope, groupsById));
  const outside = (ids) =>
    [...new Set((Array.isArray(ids) ? ids : []).filter((id) => !mine.has(id)))].sort().join('\n');
  if (outside(before) !== outside(after)) return 'You can only add or remove your own groups';
  if (leavesNoGroup(after, groupsById)) {
    return 'That would leave them in no group, which can show them the whole library. Remove them instead';
  }
  return null;
}

// Rule 3, for people.
export function mayRemovePerson(actor, groupIds, groupsById) {
  if (!isScoped(actor)) return true;
  const mine = new Set(effectiveScopeGroups(actor.staffScope, groupsById));
  const theirs = (Array.isArray(groupIds) ? groupIds : []).filter((id) => (groupsById || {})[id]);
  return theirs.length > 0 && theirs.every((id) => mine.has(id));
}

// Rule 3, for videos: in scope, and granted to no group outside it.
export function mayDeleteVideo(actor, video, groupsById) {
  if (!isScoped(actor)) return true;
  if (!videoInScope(actor, video)) return false;
  const mine = new Set(effectiveScopeGroups(actor.staffScope, groupsById));
  const guid = video?.guid || '';
  const coll = video?.collectionId || '';
  return !Object.values(groupsById || {}).some(
    (g) => !mine.has(g.id) && ((guid && g.videoIds.includes(guid)) || (coll && g.collectionIds.includes(coll)))
  );
}

// Per-group publish windows: a scoped caller sets only their own groups';
// every other group's window must come back exactly as stored.
export function scheduleGroupsProblem(actor, storedGroups, nextGroups, groupsById) {
  if (!isScoped(actor)) return null;
  const mine = new Set(effectiveScopeGroups(actor.staffScope, groupsById));
  const others = (groups) =>
    JSON.stringify(
      Object.entries(groups && typeof groups === 'object' ? groups : {})
        .filter(([id]) => !mine.has(id))
        .sort(([a], [b]) => a.localeCompare(b))
    );
  return others(storedGroups) === others(nextGroups) ? null : 'You can only set publish windows for your own groups';
}

// The group(s) a scoped caller's new viewer goes into: the ones they named if
// all are theirs, else their only group. null when that cannot be decided.
export function placementGroups(actor, requested, groupsById) {
  if (!isScoped(actor)) return undefined;
  const mine = effectiveScopeGroups(actor.staffScope, groupsById);
  const asked = (Array.isArray(requested) ? requested : []).map(String);
  if (asked.length) return asked.every((id) => mine.includes(id)) ? [...new Set(asked)].sort() : null;
  return mine.length === 1 ? [mine[0]] : null;
}
